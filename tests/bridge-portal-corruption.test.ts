import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultApplication } from "../src/application/create-default-application.js";
import type { ProviderDockApplication } from "../src/application/provider-dock-application.js";
import { NodeCodexProcessRunner } from "../src/clients/codex/codex-launcher.js";
import { NodeClaudeProcessRunner } from "../src/clients/claude/claude-launcher.js";
import { FileProviderHealthRepository } from "../src/core/health/provider-health-repository.js";
import { createProviderRuntimeHealthSignal } from "../src/core/health/provider-runtime-health.js";
import { FilePortalRepository } from "../src/core/portals/portal-repository.js";
import type { ModelProtocol } from "../src/core/providers/model-protocol.js";

type Client = "codex" | "claude-code";
const clients: readonly Client[] = ["codex", "claude-code"];
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) {
    // Only delete test-owned directories, never a real agent home.
    if (!resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
        !directory.includes("provider-dock-corrupt-")) throw new Error("Unsafe test cleanup");
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function fixture(options: { apiType?: "auto" | "openai-chat-completions"; rejectedPath?: string } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "provider-dock-corrupt-"));
  directories.push(directory);
  vi.stubEnv("PROVIDERDOCK_AGENT_SKILLS_DIR", join(directory, "absent-skills"));
  const accountPath = join(directory, "portals", "accounts.json");
  await mkdir(join(directory, "portals"), { recursive: true });
  const original = Buffer.alloc(280047);
  await writeFile(accountPath, original);
  const upstreamPaths: string[] = [];
  const application = createDefaultApplication({
    platform: "linux", // Use fixture environment credentials, not Windows DPAPI.
    userHome: directory,
    environment: {
      PROVIDER_DOCK_HOME: directory,
      CODEX_HOME: join(directory, "codex-home"),
      CLAUDE_CONFIG_DIR: join(directory, "claude-home"),
      FIXTURE_KEY: "fixture-only-key",
    },
    fetchImpl: async (url, init) => {
      const target = new URL(String(url));
      expect(target.origin).toBe("https://fixture.invalid");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer fixture-only-key");
      if (target.pathname === "/v1/models") {
        return Response.json({ object: "list", data: [{ id: "fixture-model", object: "model" }] });
      }
      upstreamPaths.push(target.pathname);
      const body = JSON.parse(String(init?.body));
      expect(body.model).toBe("fixture-model");
      if (target.pathname === options.rejectedPath) {
        return Response.json({ error: { message: "Endpoint not supported" } }, { status: 404 });
      }
      if (target.pathname === "/v1/responses") {
        return Response.json({
          id: "resp-fixture", object: "response", model: body.model, status: "completed",
          output: [{ id: "out-fixture", type: "message", role: "assistant", status: "completed",
            content: [{ type: "output_text", text: "fixture-ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      expect(target.pathname).toBe("/v1/chat/completions");
      return Response.json({
        id: "chat-fixture", object: "chat.completion", model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "fixture-ok" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });
  await application.setProvider({
    id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1",
    adapterId: "generic-openai", apiType: options.apiType ?? "auto",
    auth: { kind: "bearer", secretRef: "FIXTURE_KEY" },
    manualModelIds: ["fixture-model"], healthCheck: { enabled: false },
  });
  return { directory, accountPath, original, application, upstreamPaths };
}

// Substitute only the external CLI process. Composition, launch/config generation,
// loopback HTTP, protocol selection, repositories and lifecycle remain real.
async function sendThroughLaunch(
  application: ProviderDockApplication, directory: string, client: Client, stream: boolean,
) {
  let result: { status: number; text: string } | undefined;
  const send = async (url: string, body: unknown, token = "") => {
    expect(new URL(url).hostname).toBe("127.0.0.1");
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": token },
      body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
    });
    result = { status: response.status, text: await response.text() };
    return { exitCode: 0, signal: null };
  };
  const input = {
    providerId: "fixture", modelId: "fixture-model", projectDirectory: directory,
    parentEnvironment: {},
  };
  if (client === "codex") {
    vi.spyOn(NodeCodexProcessRunner.prototype, "start").mockImplementation(async request => ({
      pid: process.pid,
      wait: async () => {
        const profileName = request.args[request.args.indexOf("--profile") + 1]!;
        const config = await readFile(join(request.environment.CODEX_HOME!, `${profileName}.config.toml`), "utf8");
        const match = /^base_url = (".+")$/m.exec(config);
        expect(match).not.toBeNull();
        const baseUrl = JSON.parse(match![1]!);
        return send(baseUrl + "/responses", { model: "fixture-model", input: "Hello", stream });
      },
    }));
    await application.launchCodex({ ...input, route: { kind: "auto" } });
  } else {
    vi.spyOn(NodeClaudeProcessRunner.prototype, "start").mockImplementation(async request => ({
      pid: process.pid,
      wait: () => send(request.environment.ANTHROPIC_BASE_URL + "/v1/messages",
        { model: "fixture-model", max_tokens: 64, messages: [{ role: "user", content: "Hello" }], stream },
        request.environment.ANTHROPIC_AUTH_TOKEN),
    }));
    await application.launchClaude(input);
  }
  expect(result).toBeDefined();
  return result!;
}

function portalWithHint(protocol: ModelProtocol) {
  const timing = {
    sourceUrl: "https://fixture.invalid/api/pricing",
    observedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
  const unavailable = { ...timing, status: "unsupported", value: null };
  return JSON.stringify({ version: 2, records: [{
    connection: { providerId: "fixture", siteUrl: "https://fixture.invalid", autoRefresh: false },
    revision: "d81d4c49-ce22-44b9-8353-0d0e66ad17ef",
    latest: {
      site: unavailable, wallet: unavailable, checkIn: unavailable,
      catalog: { ...timing, status: "ok", value: { models: [{
        modelId: "fixture-model", description: null, vendor: null,
        endpointTypes: [protocol], tags: null, contextTokens: null, billing: "unknown",
        basePrices: { currency: "USD", inputPerMillion: null, outputPerMillion: null,
          cacheReadInputPerMillion: null, cacheWriteInputPerMillion: null, perRequest: null },
        groups: [],
      }] } },
    },
  }] });
}

describe.each(clients)("%s with corrupt optional portal metadata", client => {
  it.each([false, true])("sends an auto-protocol request instead of failing locally (stream=%s)", async stream => {
    const { application, directory, accountPath, original, upstreamPaths } = await fixture();
    const result = await sendThroughLaunch(application, directory, client, stream);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toHaveLength(1);
    expect(application.providerPortalStatus().state).toBe("corrupt");
    expect(await readFile(accountPath)).toEqual(original);
  });

  // Choose the opposite of this client's default negotiation path, so silently
  // discarding a valid hint cannot make these tests pass.
  const hintedProtocol = client === "codex" ? "openai-chat-completions" : "openai-responses";
  const hintedPath = client === "codex" ? "/v1/chat/completions" : "/v1/responses";

  it("retains valid health protocol hints when the portal file is corrupt", async () => {
    const { application, directory, upstreamPaths } = await fixture();
    const health = new FileProviderHealthRepository(join(directory, "health", "history.json"));
    await health.recordRuntimeSignal(createProviderRuntimeHealthSignal({
      providerId: "fixture", modelId: "fixture-model", client,
      protocol: hintedProtocol, outcome: "completed",
    }));
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toEqual([hintedPath]);
    expect(application.providerPortalStatus().state).toBe("corrupt");
  });

  it("still uses valid portal hints instead of ignoring portal metadata unconditionally", async () => {
    const { application, directory, accountPath, upstreamPaths } = await fixture();
    await writeFile(accountPath, portalWithHint(hintedProtocol));
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toEqual([hintedPath]);
    expect(application.providerPortalStatus().state).toBe("healthy");
  });

  it("keeps normal endpoint negotiation after a definitive rejection without portal hints", async () => {
    const rejectedPath = client === "codex" ? "/v1/responses" : "/v1/chat/completions";
    const { application, directory, upstreamPaths } = await fixture({ rejectedPath });
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toEqual([rejectedPath, hintedPath]);
  });

  it("does not swallow unrelated portal read failures", async () => {
    const { application, directory, upstreamPaths } = await fixture();
    vi.spyOn(FilePortalRepository.prototype, "get").mockRejectedValue(
      Object.assign(new Error("Fixture permission denied"), { code: "EACCES" }),
    );
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status).toBe(500);
    expect(result.text).not.toContain("fixture-ok");
    expect(upstreamPaths).toEqual([]);
  });

  it("keeps explicit Chat routing independent of portal metadata", async () => {
    const { application, directory, upstreamPaths, accountPath, original } =
      await fixture({ apiType: "openai-chat-completions" });
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toEqual(["/v1/chat/completions"]);
    expect(await readFile(accountPath)).toEqual(original);
  });

  it("can send a request with no portal file", async () => {
    const { application, directory, upstreamPaths, accountPath } = await fixture();
    await rm(accountPath);
    const result = await sendThroughLaunch(application, directory, client, false);
    expect(result.status, result.text).toBe(200);
    expect(result.text).toContain("fixture-ok");
    expect(upstreamPaths).toHaveLength(1);
    expect(application.providerPortalStatus().state).toBe("healthy");
  });
});
