// Controlled fake OMP child for the ProviderDock integration harness.
//
// This is NOT the real oh-my-pi binary. It stands in for OMP so the harness can
// exercise the REAL OmpLaunchService / OmpProcessSupervisor / OmpRuntime spawn,
// lifecycle, and credential-injection boundary WITHOUT running the pinned binary
// (this host has no OS-level egress isolation; see docs/omp-migration). Every
// assertion made with this child is explicitly "not confirmed against real OMP".
//
// Contract it honours (verified against the pinned sources):
//   * RPC control frames: emits {type:"ready",protocolVersion:1}, answers
//     get_state with a projectOmpRpcControlFrame-valid state frame, exits on abort.
//   * Reads its upstream target from the compiled models.yml (next to --config) and
//     uses ONLY the env-injected PROVIDERDOCK_OMP_<hex> marker key — never argv,
//     never a hard-coded key. It never prints the key or Authorization value.
//   * Behaviour is driven by <cwd>/.fake-omp-control.json so one static file (one
//     stable hash) serves every scenario. Silent on stdout unless emitting a frame.

import { appendFileSync, readFileSync } from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { dirname, join } from "node:path";

function argValue(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
}

const argv = process.argv.slice(2);
const rpc = argValue(argv, "--mode") === "rpc";
const selector = argValue(argv, "--model") ?? "";
const configPath = argValue(argv, "--config") ?? "";
// Selector is "<ompProviderId>/<modelId>"; ompProviderId never contains "/".
const slash = selector.indexOf("/");
const ompProviderId = slash >= 0 ? selector.slice(0, slash) : selector;
const modelId = slash >= 0 ? selector.slice(slash + 1) : "";

let control = { scenario: "happy" };
try {
  control = JSON.parse(readFileSync(join(process.cwd(), ".fake-omp-control.json"), "utf8"));
} catch {
  // Absent control file => happy path.
}
const scenario = typeof control.scenario === "string" ? control.scenario : "happy";

let provider;
try {
  const models = JSON.parse(readFileSync(join(dirname(configPath), "models.yml"), "utf8"));
  provider = models?.providers?.[ompProviderId];
} catch {
  provider = undefined;
}
const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : undefined;
const api = provider?.api ?? provider?.models?.[0]?.api;
const keyEnvName = typeof provider?.apiKey === "string" ? provider.apiKey : undefined;
const key = keyEnvName ? process.env[keyEnvName] : undefined;

function upstreamEndpoint() {
  const trimmed = String(baseUrl).replace(/\/+$/, "");
  if (api === "openai-responses") return `${trimmed}/responses`;
  if (api === "anthropic-messages") return `${trimmed}/messages`;
  return `${trimmed}/chat/completions`;
}

function upstreamHeaders() {
  const headers = { "content-type": "application/json" };
  // The marker key is injected via env; send it exactly as OMP would, never log it.
  if (key) {
    if (provider?.authHeader === false) headers["x-api-key"] = key;
    else headers.authorization = `Bearer ${key}`;
  }
  return headers;
}

async function turn(kind, extra = {}) {
  const response = await fetch(upstreamEndpoint(), {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({ model: modelId, turn: kind, stream: false, ...extra }),
  });
  const body = await response.text().catch(() => "");
  return { status: response.status, body };
}

async function rawTurn(extra = {}) {
  // Does NOT swallow a body/stream error: used to model a broken SSE stream.
  const response = await fetch(upstreamEndpoint(), {
    method: "POST",
    headers: upstreamHeaders(),
    body: JSON.stringify({ model: modelId, stream: true, ...extra }),
  });
  const text = await response.text();
  return { status: response.status, text };
}

async function doWork() {
  switch (scenario) {
    case "http-status": {
      // Upstream returns a configured non-2xx. No retry, no fallback: fail once.
      const { status } = await turn("text", { forceStatus: control.forceStatus ?? 401 });
      return status >= 200 && status < 300 ? 0 : 1;
    }
    case "broken-sse": {
      // Loopback truncates the stream => rawTurn rejects; the run fails once. The
      // exit code REFLECTS the stream outcome: 1 only when the read actually threw.
      // If the stream ever completes cleanly (a regression that stopped truncating),
      // return 0 so the run would be SUCCEEDED and the harness's `expect FAILED`
      // BREAKS, instead of a broken stream being masked by an unconditional exit 1.
      try {
        await rawTurn({ forceBrokenSse: true });
        return 0;
      } catch {
        return 1;
      }
    }
    case "tool-side-effect-then-error": {
      // A real tool call would perform its side effect EXACTLY once before the
      // turn errors. The harness asserts there is no SECOND side effect, i.e. no
      // silent retry/fallback after a side-effecting tool.
      if (typeof control.sideEffectFile === "string") {
        try {
          appendFileSync(control.sideEffectFile, "side-effect\n");
        } catch {
          // ignore
        }
      }
      await turn("tool").catch(() => ({}));
      return 1;
    }
    case "exit-nonzero":
      return typeof control.exitCode === "number" ? control.exitCode : 7;
    default: {
      // happy: one text turn + one read-only tool turn.
      await turn("text");
      let readMarker = "none";
      if (typeof control.readFixture === "string") {
        try {
          readMarker = createHash("sha256")
            .update(readFileSync(control.readFixture))
            .digest("hex")
            .slice(0, 16);
        } catch {
          readMarker = "read-error";
        }
      }
      await turn("tool", { readMarker });
      return 0;
    }
  }
}

function emit(frame) {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

if (rpc) {
  if (scenario === "early-exit") {
    // Child dies before RPC readiness: supervisor never reaches READY => FAILED.
    process.exit(typeof control.exitCode === "number" ? control.exitCode : 1);
  }
  emit({ type: "ready", protocolVersion: 1 });
  let buffer = "";
  let stateSent = false;
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.type === "get_state" && !stateSent) {
        stateSent = true;
        emit({
          type: "response",
          id: message.id,
          command: "get_state",
          success: true,
          data: {
            model: { id: modelId, provider: ompProviderId },
            sessionId: randomUUID(),
            isStreaming: false,
          },
        });
        if (scenario !== "wait-for-cancel") {
          doWork().then(
            (code) => process.exit(code),
            () => process.exit(1),
          );
        }
      } else if (message.type === "abort") {
        emit({ type: "response", id: message.id, command: "abort", success: true });
        process.exit(0);
      }
    }
  });
  process.stdin.on("end", () => process.exit(0));
  setInterval(() => {}, 1 << 30);
} else {
  // tui: never write RPC frames to the inherited stdout.
  if (scenario === "early-exit") {
    process.exit(typeof control.exitCode === "number" ? control.exitCode : 1);
  }
  if (scenario === "wait-for-cancel") {
    setInterval(() => {}, 1 << 30);
  } else {
    doWork().then(
      (code) => process.exit(code),
      () => process.exit(1),
    );
  }
}
