import { access, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeSessionManager,
  CodexShimCompatibilityBridgeFactory,
  NodeCodexShimProcessRunner,
  MemorySecretStore,
  parseLogicalModelGroup,
  parseProviderProfile,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
  type CodexShimProcessRunner,
  type CodexShimProcessStartRequest,
  type FallbackNotification,
  type ProviderProfile,
  type RunningCodexShimProcess,
} from "../src/index.js";

const sessionId = "77777777777777777777777777777777";

describe("managed codex-shim compatibility bridge", () => {
  it("creates a secret-safe isolated shim in front of the TurnLedger bridge", async () => {
    const fixture = await createFixture();
    const secrets = new MemorySecretStore({ ANTHROPIC_KEY: "anthropic-secret" });
    const events: string[] = [];
    const processRunner = new FakeShimProcessRunner(events);
    const upstreamCalls: { url: string; headers: Headers; body: unknown }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/health")) {
        events.push("shim:health");
        return healthResponse(1);
      }
      if (String(url).endsWith("/v1/responses")) {
        upstreamCalls.push({
          url: String(url),
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        events.push("shim:response");
        return nativeResponse("Anthropic route works.");
      }
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    const factory = new CodexShimCompatibilityBridgeFactory({
      secretStore: secrets,
      fetchImpl,
      runtimeRoot: fixture.runtimeRoot,
      processRunner,
      sleep: async () => undefined,
    });
    const bridge = factory.create({
      profile: anthropicProfile(),
      modelId: "claude-model",
      sessionId,
    });

    const address = await bridge.start();
    const first = await post(address.baseUrl, "claude-model", "first turn");
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      status: "completed",
      output: [{ type: "message", content: [{ text: "Anthropic route works." }] }],
    });

    const replay = await post(address.baseUrl, "claude-model", "first turn");
    expect(replay.status).toBe(409);
    expect(replay.headers.get("x-providerdock-turn-block")).toBe("TURN_ALREADY_COMPLETED");
    expect(upstreamCalls).toHaveLength(1);

    const settingsPath = processRunner.requests[0]?.args[2];
    expect(settingsPath).toBeDefined();
    const settingsBytes = await readFile(settingsPath ?? "");
    expect(settingsBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    const settingsBuffer = settingsBytes.toString("utf8");
    const settings = JSON.parse(settingsBuffer) as {
      models: readonly { model: string; provider: string; base_url: string; api_key_env: string }[];
    };
    expect(settings.models).toEqual([
      {
        model: "claude-model",
        provider: "anthropic",
        base_url: "https://anthropic.test/v1",
        display_name: "Anthropic Router claude-model",
        api_key_env: expect.any(String),
      },
    ]);
    expect(settingsBuffer).not.toContain("anthropic-secret");
    expect(settingsBuffer).not.toContain('"api_key"');

    const request = processRunner.requests[0];
    expect(request).toBeDefined();
    const environment = request?.environment ?? {};
    expect(environment[settings.models[0]?.api_key_env ?? ""]).toBe("anthropic-secret");
    expect(environment.PROVIDER_DOCK_SHIM_AUTH_TOKEN).toEqual(expect.any(String));
    expect(environment.CODEX_SHIM_DISABLE_CHATGPT).toBe("1");
    expect(environment.CODEX_SHIM_DISABLE_CURSOR).toBe("1");
    expect(environment.CODEX_SHIM_DISABLE_ROUTER).toBe("1");
    expect(Object.entries(environment).filter(([, value]) => value === "anthropic-secret")).toHaveLength(1);

    expect(upstreamCalls[0]).toMatchObject({
      url: "http://127.0.0.1:46000/v1/responses",
      body: { model: "claude-model", stream: false },
    });
    expect(upstreamCalls[0]?.headers.get("x-providerdock-shim-token")).toEqual(
      expect.any(String),
    );
    expect(upstreamCalls[0]?.headers.get("x-providerdock-shim-token")).not.toBe("anthropic-secret");

    const wrapperPath = processRunner.requests[0]?.args[0];
    const wrapper = await readFile(wrapperPath ?? "", "utf8");
    expect(wrapper).toContain("_dump_debug_request = lambda");
    expect(wrapper).toContain("_needs_image_gen = lambda");
    expect(wrapper).toContain("PROVIDERDOCK_SHIM_READY:");
    expect(wrapper).not.toContain(".codex-shim");

    await bridge.stop();
    expect(processRunner.processes[0]?.stopped).toBe(true);
    await expect(access(join(fixture.runtimeRoot, "codex-shim", sessionId))).rejects.toThrow();
  });

  it("falls back from an OpenAI Responses route to a managed Anthropic shim route", async () => {
    const fixture = await createFixture();
    const secrets = new MemorySecretStore({ ANTHROPIC_KEY: "anthropic-secret" });
    const events: string[] = [];
    const processRunner = new FakeShimProcessRunner(events);
    const notifications: FallbackNotification[] = [];
    const upstreamCalls: { url: string; headers: Headers; body: unknown }[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const value = String(url);
      if (value.startsWith("https://primary.test/")) {
        events.push("primary:response");
        throw connectionRefused();
      }
      if (value.endsWith("/health")) {
        events.push("shim:health");
        return healthResponse(1);
      }
      if (value.endsWith("/v1/responses")) {
        upstreamCalls.push({
          url: value,
          headers: new Headers(init?.headers),
          body: JSON.parse(String(init?.body)),
        });
        events.push("shim:response");
        return nativeResponse("Fallback route works.");
      }
      throw new Error(`Unexpected fetch URL: ${value}`);
    });
    const primary = responsesProfile();
    const secondary = anthropicProfile();
    const runner = new BridgeUsingCodexRunner();
    const launcher = new CodexLauncher(
      fixture.manager,
      runner,
      new CodexShimCompatibilityBridgeFactory({
        secretStore: secrets,
        fetchImpl,
        runtimeRoot: fixture.runtimeRoot,
        processRunner,
        sleep: async () => undefined,
      }),
    );

    await launcher.launch({
      profile: primary,
      modelId: "logical-x",
      projectDirectory: fixture.projectDirectory,
      route: { kind: "auto" },
      fallback: fallbackConfiguration(primary, secondary),
      onFallback: (notification) => notifications.push(notification),
    });

    expect(runner.providerResponse).toMatchObject({
      status: "completed",
      output: [{ type: "message", content: [{ text: "Fallback route works." }] }],
    });
    expect(notifications).toEqual([
      expect.objectContaining({
        logicalModelId: "logical-x",
        from: expect.objectContaining({ providerId: "primary", modelId: "primary-model" }),
        to: expect.objectContaining({ providerId: "anthropic-router", modelId: "claude-model" }),
        errorType: "NETWORK_ERROR",
        phase: "connection-failed",
      }),
    ]);
    expect(upstreamCalls[0]).toMatchObject({
      url: "http://127.0.0.1:46000/v1/responses",
      body: { model: "claude-model", stream: false },
    });
    expect(upstreamCalls[0]?.headers.get("x-providerdock-shim-token")).toEqual(expect.any(String));
    expect(runner.configContents).not.toContain("anthropic-secret");
    expect(Object.values(runner.request?.environment ?? {})).not.toContain("anthropic-secret");
    expect(processRunner.processes[0]?.stopped).toBe(true);
    await expect(access(join(fixture.runtimeRoot, "codex-shim", sessionId))).rejects.toThrow();
  });

  it("keeps an ambiguous HTTP 500 on the primary route instead of replaying through the shim", async () => {
    const fixture = await createFixture();
    const secrets = new MemorySecretStore({ ANTHROPIC_KEY: "anthropic-secret" });
    const events: string[] = [];
    const processRunner = new FakeShimProcessRunner(events);
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      const value = String(url);
      if (value.startsWith("https://primary.test/")) {
        return new Response(JSON.stringify({ error: { message: "upstream exploded" } }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      if (value.endsWith("/health")) return healthResponse(1);
      throw new Error(`Unexpected shim inference call: ${value}`);
    });
    const primary = responsesProfile();
    const secondary = anthropicProfile();
    const bridge = new CodexShimCompatibilityBridgeFactory({
      secretStore: secrets,
      fetchImpl,
      runtimeRoot: fixture.runtimeRoot,
      processRunner,
      sleep: async () => undefined,
    }).create({
      profile: primary,
      modelId: "logical-x",
      sessionId,
      fallback: fallbackConfiguration(primary, secondary),
    });
    const address = await bridge.start();

    try {
      const response = await post(address.baseUrl, "logical-x", "must not replay");
      expect(response.status).toBe(500);
      expect(response.headers.get("x-providerdock-fallback-block")).toBe("FALLBACK_STATE_AMBIGUOUS");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(processRunner.processes[0]?.stopped).toBe(false);
    } finally {
      await bridge.stop();
    }
    expect(processRunner.processes[0]?.stopped).toBe(true);
  });

  it("surfaces codex-shim stderr when the child exits before readiness", async () => {
    const fixture = await createFixture();
    const runner = new NodeCodexShimProcessRunner();
    const child = runner.start({
      executable: process.execPath,
      args: ["-e", "console.error('codex-shim module cannot be imported'); process.exit(1);"],
      cwd: fixture.root,
      environment: process.env,
      startupTimeoutMs: 2_000,
    });

    await expect(child.ready()).rejects.toThrow(/codex-shim module cannot be imported/);
    expect(await child.wait()).toEqual({ exitCode: 1, signal: null });
  });

  it("cleans every started shim process when a later provider fails startup", async () => {
    const fixture = await createFixture();
    const secrets = new MemorySecretStore({
      FIRST_KEY: "first-secret",
      SECOND_KEY: "second-secret",
    });
    const events: string[] = [];
    const processRunner = new FakeShimProcessRunner(events, { failSecondReady: true });
    const fetchImpl = vi.fn<typeof fetch>(async (url) => {
      if (String(url).endsWith("/health")) return healthResponse(1);
      throw new Error(`Unexpected fetch URL: ${String(url)}`);
    });
    const primary = anthropicProfile("first-anthropic", "https://first.test/v1", "FIRST_KEY");
    const secondary = anthropicProfile("second-anthropic", "https://second.test/v1", "SECOND_KEY");
    const bridge = new CodexShimCompatibilityBridgeFactory({
      secretStore: secrets,
      fetchImpl,
      runtimeRoot: fixture.runtimeRoot,
      processRunner,
      sleep: async () => undefined,
    }).create({
      profile: primary,
      modelId: "logical-x",
      sessionId,
      fallback: fallbackConfiguration(primary, secondary),
    });

    await expect(bridge.start()).rejects.toThrow("second shim failed before readiness");
    expect(processRunner.processes.map((process) => process.stopped)).toEqual([true, true]);
    await expect(access(join(fixture.runtimeRoot, "codex-shim", sessionId))).rejects.toThrow();
  });
});

function anthropicProfile(
  id = "anthropic-router",
  baseUrl = "https://anthropic.test/v1",
  secretRef = "ANTHROPIC_KEY",
): ProviderProfile {
  return parseProviderProfile({
    id,
    displayName: "Anthropic Router",
    baseUrl,
    apiType: "anthropic-messages",
    adapterId: "generic-anthropic",
    auth: { kind: "header", headerName: "x-api-key", secretRef },
    manualModelIds: [id === "anthropic-router" ? "claude-model" : `${id}-model`],
    timeoutMs: 1_000,
  });
}

function responsesProfile(): ProviderProfile {
  return parseProviderProfile({
    id: "primary",
    displayName: "Primary",
    baseUrl: "https://primary.test/v1",
    apiType: "openai-responses",
    timeoutMs: 1_000,
  });
}

function fallbackConfiguration(primary: ProviderProfile, secondary: ProviderProfile) {
  return {
    logicalModel: parseLogicalModelGroup({
      id: "logical-x",
      routes: [
        { providerId: primary.id, modelId: primary.id === "primary" ? "primary-model" : `${primary.id}-model`, priority: 100 },
        { providerId: secondary.id, modelId: secondary.id === "anthropic-router" ? "claude-model" : `${secondary.id}-model`, priority: 90 },
      ],
    }),
    profiles: [primary, secondary],
  };
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "provider-dock-codex-shim-"));
  const codexHome = join(root, "codex-home");
  const runtimeRoot = join(root, "runtime");
  const projectDirectory = join(root, "project");
  await Promise.all([mkdir(codexHome), mkdir(projectDirectory)]);
  const manager = new CodexRuntimeSessionManager({
    codexHome,
    runtimeRoot,
    secrets: new MemorySecretStore(),
    randomId: () => sessionId,
    isProcessAlive: () => false,
  });
  return { root, codexHome, runtimeRoot, projectDirectory, manager };
}

class FakeShimProcess implements RunningCodexShimProcess {
  readonly pid: number;
  stopped = false;
  private readonly exit: Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>;
  private readonly exitResolve: (value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void;

  constructor(
    private readonly index: number,
    private readonly events: string[],
    private readonly failReady: boolean,
  ) {
    this.pid = 20_000 + index;
    let resolveExit:
      | ((value: { exitCode: number | null; signal: NodeJS.Signals | null }) => void)
      | undefined;
    this.exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.exitResolve = (value) => resolveExit?.(value);
  }

  async ready(): Promise<{ port: number }> {
    this.events.push(`shim:${this.index}:ready`);
    if (this.failReady) throw new Error("second shim failed before readiness");
    return { port: 46_000 + this.index };
  }

  wait(): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }> {
    return this.exit;
  }

  isRunning(): boolean {
    return !this.stopped;
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.events.push(`shim:${this.index}:stop`);
    this.exitResolve({ exitCode: 0, signal: null });
  }
}

class FakeShimProcessRunner implements CodexShimProcessRunner {
  readonly requests: CodexShimProcessStartRequest[] = [];
  readonly processes: FakeShimProcess[] = [];

  constructor(
    private readonly events: string[],
    private readonly options: { readonly failSecondReady?: boolean } = {},
  ) {}

  start(request: CodexShimProcessStartRequest): RunningCodexShimProcess {
    const index = this.requests.length;
    const process = new FakeShimProcess(
      index,
      this.events,
      this.options.failSecondReady === true && index === 1,
    );
    this.requests.push(request);
    this.processes.push(process);
    return process;
  }
}

class BridgeUsingCodexRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;
  configContents: string | undefined;
  bridgeBaseUrl: string | undefined;
  providerResponse: unknown;

  async start(request: CodexProcessStartRequest) {
    this.request = request;
    const profileName = request.args[2];
    const codexHome = request.environment.CODEX_HOME;
    if (profileName === undefined || codexHome === undefined) {
      throw new Error("Codex test process did not receive its runtime profile.");
    }
    this.configContents = await readFile(join(codexHome, `${profileName}.config.toml`), "utf8");
    const baseUrl = /base_url = "([^"]+)"/.exec(this.configContents)?.[1];
    if (baseUrl === undefined) throw new Error("Managed bridge URL was not configured.");
    this.bridgeBaseUrl = baseUrl;
    const response = await post(baseUrl, "logical-x", "Hello");
    this.providerResponse = await response.json();
    if (!response.ok) throw new Error(`Codex bridge request failed: ${response.status}`);
    return {
      pid: 43_21,
      wait: async () => ({ exitCode: 0, signal: null }),
    };
  }
}

function healthResponse(models: number): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      models,
      chatgpt_passthrough: false,
      cursor_passthrough: false,
      auto_router: false,
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function nativeResponse(text: string): Response {
  return new Response(
    JSON.stringify({
      id: "response-shim",
      object: "response",
      status: "completed",
      output: [
        {
          id: "message-1",
          type: "message",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        },
      ],
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function post(baseUrl: string, model: string, input: string): Promise<Response> {
  return fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, input, stream: false }),
  });
}

function connectionRefused(): TypeError {
  return new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }),
  });
}
