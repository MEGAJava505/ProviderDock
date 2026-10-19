// Single integrated OMP lifecycle harness (M2.1 / M2.2 / M2.3).
//
// Drives the REAL OmpLaunchService + OmpProcessSupervisor + OmpRuntime from route
// selection through a real OS child process, termination, and cross-restart state
// recovery — over BOTH surfaces (CLI `providerdock launch omp` and the dashboard
// preview -> preflight -> launch -> runs/cancel HTTP API) plus a direct RPC start.
//
// The child is tests/support/omp-fake-child.mjs, a CONTROLLED FAKE standing in for
// oh-my-pi. Real omp.exe execution is BLOCKED in this environment: this host has no
// OS-level egress isolation, and OMP flags alone are explicitly insufficient (see
// docs/omp-migration + memory omp-m2-base-egress). Every acceptance here is therefore
// "not confirmed against the real OMP binary"; nothing below is an OS/network sandbox.
//
// No live user data, keys, homes or transcripts: loopback only (127.0.0.1), a fixture
// marker credential via MemorySecretStore, isolated temp home + project dir. The SAME
// production route-acceptance path runs with NO test-only bypass (the fixture supplies
// the fake child's real sha256, the pinned sourceCommit and the real credential fp).
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { providerSecretRevisionFingerprint } from "../src/core/security/secret-revision.js";
import { OmpRuntime } from "../src/clients/omp/omp-runtime.js";
import {
  OmpProcessSupervisor,
  type OmpSupervisorChild,
  type OmpSupervisorSpawn,
} from "../src/clients/omp/omp-process-supervisor.js";
import { FileOmpRunRepository, type OmpRunRecord, type OmpRunRepository, type OmpRunState } from "../src/clients/omp/omp-run-repository.js";
import { ompConfigSchemaCommit } from "../src/clients/omp/omp-config-compiler.js";
import { OmpLaunchService, type OmpLaunchInput } from "../src/application/omp-launch-service.js";
import { MemoryOmpRouteDecisionSource, fingerprintOmpProviderProfile } from "../src/migration/omp-route-decisions.js";
import { MemoryOmpProviderLocalSmokeEvidenceSource } from "../src/migration/omp-provider-evidence.js";
import { ProviderDashboardServer, type ProviderDashboardApplication } from "../src/ui/provider-dashboard-server.js";
import { runProviderDockCli } from "../src/cli/provider-dock-cli.js";
import type { ProviderDockApplication } from "../src/application/provider-dock-application.js";
import { makeOmpRouteFixture } from "./support/omp-route-fixtures.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

const FAKE_CHILD = fileURLToPath(new URL("./support/omp-fake-child.mjs", import.meta.url));

// Clean ASCII, trimmed, not "N/A", no "sk-ant-oat": passes the child-env marker guard.
const MARKER = "loopback-fixture-marker-7f3a9c2b4d1e";

// Ambient decoys that resolveOmpChildEnvironment MUST drop. NODE_OPTIONS is the strong
// canary: if it leaked to the child, `node` would try to --require a missing module and
// die before doing any work, so a SUCCEEDED happy run also proves the drop.
const DECOYS: Readonly<Record<string, string>> = {
  OPENAI_API_KEY: "decoy-openai-key-must-be-dropped",
  ANTHROPIC_API_KEY: "decoy-anthropic-key-must-be-dropped",
  HTTPS_PROXY: "http://decoy-proxy.invalid:9",
  HTTP_PROXY: "http://decoy-proxy.invalid:9",
  NODE_OPTIONS: "--require=./__provider_dock_decoy_must_be_dropped__.cjs",
  CODEX_HOME: "C:\\decoy\\codex-home",
};

const TERMINAL: ReadonlySet<OmpRunState> =
  new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly authorization: string | undefined;
  readonly apiKeyHeader: string | undefined;
  readonly turn: string | undefined;
  readonly readMarker: string | undefined;
  // Whether this request cleared the strict upstream contract gate below. A request
  // that violated it carries the generic `rejection` reason (never the marker/auth).
  readonly accepted: boolean;
  readonly rejection?: string;
}

interface Stack {
  readonly root: string;
  readonly projectDir: string;
  readonly runsDir: string;
  readonly runs: FileOmpRunRepository;
  readonly runtime: OmpRuntime;
  readonly supervisor: OmpProcessSupervisor;
  readonly service: OmpLaunchService;
  readonly fx: ReturnType<typeof makeOmpRouteFixture>;
  readonly input: OmpLaunchInput;
  readonly requests: RecordedRequest[];
  readonly pids: number[];
  readonly children: ChildProcess[];
  readonly secrets: MemorySecretStore;
  newSupervisor(): { supervisor: OmpProcessSupervisor; runs: FileOmpRunRepository };
}

const stacks: Stack[] = [];
const servers: ProviderDashboardServer[] = [];
const loopbacks: Server[] = [];

async function listenWithDeadline(
  server: EventEmitter,
  start: () => void,
  label: string,
  timeoutMs = 1_000,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      server.off("listening", onListening);
      server.off("error", onError);
    };
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve();
    };
    const onListening = () => settle();
    const onError = (error: NodeJS.ErrnoException) => settle(
      new Error(`${label} failed: ${error.code ?? error.message}`),
    );
    server.once("listening", onListening);
    server.once("error", onError);
    timer = setTimeout(() => settle(new Error(`${label} deadline exceeded`)), timeoutMs);
    try { start(); } catch (error) { settle(error instanceof Error ? error : new Error(String(error))); }
  });
}

async function closeListeningServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe("bounded loopback startup", () => {
  it("rejects bind refusal and a startup with neither callback nor error", async () => {
    const occupied = createServer();
    const refused = createServer();
    await listenWithDeadline(occupied, () => { occupied.listen(0, "127.0.0.1"); }, "occupied startup");
    const port = (occupied.address() as AddressInfo).port;
    try {
      await expect(listenWithDeadline(refused, () => { refused.listen(port, "127.0.0.1"); }, "refused startup", 250))
        .rejects.toThrow("refused startup failed: EADDRINUSE");
      expect(refused.listenerCount("error")).toBe(0);

      const hanging = new EventEmitter();
      await expect(listenWithDeadline(hanging, () => undefined, "hanging startup", 25))
        .rejects.toThrow("hanging startup deadline exceeded");
      expect(hanging.listenerCount("listening")).toBe(0);
      expect(hanging.listenerCount("error")).toBe(0);
    } finally {
      await closeListeningServer(refused);
      await closeListeningServer(occupied);
    }
  });
});

// The exact pinned wire contract the compiled route produces (see omp-config-compiler:
// apiMapping openai-chat-completions -> openai-completions => /v1/chat/completions, bearer
// => Authorization: Bearer <marker>, selector model id "exact-model"). The loopback is a
// STRICT gate on exactly five dimensions — POST, the exact request pathname, a JSON
// media-type essence, the model id, and the marker bearer — not a permissive mock: a
// request that fails any one is rejected 4xx, so the happy-path method/path/model/
// marker-auth assertions are load-bearing. Other body fields (turn, stream, readMarker,
// forceStatus, forceBrokenSse) are RECORDED for scenario assertions but are deliberately
// NOT gated here; this file claims only the five dimensions above are validated.
const EXPECTED_MODEL = "exact-model";
// Compared by exact pathname equality — NOT a prefix+suffix match, which admitted a nested
// "/v1/unexpected/chat/completions". baseUrl is ".../v1" and the apiMapping appends
// "/chat/completions", so this is the only path the compiled route ever addresses.
const EXPECTED_PATH = "/v1/chat/completions";
// req.url is always an origin-relative target; only its pathname is compared, so any
// syntactically valid absolute base works purely to let `new URL` resolve the path.
const REQUEST_PATH_BASE = "http://loopback.invalid";

// Returns a generic violation reason, or undefined when the request satisfies the
// contract. The reason is a fixed enum token: it deliberately never includes the marker,
// the expected token, or the received Authorization value, so a rejection cannot leak the
// credential back to a caller that guessed wrong.
function contractRejection(
  method: string,
  url: string,
  contentType: string,
  authorization: string | undefined,
  body: Record<string, unknown>,
): string | undefined {
  if (method !== "POST") return "method";
  // Exact pathname, not prefix+suffix: "/v1/unexpected/chat/completions" or any other
  // nested target is a "path" violation. A query/hash (never sent by the child) is ignored
  // by comparing pathname only; a malformed target that cannot resolve is also rejected.
  let pathname: string;
  try { pathname = new URL(url, REQUEST_PATH_BASE).pathname; }
  catch { return "path"; }
  if (pathname !== EXPECTED_PATH) return "path";
  // Media-type ESSENCE only: strip parameters, trim, lowercase. "application/json-patch+json",
  // "application/jsonish" and a bare "text/json" are all "protocol" violations; only
  // "application/json" (optionally with parameters, e.g. "; charset=utf-8") is admitted.
  if (contentType.split(";")[0]!.trim().toLowerCase() !== "application/json") return "protocol";
  if (typeof body.model !== "string" || body.model !== EXPECTED_MODEL) return "model";
  if (authorization !== `Bearer ${MARKER}`) return "auth";
  return undefined;
}

async function startLoopback(requests: RecordedRequest[]): Promise<{ server: Server; port: number }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      } catch {
        body = {};
      }
      const method = req.method ?? "";
      const url = req.url ?? "";
      const authorization = req.headers.authorization;
      const contentType = typeof req.headers["content-type"] === "string" ? req.headers["content-type"] : "";
      const rejection = contractRejection(method, url, contentType, authorization, body);
      requests.push({
        method,
        path: url,
        authorization,
        apiKeyHeader: typeof req.headers["x-api-key"] === "string" ? req.headers["x-api-key"] : undefined,
        turn: typeof body.turn === "string" ? body.turn : undefined,
        readMarker: typeof body.readMarker === "string" ? body.readMarker : undefined,
        accepted: rejection === undefined,
        ...(rejection === undefined ? {} : { rejection }),
      });
      if (rejection !== undefined) {
        // Generic status + reason ONLY. Never echo the marker, the expected token, or the
        // received Authorization value: a wrong-auth probe must not learn the credential.
        const status = rejection === "auth" ? 401 : rejection === "path" ? 404 : rejection === "method" ? 405 : 400;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "CONTRACT_REJECTED", reason: rejection } }));
        return;
      }
      // Contract satisfied: only now may a scenario force a status or a broken stream.
      if (typeof body.forceStatus === "number") {
        res.writeHead(body.forceStatus, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "forced-status" } }));
        return;
      }
      if (body.forceBrokenSse === true) {
        // Promise more bytes than we send, then sever the socket: undici rejects the
        // body read mid-stream, modelling a truncated SSE with no silent completion.
        res.writeHead(200, { "content-type": "text/event-stream", "content-length": "4096" });
        res.write("data: {\"partial\":true,");
        res.socket?.destroy();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ id: "cmpl-fixture", choices: [{ message: { role: "assistant", content: "ok" } }] }));
    });
  });
  try {
    await listenWithDeadline(server, () => { server.listen(0, "127.0.0.1"); }, "loopback startup");
  } catch (error) {
    await closeListeningServer(server).catch(() => undefined);
    throw error;
  }
  loopbacks.push(server);
  return { server, port: (server.address() as AddressInfo).port };
}

// The run store is fail-closed: a read that races a supervisor's atomic record rename
// throws OMP_RUN_CHANGED rather than return a torn record. That guard is correct and is
// left untouched — but an OBSERVER polling for a state transition (as any external caller
// of getRun would) must simply re-read on the next tick. Only this one transient storage
// race is tolerated; every other error still propagates so real defects surface.
function isTransientRunRead(error: unknown): boolean {
  return error instanceof Error && error.name === "OmpRunStorageError" && error.message === "OMP_RUN_CHANGED";
}

async function waitFor(
  get: (id: string) => Promise<OmpRunRecord | undefined>,
  runId: string,
  predicate: (state: OmpRunState) => boolean,
  label: string,
  timeoutMs = 25_000,
): Promise<OmpRunRecord> {
  const deadline = Date.now() + timeoutMs;
  let last: OmpRunState | "missing" = "missing";
  for (;;) {
    try {
      const record = await get(runId);
      if (record !== undefined) {
        last = record.state;
        if (predicate(record.state)) return record;
      }
    } catch (error) {
      if (!isTransientRunRead(error)) throw error;
      // A concurrent-write race, not a failure: fall through and re-poll.
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} never reached ${label} (last=${last})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const waitForTerminal = (get: (id: string) => Promise<OmpRunRecord | undefined>, runId: string, ms?: number) =>
  waitFor(get, runId, (state) => TERMINAL.has(state), "a terminal state", ms);
const waitForOpen = (get: (id: string) => Promise<OmpRunRecord | undefined>, runId: string, ms?: number) =>
  waitFor(get, runId, (state) => state === "RUNNING" || state === "TERMINAL_OPEN", "a live open state", ms);

async function buildStack(
  overrides: {
    spawn?: OmpSupervisorSpawn;
    cancelGraceMs?: number;
    // Wraps the repository the SUPERVISOR sees; stack.runs stays the inner store so
    // test reads never touch the wrapper. Used to model the publish->register window.
    wrapRuns?: (inner: OmpRunRepository) => OmpRunRepository;
  } = {},
): Promise<Stack> {
  const requests: RecordedRequest[] = [];
  const { port } = await startLoopback(requests);
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  const origin = `http://127.0.0.1:${port}`;

  const secrets = new MemorySecretStore({ "gateway.key": MARKER });
  // baseUrl-independent: depends only on auth.secretRef + secretHeaders + store revision.
  const fp = await providerSecretRevisionFingerprint(
    { auth: { kind: "bearer", secretRef: "gateway.key" }, secretHeaders: {} },
    secrets,
  );
  if (fp === undefined) throw new Error("fixture credential fingerprint could not be computed");
  const fakeSha = createHash("sha256").update(await readFile(FAKE_CHILD)).digest("hex");
  const fx = makeOmpRouteFixture({
    baseUrl, origin, executableSha256: fakeSha,
    sourceCommit: ompConfigSchemaCommit, credentialFingerprint: fp,
  });

  const root = await mkdtemp(join(tmpdir(), "dock-omp-harness-"));
  const projectDir = join(root, "провайдер dock проект"); // internal spaces + cyrillic
  await mkdir(projectDir, { recursive: true });
  const runsDir = join(root, "runrepo");

  const pids: number[] = [];
  const children: ChildProcess[] = [];
  const spawnSeam = (command: string, args: readonly string[], options: SpawnOptions): ChildProcess => {
    // Same structural seam as defaultSpawn, but runs the .mjs fake child under Node.
    const child = spawn(process.execPath, [command, ...args], options);
    if (typeof child.pid === "number") pids.push(child.pid);
    children.push(child);
    return child;
  };

  // Explicit ambient env: allowlisted host vars the child legitimately needs, plus
  // decoys that must never reach it. undefined -> clones to {} and inherits nothing.
  const ambientEnvironment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, PATHEXT: process.env.PATHEXT, SYSTEMROOT: process.env.SYSTEMROOT,
    WINDIR: process.env.WINDIR, COMSPEC: process.env.COMSPEC,
    TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR,
    ...DECOYS,
  };
  const makeRuntime = (): OmpRuntime => new OmpRuntime({
    rootDirectory: join(root, "managed"),
    artifact: { executable: FAKE_CHILD, sha256: fakeSha, sourceCommit: ompConfigSchemaCommit },
    secretStore: secrets,
    currentProfileFingerprint: async () => fingerprintOmpProviderProfile(fx.profile),
    ambientEnvironment,
  });
  const runtime = makeRuntime();
  const runs = new FileOmpRunRepository(runsDir);
  const supervisorRuns = overrides.wrapRuns ? overrides.wrapRuns(runs) : runs;
  const supervisor = new OmpProcessSupervisor({
    runtime, runs: supervisorRuns, spawn: overrides.spawn ?? spawnSeam,
    initializationTimeoutMs: 15_000, cancelGraceMs: overrides.cancelGraceMs ?? 6_000,
  });
  const service = new OmpLaunchService({
    application: { listProviders: async () => [fx.profile] },
    runtime, supervisor,
    routeDecisions: new MemoryOmpRouteDecisionSource([fx.decision]),
    evidence: new MemoryOmpProviderLocalSmokeEvidenceSource(fx.evidence),
    healthRecords: {
      get: async () => ({
        providerId: fx.profile.id, diagnostics: [fx.doctorSnapshot],
        history: [], runtimeSignals: [], surfaceChecks: [],
      }),
    },
    credentialFingerprint: (profile) => providerSecretRevisionFingerprint(profile, secrets),
    artifact: { sha256: fakeSha, sourceCommit: ompConfigSchemaCommit },
  });
  const input: OmpLaunchInput = {
    providerId: "gateway", modelId: "exact-model", accountId: "confirmed-account",
    projectDirectory: projectDir, permissionAcknowledgement: "read-only-pilot-no-sandbox",
  };
  const stack: Stack = {
    root, projectDir, runsDir, runs, runtime, supervisor, service, fx, input,
    requests, pids, children, secrets,
    newSupervisor() {
      // A distinct supervisor + repo over the SAME on-disk runsDir: models a process
      // restart that inherits prior run records but owns none of the live children.
      const restartRuns = new FileOmpRunRepository(runsDir);
      return {
        runs: restartRuns,
        supervisor: new OmpProcessSupervisor({
          runtime: makeRuntime(), runs: restartRuns, spawn: spawnSeam,
          initializationTimeoutMs: 15_000, cancelGraceMs: 6_000,
        }),
      };
    },
  };
  stacks.push(stack);
  return stack;
}

async function makeControl(projectDir: string, control: Record<string, unknown>): Promise<void> {
  // One static fake child (one stable hash) whose behaviour is driven by this file.
  await writeFile(join(projectDir, ".fake-omp-control.json"), JSON.stringify(control), "utf8");
}

async function post(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, text: await response.text() };
}

async function getJson(url: string): Promise<{ status: number; text: string }> {
  const response = await fetch(url);
  return { status: response.status, text: await response.text() };
}

// One guard over every user-facing surface (CLI stdout/stderr, HTTP bodies, serialized
// run records): the marker credential, any decoy VALUE, an Authorization header, or a
// raw RPC control-frame shape must never appear. The marker never leaking is the core
// invariant; the header/frame needles guard the child<->loopback and RPC boundaries.
function assertNoLeak(label: string, ...blobs: Array<string | undefined>): void {
  const haystack = blobs.filter((value): value is string => typeof value === "string").join("\n");
  const forbidden: Array<readonly [string, string]> = [
    ["marker credential value", MARKER],
    ["Authorization header", "Authorization"],
    ["raw rpc get_state frame", "get_state"],
    ["raw rpc ready frame", "protocolVersion"],
    ...Object.entries(DECOYS).map(([name, value]) => [`decoy ${name}`, value] as const),
  ];
  for (const [name, needle] of forbidden) {
    expect(haystack.includes(needle), `${label} must not leak ${name}`).toBe(false);
  }
}

const dashInput = (stack: Stack) => ({
  providerId: "gateway", modelId: "exact-model", accountId: "confirmed-account",
  projectDirectory: stack.projectDir, permissionAcknowledgement: "read-only-pilot-no-sandbox",
});

function dashboardApplication(): ProviderDashboardApplication {
  // Minimal stand-in: the OMP endpoints only touch the injected ompLauncher, and the
  // health monitor is disabled (healthMonitorIntervalMs:0), so nothing here is called.
  return {
    listProviders: async () => [],
    launchCodex: async () => ({ exitCode: 0, signal: null }),
    launchClaude: async () => ({ exitCode: 0, signal: null }),
    launchProviderAutomatic: async () => ({ client: "codex", exit: { exitCode: 0, signal: null } }),
  } as unknown as ProviderDashboardApplication;
}
async function launchViaCli(stack: Stack): Promise<{ runId: string; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runProviderDockCli(
    ["launch", "omp",
      "--provider", "gateway", "--model", "exact-model",
      "--omp-account", "confirmed-account", "--project", stack.projectDir,
      "--omp-read-only-pilot-no-sandbox"],
    {
      application: {} as unknown as ProviderDockApplication,
      io: { stdout: (message: string) => out.push(message), stderr: (message: string) => err.push(message) },
      ompLauncher: stack.service,
    },
  );
  const stdout = out.join("\n");
  const stderr = err.join("\n");
  if (code !== 0) throw new Error(`CLI launch exited ${code}: ${stderr}`);
  const match = /OMP run started: ([0-9a-f-]{36})/.exec(stdout);
  if (match === null) throw new Error(`no runId in CLI output: ${stdout}`);
  return { runId: match[1]!, stdout, stderr };
}

// selection() hardcodes mode "tui"; overriding it is the ONLY supported way to reach
// the direct RPC lifecycle. Re-runs the real preflight so the started selection is the
// exact verified route (no unverified route can slip through supervisor.start).
async function routeStart(stack: Stack, mode: "tui" | "rpc"): Promise<{ ok: true; runId: string }> {
  const selection = await stack.service.selection(stack.input);
  if (!("route" in selection)) throw new Error(`no route: ${JSON.stringify(selection.diagnostic)}`);
  const preflight = await stack.runtime.preflight(selection);
  if (!preflight.ok) throw new Error(`preflight failed: ${JSON.stringify(preflight.diagnostic)}`);
  const started = await stack.supervisor.start({ ...selection, mode });
  if (!started.ok) throw new Error(`start failed: ${JSON.stringify(started.diagnostic)}`);
  return started;
}

afterEach(async () => {
  for (const stack of stacks.splice(0)) {
    try {
      for (const run of await stack.supervisor.listRuns()) {
        if (!TERMINAL.has(run.state)) await stack.supervisor.cancel(run.runId).catch(() => undefined);
      }
    } catch { /* best effort */ }
    for (const child of stack.children.splice(0)) {
      try { child.kill("SIGKILL"); } catch { /* already exited */ }
    }
    await rm(stack.root, { recursive: true, force: true }).catch(() => undefined);
  }
  for (const server of servers.splice(0)) await server.stop().catch(() => undefined);
  for (const loopback of loopbacks.splice(0)) {
    await new Promise<void>((resolve) => loopback.close(() => resolve()));
  }
});
// M2.1 — one managed OMP run from route selection through a REAL OS child, over both
// surfaces (CLI + dashboard) plus a direct RPC start. The child is the controlled fake;
// the real omp.exe path is BLOCKED (no OS egress isolation here — see the header).
describe("M2.1 managed OMP lifecycle (fake child; real omp.exe BLOCKED)", () => {
  it("CLI launch omp drives a managed tui run to SUCCEEDED with only the fixture marker", async () => {
    const stack = await buildStack();
    // A read-only tool turn must actually READ a project fixture file: the child hashes
    // it and reports the first 16 hex of its sha256 as readMarker, which we recompute.
    const readFixture = join(stack.projectDir, "read-fixture.txt");
    const readPayload = "provider-dock-read-fixture-payload";
    await writeFile(readFixture, readPayload, "utf8");
    const expectedReadMarker = createHash("sha256").update(readPayload).digest("hex").slice(0, 16);
    await makeControl(stack.projectDir, { scenario: "happy", readFixture });

    const { runId, stdout, stderr } = await launchViaCli(stack);
    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("SUCCEEDED");

    // Real OS child: a positive pid was captured through the spawn seam, and the run
    // record surfaces that same pid (merged at TERMINAL_OPEN, persisted to terminal).
    expect(stack.pids.length).toBeGreaterThan(0);
    expect(stack.pids[0]!).toBeGreaterThan(0);
    expect(typeof record.pid).toBe("number");
    expect(record.pid!).toBeGreaterThan(0);
    expect(stack.pids).toContain(record.pid);

    // Upstream loopback saw >=1 text turn + 1 read-only tool turn, marker auth only.
    const turns = stack.requests.map((request) => request.turn);
    expect(turns).toContain("text");
    expect(turns).toContain("tool");
    expect(stack.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of stack.requests) {
      expect(request.authorization).toBe(`Bearer ${MARKER}`);
      expect(request.apiKeyHeader).toBeUndefined();
    }
    // Every upstream request cleared the strict contract gate; the marker-auth / method /
    // model assertions are only meaningful because a non-conforming request is rejected.
    expect(stack.requests.every((request) => request.accepted)).toBe(true);

    // The tool turn proves OMP actually READ the fixture: its reported marker equals the
    // sha256 prefix of the exact bytes we wrote — not the "none"/"read-error" sentinels.
    const toolRequest = stack.requests.find((request) => request.turn === "tool");
    expect(toolRequest?.readMarker).toBe(expectedReadMarker);

    assertNoLeak("CLI happy run", stdout, stderr, JSON.stringify(record));
  }, 40_000);
  it("dashboard preview -> preflight -> launch -> runs drives a managed tui run to SUCCEEDED", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "happy" });
    const server = new ProviderDashboardServer({
      application: dashboardApplication(),
      ompLauncher: stack.service,
      sessionToken: "a".repeat(48),
      healthMonitorIntervalMs: 0,
    });
    servers.push(server);
    const { url } = await server.start();

    const preview = await post(`${url}api/omp/preview`,
      { providerId: "gateway", modelId: "exact-model", accountId: "confirmed-account" });
    expect(preview.status).toBe(200);

    const preflight = await post(`${url}api/omp/preflight`, dashInput(stack));
    expect(preflight.status).toBe(200);
    expect((JSON.parse(preflight.text) as { result: { ok: boolean } }).result.ok).toBe(true);

    const launch = await post(`${url}api/omp/launch`, dashInput(stack));
    expect(launch.status).toBe(202);
    const runId = (JSON.parse(launch.text) as { result: { ok: boolean; runId: string } }).result.runId;

    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("SUCCEEDED");

    const runs = await getJson(`${url}api/omp/runs`);
    expect(runs.status).toBe(200);
    const listed = (JSON.parse(runs.text) as { runs: Array<{ runId: string; state: string }> }).runs;
    expect(listed.find((run) => run.runId === runId)?.state).toBe("SUCCEEDED");

    assertNoLeak("dashboard happy run", preview.text, preflight.text, launch.text, runs.text);
  }, 40_000);

  it("direct supervisor.start in rpc mode reaches a live open state then SUCCEEDED", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "happy" });

    const started = await routeStart(stack, "rpc");
    await waitForOpen((id) => stack.supervisor.getRun(id), started.runId);
    const record = await waitForTerminal((id) => stack.supervisor.getRun(id), started.runId);
    expect(record.state).toBe("SUCCEEDED");

    expect(stack.requests.map((request) => request.turn)).toContain("text");
    for (const request of stack.requests) {
      expect(request.authorization).toBe(`Bearer ${MARKER}`);
      expect(request.apiKeyHeader).toBeUndefined();
    }
    assertNoLeak("rpc happy run", JSON.stringify(record));
  }, 40_000);
});

// M2.2 — the failure matrix on the SAME managed path. Each row asserts a single
// terminal FAILED/CANCELLED (never a fabricated SUCCEEDED) and, crucially, NO silent
// retry or fallback: the upstream request count is pinned to what one attempt makes.
describe("M2.2 failure matrix (fake child; not confirmed against real OMP)", () => {
  it("row1: upstream 401/403 fails the run once with no retry or fallback", async () => {
    for (const status of [401, 403]) {
      const stack = await buildStack();
      await makeControl(stack.projectDir, { scenario: "http-status", forceStatus: status });
      const { runId } = await launchViaCli(stack);
      const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
      expect(record.state, `status ${status}`).toBe("FAILED");
      // VERIFIED here: the fake child issued EXACTLY ONE upstream attempt — no retry, no
      // fan-out, no key rotation. NOT verified: that the real omp.exe wouldn't retry or
      // switch keys on a 401 (that needs the pinned binary under egress isolation, BLOCKED
      // here). We assert only the boundary this fake child actually exercises.
      const attempts = stack.requests.filter((request) => request.turn === "text");
      expect(attempts.length).toBe(1);
      // The single attempt DID clear the strict gate with exactly the marker bearer, so
      // ProviderDock injected the right credential and the loopback (not a permissive mock)
      // chose to answer 4xx — the failure is upstream, not a malformed request.
      expect(attempts[0]?.accepted).toBe(true);
      expect(attempts[0]?.authorization).toBe(`Bearer ${MARKER}`);
      // The rejection surfaces as a GENERIC process-exit failure. We deliberately do NOT
      // invent an auth-specific diagnostic from the child's exit code.
      expect(record.diagnostic?.code, `status ${status}`).toBe("PROCESS_EXIT_NONZERO");
      assertNoLeak(`row1 ${status}`, JSON.stringify(record));
    }
  }, 40_000);

  it("row2: upstream 429 and 5xx fail the run once with no retry or fallback", async () => {
    for (const status of [429, 503]) {
      const stack = await buildStack();
      await makeControl(stack.projectDir, { scenario: "http-status", forceStatus: status });
      const { runId } = await launchViaCli(stack);
      const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
      expect(record.state, `status ${status}`).toBe("FAILED");
      expect(stack.requests.filter((request) => request.turn === "text").length).toBe(1);
      assertNoLeak(`row2 ${status}`, JSON.stringify(record));
    }
  }, 40_000);

  it("row3: a broken SSE stream mid-response fails the run with no silent completion", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "broken-sse" });
    const { runId } = await launchViaCli(stack);
    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("FAILED");
    expect(record.state).not.toBe("SUCCEEDED");
    // The fake child returns exit 0 IF the stream ever completes cleanly, so a regression
    // that stopped truncating would surface as SUCCEEDED and break the two assertions above
    // — the broken stream is NOT masked by an unconditional non-zero exit.
    expect(record.diagnostic?.code).toBe("PROCESS_EXIT_NONZERO");
    // One truncated attempt that cleared the contract gate; a severed stream is never
    // quietly treated as success, and there is no silent retry.
    expect(stack.requests.length).toBe(1);
    expect(stack.requests[0]?.accepted).toBe(true);
    assertNoLeak("row3 broken-sse", JSON.stringify(record));
  }, 40_000);
  it("row4: child exit before RPC readiness fails the run and never fabricates SUCCEEDED", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "early-exit", exitCode: 3 });
    // rpc: the child dies before emitting {ready}, so readiness is never observed.
    const started = await routeStart(stack, "rpc");
    const record = await waitForTerminal((id) => stack.supervisor.getRun(id), started.runId);
    expect(record.state).toBe("FAILED");
    expect(record.state).not.toBe("SUCCEEDED");
    assertNoLeak("row4 early-exit", JSON.stringify(record));
  }, 40_000);

  it("row5: cancel of a live run yields CANCELLED and is idempotent after terminal", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "wait-for-cancel" });
    const started = await routeStart(stack, "rpc");
    await waitForOpen((id) => stack.supervisor.getRun(id), started.runId);

    const cancelled = await stack.supervisor.cancel(started.runId);
    expect(cancelled?.state).toBe("CANCELLED");
    const record = await waitForTerminal((id) => stack.supervisor.getRun(id), started.runId);
    expect(record.state).toBe("CANCELLED");

    // A repeat cancel after terminal returns the record unchanged — no new transition,
    // never a late flip to SUCCEEDED.
    const again = await stack.supervisor.cancel(started.runId);
    expect(again?.state).toBe("CANCELLED");
    expect(again?.transitions.length).toBe(record.transitions.length);
    assertNoLeak("row5 cancel", JSON.stringify(record));
  }, 40_000);

  it("row6: a side-effecting tool that then errors is not retried (exactly one side effect)", async () => {
    const stack = await buildStack();
    const sideEffectFile = join(stack.root, "side-effect.log");
    await makeControl(stack.projectDir,
      { scenario: "tool-side-effect-then-error", sideEffectFile });
    const { runId } = await launchViaCli(stack);
    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("FAILED");
    // The side effect ran exactly once: no silent retry/fallback after a side-effecting
    // tool, which would have appended a second line.
    const contents = await readFile(sideEffectFile, "utf8").catch(() => "");
    expect(contents.split("side-effect").length - 1).toBe(1);
    assertNoLeak("row6 side-effect", JSON.stringify(record));
  }, 40_000);
});

// M2.3 — restart, ownership and truthful status on an isolated FileOmpRunRepository.
// A restarted supervisor over the SAME run-store owns none of the prior live children:
// it must mark an orphaned live run INTERRUPTED (ownership lost), never invent SUCCEEDED,
// and must leave an unrelated already-terminal run untouched.
describe("M2.3 restart / ownership / truthful status", () => {
  it("a restart marks an orphaned live run INTERRUPTED and leaves a completed run untouched", async () => {
    const stack = await buildStack();

    // 1) A run that completes normally and is persisted as SUCCEEDED.
    await makeControl(stack.projectDir, { scenario: "happy" });
    const happy = await routeStart(stack, "rpc");
    const happyRecord = await waitForTerminal((id) => stack.service.getRun(id), happy.runId);
    expect(happyRecord.state).toBe("SUCCEEDED");

    // 2) A run that stays live (idles after RPC readiness) so it can be orphaned.
    await makeControl(stack.projectDir, { scenario: "wait-for-cancel" });
    const live = await routeStart(stack, "rpc");
    await waitForOpen((id) => stack.service.getRun(id), live.runId);

    // 3) A fresh supervisor + repo over the SAME dir reconciles on restart.
    const restart = stack.newSupervisor();
    const reconciled = await restart.supervisor.reconcileAfterRestart();

    const liveAfter = await restart.runs.get(live.runId);
    expect(liveAfter?.state).toBe("INTERRUPTED");
    expect(liveAfter?.state).not.toBe("SUCCEEDED");
    expect(reconciled.some((run) => run.runId === live.runId)).toBe(true);

    // The already-terminal run is never touched by reconciliation.
    const happyAfter = await restart.runs.get(happy.runId);
    expect(happyAfter?.state).toBe("SUCCEEDED");
    expect(reconciled.some((run) => run.runId === happy.runId)).toBe(false);

    assertNoLeak("restart reconcile", JSON.stringify(liveAfter), JSON.stringify(happyAfter));

    // The original owner terminates only its own verified live child.
    await stack.supervisor.cancel(live.runId).catch(() => undefined);
  }, 40_000);
});

// ── M3.3 — strengthened boundary checks on the SAME managed harness (no 2nd suite) ──

// The strict upstream loopback is itself a fail-closed gate. This exercises it directly
// over the same origin the child uses (stack.fx.decision.baseUrl), proving each contract
// violation is rejected 4xx and that a rejection never echoes the marker credential.
describe("M3.3 strict upstream contract gate (loopback rejects non-conforming requests)", () => {
  it("rejects wrong method/path/protocol/model/marker-auth without leaking the marker, and admits only a conforming request", async () => {
    const stack = await buildStack();
    const base = stack.fx.decision.baseUrl;
    const endpoint = `${base}/chat/completions`;
    const good = { "content-type": "application/json", authorization: `Bearer ${MARKER}` };
    const goodBody = JSON.stringify({ model: EXPECTED_MODEL, turn: "text", stream: false });
    const probes: Array<{ label: string; status: number; run: () => ReturnType<typeof fetch> }> = [
      { label: "wrong method", status: 405, run: () => fetch(endpoint, { method: "GET", headers: good }) },
      { label: "wrong path", status: 404,
        run: () => fetch(`${base}/responses`, { method: "POST", headers: good, body: goodBody }) },
      { label: "non-json protocol", status: 400,
        run: () => fetch(endpoint, { method: "POST", headers: { "content-type": "text/plain", authorization: `Bearer ${MARKER}` }, body: "model=exact-model" }) },
      { label: "wrong model", status: 400,
        run: () => fetch(endpoint, { method: "POST", headers: good, body: JSON.stringify({ model: "other-model", turn: "text" }) }) },
      { label: "missing marker auth", status: 401,
        run: () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer not-the-real-marker" }, body: goodBody }) },
      // Point-4 regressions. On the pre-fix gate (prefix/suffix path match + a substring
      // content-type check) BOTH of these were wrongly ACCEPTED (200): a nested path still
      // "starts with /v1/ and ends with /chat/completions", and "application/json-patch+json"
      // still "includes application/json". These probes are the reproducible RED that drives
      // the exact-pathname + media-type-essence tightening.
      { label: "nested path under /v1", status: 404,
        run: () => fetch(`${base}/unexpected/chat/completions`, { method: "POST", headers: good, body: goodBody }) },
      { label: "json-variant media type", status: 400,
        run: () => fetch(endpoint, { method: "POST", headers: { "content-type": "application/json-patch+json", authorization: `Bearer ${MARKER}` }, body: goodBody }) },
    ];
    for (const probe of probes) {
      const response = await probe.run();
      const text = await response.text();
      expect(response.status, probe.label).toBe(probe.status);
      // A rejection body carries a fixed reason token, never the credential or a header value.
      expect(text.includes(MARKER), `${probe.label} leaked the marker`).toBe(false);
      assertNoLeak(`gate ${probe.label}`, text);
    }
    // A correctly-formed marker-authed request IS accepted (the gate is strict, not closed).
    const accepted = await fetch(endpoint, { method: "POST", headers: good, body: goodBody });
    expect(accepted.status).toBe(200);
    await accepted.text();
    // Exactly the good probe accepted; every violation recorded as not-accepted. None of
    // these probes came from a managed run, so no run state was fabricated.
    expect(stack.requests.filter((request) => request.accepted).length).toBe(1);
    expect(stack.requests.filter((request) => !request.accepted).length).toBe(probes.length);
  }, 40_000);
});
// The read-only tool turn reports sha256(file).slice(0,16). This proves that digest is
// CONTENT-BOUND: substitute the fixture bytes between two runs and the reported marker
// tracks the new bytes, so any assertion pinned to a stale/hard-coded hash would go RED.
describe("M3.3 tool-turn read digest tracks the actual bytes (substitution goes RED)", () => {
  it("reports sha256 of the real file, and a substituted fixture changes the reported marker", async () => {
    const stack = await buildStack();
    const readFixture = join(stack.projectDir, "read-fixture.txt");
    const bytesA = "provider-dock-read-fixture-ALPHA";
    const bytesB = "provider-dock-read-fixture-BRAVO-substituted-differently";
    const markerA = createHash("sha256").update(bytesA).digest("hex").slice(0, 16);
    const markerB = createHash("sha256").update(bytesB).digest("hex").slice(0, 16);
    expect(markerA).not.toBe(markerB);
    await makeControl(stack.projectDir, { scenario: "happy", readFixture });

    // Run 1: the loopback observes the digest of exactly bytesA.
    await writeFile(readFixture, bytesA, "utf8");
    const first = await launchViaCli(stack);
    const firstRecord = await waitForTerminal((id) => stack.service.getRun(id), first.runId);
    expect(firstRecord.state).toBe("SUCCEEDED");
    const firstTool = stack.requests.find((request) => request.turn === "tool");
    expect(firstTool?.readMarker).toBe(markerA);
    expect(firstTool?.readMarker).not.toBe(markerB);

    // Substitute the fixture, run again: the reported digest follows the NEW bytes. An
    // assertion still pinned to markerA would now be RED — the digest is not spoofable by
    // a stale expected hash, and a swapped file cannot masquerade as the original read.
    stack.requests.length = 0;
    await writeFile(readFixture, bytesB, "utf8");
    const second = await launchViaCli(stack);
    const secondRecord = await waitForTerminal((id) => stack.service.getRun(id), second.runId);
    expect(secondRecord.state).toBe("SUCCEEDED");
    const secondTool = stack.requests.find((request) => request.turn === "tool");
    expect(secondTool?.readMarker).toBe(markerB);
    expect(secondTool?.readMarker).not.toBe(markerA);

    assertNoLeak("digest substitution", JSON.stringify(firstRecord), JSON.stringify(secondRecord));
  }, 60_000);
});
// The failure and cancel paths driven through the REAL dashboard HTTP surface
// (launch -> runs -> runs/{id}/cancel), complementing the CLI failure rows above. The
// CLI has no cancel verb, so surface-level cancel is dashboard-only; this travels the
// exact endpoint the UI calls, with no direct supervisor.cancel.
describe("M3.3 dashboard run-management surface (fake child; real omp.exe BLOCKED)", () => {
  async function dashboardUrl(stack: Stack): Promise<string> {
    const server = new ProviderDashboardServer({
      application: dashboardApplication(),
      ompLauncher: stack.service,
      sessionToken: "a".repeat(48),
      healthMonitorIntervalMs: 0,
    });
    servers.push(server);
    return (await server.start()).url;
  }

  it("a failing run launched through the dashboard reaches FAILED and the runs list reports it", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "http-status", forceStatus: 401 });
    const url = await dashboardUrl(stack);

    const launch = await post(`${url}api/omp/launch`, dashInput(stack));
    expect(launch.status).toBe(202);
    const runId = (JSON.parse(launch.text) as { result: { runId: string } }).result.runId;

    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("FAILED");
    expect(record.state).not.toBe("SUCCEEDED");
    // Generic process-exit failure surfaced through the dashboard — not an invented auth code.
    expect(record.diagnostic?.code).toBe("PROCESS_EXIT_NONZERO");

    const runs = await getJson(`${url}api/omp/runs`);
    expect(runs.status).toBe(200);
    const listed = (JSON.parse(runs.text) as { runs: Array<{ runId: string; state: string }> }).runs;
    expect(listed.find((run) => run.runId === runId)?.state).toBe("FAILED");
    assertNoLeak("dashboard failure", launch.text, runs.text, JSON.stringify(record));
  }, 40_000);
  it("cancel through the dashboard endpoint yields CANCELLED, is idempotent, and 404s an unknown run", async () => {
    const stack = await buildStack();
    await makeControl(stack.projectDir, { scenario: "wait-for-cancel" });
    const url = await dashboardUrl(stack);

    const launch = await post(`${url}api/omp/launch`, dashInput(stack));
    expect(launch.status).toBe(202);
    const runId = (JSON.parse(launch.text) as { result: { runId: string } }).result.runId;
    await waitForOpen((id) => stack.service.getRun(id), runId);

    const cancel = await post(`${url}api/omp/runs/${runId}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect((JSON.parse(cancel.text) as { run: { state: string } }).run.state).toBe("CANCELLED");
    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("CANCELLED");

    // Idempotent: a repeat cancel of the now-terminal run returns CANCELLED, never a late
    // flip to SUCCEEDED — no fabricated success after the process is already gone.
    const again = await post(`${url}api/omp/runs/${runId}/cancel`, {});
    expect(again.status).toBe(200);
    expect((JSON.parse(again.text) as { run: { state: string } }).run.state).toBe("CANCELLED");

    // An unknown (well-formed) runId is a truthful 404, not a fabricated success.
    const unknown = await post(`${url}api/omp/runs/01937d71-7ae7-7abc-8100-0000000000ff/cancel`, {});
    expect(unknown.status).toBe(404);
    expect((JSON.parse(unknown.text) as { code: string }).code).toBe("OMP_RUN_NOT_FOUND");

    assertNoLeak("dashboard cancel", cancel.text, again.text, unknown.text, JSON.stringify(record));
  }, 40_000);

  it("does not lose a cancel of its own run published before ownership is registered (real HTTP + supervisor + temp repo)", async () => {
    // Reviewer's reproduction driven end-to-end over loopback HTTP: a visible pending
    // run is cancelled in the window between publishing its record and registering
    // ownership. Pre-fix, cancel() returns a stale VALIDATING and start() still spawns
    // (spawnsAfterRelease:1). Post-fix, the cancel is honoured and nothing spawns.
    let signalCancelArrived!: () => void;
    const cancelArrived = new Promise<void>((resolve) => { signalCancelArrived = resolve; });
    let signalPublished!: () => void;
    const published = new Promise<void>((resolve) => { signalPublished = resolve; });
    // Request-arrival barrier: hold create()'s RETURN (record already written & visible)
    // until the cancel request ARRIVES at the supervisor. We never wait for the cancel to
    // COMPLETE before releasing — that would deadlock; we only order the two events.
    const wrapRuns = (inner: OmpRunRepository): OmpRunRepository => ({
      async create(input) {
        const created = await inner.create(input);
        signalPublished();
        await cancelArrived;
        return created;
      },
      get: (id) => inner.get(id),
      list: () => inner.list(),
      transition: (id, state, details) => inner.transition(id, state, details),
    });
    const stack = await buildStack({ wrapRuns });
    const ownCancel = stack.supervisor.cancel.bind(stack.supervisor);
    stack.supervisor.cancel = (runId: string) => {
      signalCancelArrived(); // release create()'s return the instant the cancel lands
      return ownCancel(runId);
    };
    const url = await dashboardUrl(stack);

    // Fire the launch: it suspends inside create() at the barrier, so we do NOT await it.
    const launchPromise = post(`${url}api/omp/launch`, dashInput(stack));
    await published;
    const listed = await getJson(`${url}api/omp/runs`);
    expect(listed.status).toBe(200);
    const runs = (JSON.parse(listed.text) as { runs: Array<{ runId: string; state: string }> }).runs;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("VALIDATING"); // own pending run visible over HTTP
    const runId = runs[0]!.runId;
    expect(stack.children).toHaveLength(0);     // nothing spawned yet

    // Cancel in the window; its arrival releases create()'s return (see wrapper).
    const cancel = await post(`${url}api/omp/runs/${runId}/cancel`, {});
    expect(cancel.status).toBe(200);
    expect((JSON.parse(cancel.text) as { run: { state: string } }).run.state).toBe("CANCELLED");

    const launch = await launchPromise;
    // ok:false launch is a 200 carrying the CANCELLED runId; a spawned run would be 202.
    expect(launch.status).toBe(200);
    expect((JSON.parse(launch.text) as { result: { runId: string } }).result.runId).toBe(runId);

    const record = await waitForTerminal((id) => stack.service.getRun(id), runId);
    expect(record.state).toBe("CANCELLED");
    expect(stack.children).toHaveLength(0); // the cancel prevented any spawn

    // Idempotent: repeating the cancel of the settled run stays CANCELLED, spawns nothing.
    const again = await post(`${url}api/omp/runs/${runId}/cancel`, {});
    expect(again.status).toBe(200);
    expect((JSON.parse(again.text) as { run: { state: string } }).run.state).toBe("CANCELLED");
    expect(stack.children).toHaveLength(0);

    assertNoLeak("publish-ownership race", listed.text, cancel.text, launch.text, JSON.stringify(record));
  }, 40_000);
});
// OmpRuntime.preflight admits ONLY a project with no unreviewed agent settings. Each
// prohibited bootstrap input is created in its OWN isolated temp project dir under the
// harness root; the working tree's real .claude/settings.local.json is never read,
// written, renamed, or otherwise touched.
describe("M3.3 project-settings prohibition (OmpRuntime.preflight on fixture projects)", () => {
  it("rejects a fixture project carrying any unreviewed agent settings, and admits a clean one", async () => {
    const stack = await buildStack();
    const base = await stack.service.selection(stack.input);
    if (!("route" in base)) throw new Error(`no route: ${JSON.stringify(base.diagnostic)}`);

    // Control: the clean fixture project (no agent settings) preflights ok.
    const clean = await stack.runtime.preflight(base);
    expect(clean.ok).toBe(true);

    // Each prohibited input, in its own isolated dir, must be rejected with the exact
    // settings-unreviewed diagnostic — never silently launched.
    const prohibited: ReadonlyArray<readonly [string, string]> = [
      [".omp", join(".omp", "config.yml")],
      [".claude", join(".claude", "settings.json")],
      [".claude-local", join(".claude", "settings.local.json")],
      [".codex", join(".codex", "config.toml")],
      ["opencode", "opencode.json"],
    ];
    for (const [label, relative] of prohibited) {
      const projectDir = join(stack.root, `settings-${label}`);
      const file = join(projectDir, relative);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, "{}", "utf8");
      const result = await stack.runtime.preflight({ ...base, projectDirectory: projectDir });
      expect(result.ok, label).toBe(false);
      if (result.ok) throw new Error(`expected ${label} rejected`);
      expect(result.diagnostic.code, label).toBe("OMP_PROJECT_SETTINGS_UNREVIEWED");
    }
  }, 40_000);
});
// Machine-checked BLOCKED status: this host has no OS-level egress isolation and OMP
// flags alone are insufficient, so the harness spawns Node against a .mjs FAKE child and
// NEVER the pinned omp.exe. Every acceptance in this file is therefore explicitly "not
// confirmed against real OMP". If someone ever repointed the seam at omp.exe, this fails.
describe("M3.3 real-binary status (BLOCKED — controlled fake child only)", () => {
  it("drives a .mjs fake child, never the pinned omp.exe", () => {
    expect(FAKE_CHILD.endsWith("omp-fake-child.mjs")).toBe(true);
    expect(/omp\.exe$/i.test(FAKE_CHILD)).toBe(false);
  });
});
// ── M3-FINAL.3 — the emergency-stop contract across the REAL dashboard HTTP surface ──
//
// M3-FINAL.1 proved in the supervisor unit suite that a faulted-but-possibly-live child
// is NOT hidden behind a terminal FAILED. This proves the SAME contract end-to-end over a
// real ProviderDashboardServer: the run is observed and re-cancelled purely through
// GET /api/omp/runs and POST /api/omp/runs/{id}/cancel (the exact endpoints the UI calls),
// backed by the REAL OmpProcessSupervisor + a temporary FileOmpRunRepository, reached via
// the real route-acceptance + prepare path — NOT a pre-baked cancel() result. Only the
// spawned child is a controlled in-process double: its kill is UNDELIVERABLE (it records
// the attempt, synchronously emits an EPERM 'error', returns false, and NEVER emits
// 'close'), which a cooperative OS child cannot model on Windows, where kill() always
// terminates. This is a test double, not an OS/network sandbox; no real omp.exe runs and
// guaranteed OS-hard-kill stays unproven.
class UndeliverableKillChild extends EventEmitter implements OmpSupervisorChild {
  readonly pid: number;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: (NodeJS.Signals | undefined)[] = [];
  private closed = false;
  constructor(pid = 74123) {
    super();
    this.pid = pid;
  }
  // An undeliverable signal is not proof of death: record the attempt, surface it as Node
  // does (a synchronous 'error' + a false return), and NEVER emit 'close'. The supervisor
  // must therefore keep the run non-terminal until this child's own close() below.
  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    this.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    return false;
  }
  // The child's OWN eventual exit — the only event that may settle a terminal outcome.
  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }
}
describe("M3-FINAL.3 dashboard emergency-stop surface (real supervisor + temp repo + HTTP)", () => {
  async function dashboardUrl(stack: Stack): Promise<string> {
    const server = new ProviderDashboardServer({
      application: dashboardApplication(),
      ompLauncher: stack.service,
      sessionToken: "a".repeat(48),
      healthMonitorIntervalMs: 0,
    });
    servers.push(server);
    return (await server.start()).url;
  }
  const runOf = (text: string, runId: string): OmpRunRecord | undefined =>
    (JSON.parse(text) as { runs: OmpRunRecord[] }).runs.find((run) => run.runId === runId);

  it("keeps a faulted live child non-terminal over HTTP; only its own close settles one FAILED with the original cause", async () => {
    // A raw-stdout canary carrying the credential-shaped MARKER: the fault must surface a
    // generic code and never echo the child's bytes into the record or any HTTP body.
    const canary = `${MARKER} <- raw child stdout, must never leak`;
    let spawned: UndeliverableKillChild | undefined;
    let spawnCalls = 0;
    const spawn: OmpSupervisorSpawn = () => {
      spawnCalls += 1;
      spawned = new UndeliverableKillChild();
      return spawned;
    };
    // Real stack; short grace so each unconfirmed window resolves fast. The dashboard is
    // started BEFORE any run exists, so its start-time reconcile is a no-op here.
    const stack = await buildStack({ spawn, cancelGraceMs: 40 });
    const url = await dashboardUrl(stack);

    // Real route acceptance -> real preflight/prepare -> real supervisor.start with the
    // controlled child in RPC mode (the only mode with an init/frame fault path).
    const { runId } = await routeStart(stack, "rpc");
    if (spawned === undefined) throw new Error("controlled child was not spawned");
    const live = spawned;

    // The fault: an unparseable frame whose bytes contain the canary. driveRpc records
    // OMP_RPC_PROTOCOL_ERROR as the pending cause and begins stopping the live child;
    // the kill cannot be delivered, so the run becomes non-terminal CANCELLING.
    live.stdout.write(`${canary}\n`);
    await waitFor((id) => stack.supervisor.getRun(id), runId, (s) => s === "CANCELLING", "CANCELLING");

    // Over HTTP the run is CANCELLING (non-terminal) carrying the ORIGINAL cause; the
    // undeliverable kill was attempted at least once but the child is not confirmed dead.
    const before = await getJson(`${url}api/omp/runs`);
    expect(before.status).toBe(200);
    const cancelling = runOf(before.text, runId);
    expect(cancelling?.state).toBe("CANCELLING");
    expect(cancelling !== undefined && TERMINAL.has(cancelling.state)).toBe(false);
    expect(cancelling?.diagnostic?.code).toBe("OMP_RPC_PROTOCOL_ERROR");
    const killsBeforeRetry = live.killSignals.length;
    expect(killsBeforeRetry).toBeGreaterThan(0);
    // A retry-cancel through the dashboard re-signals THIS child (kill count grows) and
    // still refuses to fake a terminal: one POST, still CANCELLING, cause preserved.
    const retry = await post(`${url}api/omp/runs/${runId}/cancel`, {});
    expect(retry.status).toBe(200);
    const retried = (JSON.parse(retry.text) as { run: OmpRunRecord }).run;
    expect(retried.state).toBe("CANCELLING");
    expect(TERMINAL.has(retried.state)).toBe(false);
    expect(retried.diagnostic?.code).toBe("OMP_RPC_PROTOCOL_ERROR");
    expect(live.killSignals.length).toBeGreaterThan(killsBeforeRetry);
    expect(spawnCalls).toBe(1); // no respawn / fallback / new inference on stop

    // Still no terminal — in HTTP or in the persisted record — before the child closes.
    const mid = await getJson(`${url}api/omp/runs`);
    expect(runOf(mid.text, runId)?.state).toBe("CANCELLING");
    const midRecord = await stack.supervisor.getRun(runId);
    expect(midRecord !== undefined && TERMINAL.has(midRecord.state)).toBe(false);

    // The child's OWN close, with a CLEAN exit 0 (not a nonzero error exit), settles
    // exactly one terminal: FAILED with the original safe cause — never SUCCEEDED.
    live.close(0, "SIGTERM");
    const settled = await waitFor(
      (id) => stack.supervisor.getRun(id), runId, (s) => s === "FAILED", "FAILED",
    );
    expect(settled.diagnostic?.code).toBe("OMP_RPC_PROTOCOL_ERROR");
    const terminalTransitions = settled.transitions.filter((step) => TERMINAL.has(step.state));
    expect(terminalTransitions.map((step) => step.state)).toEqual(["FAILED"]);

    const after = await getJson(`${url}api/omp/runs`);
    const failed = runOf(after.text, runId);
    expect(failed?.state).toBe("FAILED");
    expect(failed?.diagnostic?.code).toBe("OMP_RPC_PROTOCOL_ERROR");
    expect(spawnCalls).toBe(1);

    // The credential-shaped canary and every standard secret needle stay out of every
    // HTTP body and the serialized record across the whole emergency-stop path.
    for (const body of [before.text, retry.text, mid.text, after.text, JSON.stringify(settled)]) {
      expect(body.includes(canary)).toBe(false);
    }
    assertNoLeak("emergency stop", before.text, retry.text, mid.text, after.text, JSON.stringify(settled));
  }, 40_000);
});
