import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeConfigurationError,
  CodexRuntimeSessionManager,
  MemorySecretStore,
  parseProviderProfile,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
  type CodexBridgeFactory,
  type CreateCodexBridgeInput,
  type ManagedCodexBridge,
  type RunningCodexProcess,
} from "../src/index.js";

const sessionId = "abcdef0123456789abcdef0123456789";

describe("CodexRuntimeSessionManager", () => {
  it("never modifies the user config and removes its unchanged temporary profile", async () => {
    const fixture = await createFixture();
    const userConfigPath = join(fixture.codexHome, "config.toml");
    await writeFile(userConfigPath, 'model = "user-model"\n', "utf8");

    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));

    expect(await readFile(userConfigPath, "utf8")).toBe('model = "user-model"\n');
    expect(await readFile(runtime.profilePath, "utf8")).toContain(
      'model_provider = "providerdock-abcdef0123456789abcdef0123456789"',
    );
    expect(await readFile(runtime.manifestPath, "utf8")).not.toContain("secret-value");

    await fixture.manager.cleanup(runtime);

    expect(await readFile(userConfigPath, "utf8")).toBe('model = "user-model"\n');
    await expect(access(runtime.profilePath)).rejects.toThrow();
    await expect(access(runtime.sessionDirectory)).rejects.toThrow();
  });

  it("recovers a stale ready session only when the checksum still matches", async () => {
    const fixture = await createFixture();
    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));

    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      { sessionId, status: "RECOVERED" },
    ]);
    await expect(access(runtime.profilePath)).rejects.toThrow();
  });

  it("recovers a manifest when the temporary profile is already missing", async () => {
    const fixture = await createFixture();
    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));
    await import("node:fs/promises").then(({ unlink }) => unlink(runtime.profilePath));

    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      { sessionId, status: "RECOVERED" },
    ]);
    await expect(access(runtime.sessionDirectory)).rejects.toThrow();
  });

  it("keeps recovery compatibility with version 1 runtime manifests", async () => {
    const fixture = await createFixture();
    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));
    const current = JSON.parse(await readFile(runtime.manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete current.route;
    current.version = 1;
    await writeFile(runtime.manifestPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");

    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      { sessionId, status: "RECOVERED" },
    ]);
    await expect(access(runtime.profilePath)).rejects.toThrow();
  });

  it("preserves a changed temporary profile and reports a conflict", async () => {
    const fixture = await createFixture();
    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));
    await writeFile(runtime.profilePath, "user changed this file\n", "utf8");

    const outcomes = await fixture.manager.recoverStaleSessions();

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ sessionId, status: "CONFLICT" });
    expect(await readFile(runtime.profilePath, "utf8")).toBe("user changed this file\n");
    expect(await readFile(runtime.manifestPath, "utf8")).toContain(sessionId);
  });

  it("does not recover a session whose recorded process is still alive", async () => {
    const fixture = await createFixture(() => true);
    const runtime = await fixture.manager.prepare(runtimeInput(fixture.projectDirectory));
    await fixture.manager.markActive(runtime, 4321);

    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      { sessionId, status: "ACTIVE", pid: 4321 },
    ]);
    expect(await readFile(runtime.profilePath, "utf8")).toContain("ProviderDock");
  });

  it("records managed bridge ownership and lifecycle state without credentials", async () => {
    const fixture = await createFixture(() => true);
    const runtime = await fixture.manager.prepare({
      ...runtimeInput(fixture.projectDirectory),
      route: { kind: "bridge", baseUrl: "http://127.0.0.1:45678/v1" },
      bridgeOwnership: "managed",
    });

    expect(runtime.bridge).toEqual({
      baseUrl: "http://127.0.0.1:45678/v1",
      ownership: "managed",
      state: "LISTENING",
    });
    expect(JSON.parse(await readFile(runtime.manifestPath, "utf8"))).toMatchObject({
      version: 2,
      state: "READY",
      route: {
        kind: "bridge",
        baseUrl: "http://127.0.0.1:45678/v1",
        ownership: "managed",
        state: "LISTENING",
      },
    });
    expect(await readFile(runtime.manifestPath, "utf8")).not.toContain("secret-value");

    await fixture.manager.markActive(runtime, 4567);
    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      {
        sessionId,
        status: "ACTIVE",
        pid: 4567,
        bridge: {
          baseUrl: "http://127.0.0.1:45678/v1",
          ownership: "managed",
          state: "ACTIVE",
        },
      },
    ]);
  });

  it("rejects non-loopback ownership claims before creating runtime files", async () => {
    const fixture = await createFixture();

    await expect(
      fixture.manager.prepare({
        ...runtimeInput(fixture.projectDirectory),
        route: { kind: "bridge", baseUrl: "https://external.example/v1" },
        bridgeOwnership: "managed",
      }),
    ).rejects.toBeInstanceOf(CodexRuntimeConfigurationError);
    await expect(access(join(fixture.runtimeRoot, sessionId))).rejects.toThrow();
  });

  it("preserves an active Codex session whose managed bridge disappeared", async () => {
    const fixture = await createFixture(() => true, async () => false);
    const runtime = await fixture.manager.prepare({
      ...runtimeInput(fixture.projectDirectory),
      route: { kind: "bridge", baseUrl: "http://127.0.0.1:45678/v1" },
      bridgeOwnership: "managed",
    });
    await fixture.manager.markActive(runtime, 4567);

    expect(await fixture.manager.recoverStaleSessions()).toEqual([
      {
        sessionId,
        status: "CONFLICT",
        message: expect.stringMatching(/managed bridge.*no longer reachable/i),
      },
    ]);
    expect(await readFile(runtime.profilePath, "utf8")).toContain("ProviderDock");
    expect(await readFile(runtime.manifestPath, "utf8")).toContain('"state": "ACTIVE"');
  });
});

describe("CodexLauncher", () => {
  it("launches with an isolated profile and cleans up after process exit", async () => {
    const fixture = await createFixture();
    const runner = new FakeProcessRunner();
    const launcher = new CodexLauncher(fixture.manager, runner);

    const exit = await launcher.launch({
      ...runtimeInput(fixture.projectDirectory),
      parentEnvironment: { PATH: "test-path" },
      executable: "codex-test",
      additionalArgs: ["--no-alt-screen"],
    });

    expect(exit).toEqual({ exitCode: 0, signal: null });
    expect(runner.request).toMatchObject({
      executable: "codex-test",
      cwd: fixture.projectDirectory,
    });
    expect(runner.request?.args).toEqual([
      "--strict-config",
      "--profile",
      `providerdock-${sessionId}`,
      "--no-alt-screen",
    ]);
    expect(runner.request?.environment.CODEX_HOME).toBe(fixture.codexHome);
    expect(runner.request?.environment.PATH).toBe("test-path");
    expect(Object.values(runner.request?.environment ?? {})).toContain("secret-value");
    await expect(access(join(fixture.codexHome, `providerdock-${sessionId}.config.toml`))).rejects.toThrow();
  });

  it("cleans the temporary profile when process start fails", async () => {
    const fixture = await createFixture();
    const launcher = new CodexLauncher(fixture.manager, {
      start: async () => {
        throw new Error("spawn failed");
      },
    });

    await expect(launcher.launch(runtimeInput(fixture.projectDirectory))).rejects.toThrow(
      "spawn failed",
    );
    await expect(
      access(join(fixture.codexHome, `providerdock-${sessionId}.config.toml`)),
    ).rejects.toThrow();
    await expect(access(join(fixture.runtimeRoot, sessionId))).rejects.toThrow();
  });

  it("automatically owns a bridge for query-authenticated Responses providers", async () => {
    const fixture = await createFixture();
    const lifecycle: string[] = [];
    const runner = new InspectingProcessRunner(fixture.runtimeRoot, lifecycle);
    const bridges = new FakeBridgeFactory(lifecycle);
    const launcher = new CodexLauncher(fixture.manager, runner, bridges);
    const profile = parseProviderProfile({
      id: "query-router",
      displayName: "Query Router",
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "query", parameterName: "key", secretRef: "API_KEY" },
    });

    const exit = await launcher.launch({
      profile,
      modelId: "model-x",
      projectDirectory: fixture.projectDirectory,
      route: { kind: "auto" },
      parentEnvironment: { PATH: "test-path" },
    });

    expect(exit).toEqual({ exitCode: 0, signal: null });
    expect(bridges.input).toEqual({
      profile,
      modelId: "model-x",
      sessionId,
    });
    expect(lifecycle).toEqual(["bridge:start", "codex:start", "codex:wait", "bridge:stop"]);
    expect(runner.configContents).toContain('base_url = "http://127.0.0.1:45678/v1"');
    expect(runner.configContents).not.toContain("secret-value");
    expect(Object.values(runner.request?.environment ?? {})).not.toContain("secret-value");
    expect(runner.manifestAtWait).toMatchObject({
      state: "ACTIVE",
      route: { kind: "bridge", ownership: "managed", state: "ACTIVE" },
    });
    await expect(access(join(fixture.runtimeRoot, sessionId))).rejects.toThrow();
  });

  it("stops an automatically started bridge when Codex process startup fails", async () => {
    const fixture = await createFixture();
    const lifecycle: string[] = [];
    const bridges = new FakeBridgeFactory(lifecycle);
    const launcher = new CodexLauncher(
      fixture.manager,
      {
        start: async () => {
          lifecycle.push("codex:start");
          throw new Error("spawn failed");
        },
      },
      bridges,
    );
    const profile = parseProviderProfile({
      id: "agentrouter",
      displayName: "AgentRouter",
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      adapterId: "agentrouter",
      auth: { kind: "bearer", secretRef: "API_KEY" },
    });

    await expect(
      launcher.launch({
        profile,
        modelId: "model-x",
        projectDirectory: fixture.projectDirectory,
        route: { kind: "auto" },
      }),
    ).rejects.toThrow("spawn failed");
    expect(lifecycle).toEqual(["bridge:start", "codex:start", "bridge:stop"]);
    await expect(access(join(fixture.runtimeRoot, sessionId))).rejects.toThrow();
  });

  it("rejects unsupported Anthropic translation before creating a bridge", async () => {
    const fixture = await createFixture();
    const bridges = new FakeBridgeFactory([]);
    const launcher = new CodexLauncher(fixture.manager, new FakeProcessRunner(), bridges);

    await expect(
      launcher.launch({
        profile: parseProviderProfile({
          id: "anthropic-router",
          displayName: "Anthropic Router",
          baseUrl: "https://example.test/v1",
          apiType: "anthropic-messages",
        }),
        modelId: "model-x",
        projectDirectory: fixture.projectDirectory,
        route: { kind: "auto" },
      }),
    ).rejects.toThrow(/cannot translate.*anthropic-messages/i);
    expect(bridges.input).toBeUndefined();
  });

  it("records but never owns an explicitly supplied external bridge", async () => {
    const fixture = await createFixture();
    const lifecycle: string[] = [];
    const runner = new InspectingProcessRunner(fixture.runtimeRoot, lifecycle);
    const bridges = new FakeBridgeFactory(lifecycle);
    const launcher = new CodexLauncher(fixture.manager, runner, bridges);

    await launcher.launch({
      profile: parseProviderProfile({
        id: "chat-router",
        displayName: "Chat Router",
        baseUrl: "https://example.test/v1",
        apiType: "openai-chat-completions",
        auth: { kind: "bearer", secretRef: "API_KEY" },
      }),
      modelId: "model-x",
      projectDirectory: fixture.projectDirectory,
      route: { kind: "bridge", baseUrl: "http://127.0.0.1:40000/v1" },
    });

    expect(bridges.input).toBeUndefined();
    expect(lifecycle).toEqual(["codex:start", "codex:wait"]);
    expect(runner.configContents).toContain('base_url = "http://127.0.0.1:40000/v1"');
    expect(runner.manifestAtWait).toMatchObject({
      route: { kind: "bridge", ownership: "external", state: "ACTIVE" },
    });
    expect(Object.values(runner.request?.environment ?? {})).not.toContain("secret-value");
  });
});

async function createFixture(
  isProcessAlive: (pid: number) => boolean = () => false,
  isBridgeAlive: (baseUrl: string) => Promise<boolean> = async () => true,
) {
  const root = await mkdtemp(join(tmpdir(), "provider-dock-codex-runtime-"));
  const codexHome = join(root, "codex-home");
  const runtimeRoot = join(root, "runtime");
  const projectDirectory = join(root, "project");
  await import("node:fs/promises").then(({ mkdir }) =>
    Promise.all([mkdir(codexHome), mkdir(projectDirectory)]),
  );
  const manager = new CodexRuntimeSessionManager({
    codexHome,
    runtimeRoot,
    secrets: new MemorySecretStore({ API_KEY: "secret-value" }),
    randomId: () => sessionId,
    now: () => new Date("2026-08-29T00:00:00.000Z"),
    isProcessAlive,
    isBridgeAlive,
  });
  return { root, codexHome, runtimeRoot, projectDirectory, manager };
}

function runtimeInput(projectDirectory: string) {
  return {
    profile: parseProviderProfile({
      id: "router",
      displayName: "ProviderDock Test Router",
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "API_KEY" },
    }),
    modelId: "model-x",
    projectDirectory,
    route: { kind: "direct" as const },
  };
}

class FakeProcessRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;

  async start(request: CodexProcessStartRequest): Promise<RunningCodexProcess> {
    this.request = request;
    return { pid: 4321, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

class InspectingProcessRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;
  configContents: string | undefined;
  manifestAtWait: Record<string, unknown> | undefined;

  constructor(
    private readonly runtimeRoot: string,
    private readonly lifecycle: string[],
  ) {}

  async start(request: CodexProcessStartRequest): Promise<RunningCodexProcess> {
    this.lifecycle.push("codex:start");
    this.request = request;
    const profileName = request.args[2];
    const codexHome = request.environment.CODEX_HOME;
    if (profileName === undefined || codexHome === undefined) {
      throw new Error("Codex test process did not receive its runtime profile.");
    }
    this.configContents = await readFile(join(codexHome, `${profileName}.config.toml`), "utf8");
    return {
      pid: 4321,
      wait: async () => {
        this.lifecycle.push("codex:wait");
        this.manifestAtWait = JSON.parse(
          await readFile(join(this.runtimeRoot, sessionId, "manifest.json"), "utf8"),
        ) as Record<string, unknown>;
        return { exitCode: 0, signal: null };
      },
    };
  }
}

class FakeBridgeFactory implements CodexBridgeFactory {
  input: CreateCodexBridgeInput | undefined;

  constructor(private readonly lifecycle: string[]) {}

  create(input: CreateCodexBridgeInput): ManagedCodexBridge {
    this.input = input;
    let stopped = false;
    return {
      start: async () => {
        this.lifecycle.push("bridge:start");
        return {
          host: "127.0.0.1",
          port: 45678,
          url: "http://127.0.0.1:45678",
          baseUrl: "http://127.0.0.1:45678/v1",
        };
      },
      stop: async () => {
        if (stopped) return;
        stopped = true;
        this.lifecycle.push("bridge:stop");
      },
    };
  }
}
