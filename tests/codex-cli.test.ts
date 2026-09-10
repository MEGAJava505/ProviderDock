import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeSessionManager,
  MemoryLogicalModelRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type CliIo,
  type CodexBridgeFactory,
  type CreateCodexBridgeInput,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
} from "../src/index.js";

const sessionId = "11111111111111111111111111111111";

describe("Codex management CLI", () => {
  it("launches a configured provider through an isolated Codex profile", async () => {
    const fixture = await createCliFixture();
    await fixture.application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    });

    const result = await runCli(
      fixture.application,
      [
        "launch",
        "codex",
        "--provider",
        "router",
        "--model",
        "model-x",
        "--project",
        fixture.projectDirectory,
        "--executable",
        "codex-test",
      ],
      { PATH: "test-path" },
    );

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Codex session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.runner.request).toMatchObject({
      executable: "codex-test",
      cwd: fixture.projectDirectory,
      args: ["--strict-config", "--profile", `providerdock-${sessionId}`],
    });
    expect(Object.values(fixture.runner.request?.environment ?? {})).not.toContain("secret-value");
    expect(fixture.bridges.input?.profile.id).toBe("router");

    const recovery = await runCli(fixture.application, ["recover", "codex"]);
    expect(recovery).toMatchObject({ code: 0, stdout: ["No stale Codex sessions found."] });
  });

  it("launches a logical model through the managed fallback bridge and reports switches", async () => {
    const fixture = await createCliFixture();
    for (const id of ["primary", "secondary"]) {
      await fixture.application.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
        apiType: "openai-responses",
      });
    }
    await fixture.application.setLogicalModel({
      id: "logical-x",
      routes: [
        { providerId: "primary", modelId: "primary-model", priority: 100 },
        { providerId: "secondary", modelId: "secondary-model", priority: 90 },
      ],
    });

    const result = await runCli(fixture.application, [
      "launch",
      "codex",
      "--logical-model",
      "logical-x",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Codex session finished with exit code 0."],
      stderr: [
        "ProviderDock fallback: primary/primary-model -> secondary/secondary-model (NETWORK_ERROR).",
      ],
    });
    expect(fixture.bridges.input).toMatchObject({
      modelId: "logical-x",
      fallback: {
        logicalModel: { id: "logical-x" },
        profiles: [{ id: "primary" }, { id: "secondary" }],
      },
    });
    expect(fixture.bridges.stopCount).toBe(1);
  });

  it("launches project defaults with injected instructions, reasoning, flags, and fallback", async () => {
    const fixture = await createCliFixture();
    for (const id of ["primary", "secondary"]) {
      await fixture.application.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
        apiType: "openai-responses",
      });
    }
    await fixture.application.setLogicalModel({
      id: "logical-x",
      routes: [
        { providerId: "primary", modelId: "primary-model", priority: 100 },
        { providerId: "secondary", modelId: "secondary-model", priority: 90 },
      ],
    });
    await fixture.application.setPromptProfile({
      id: "practical",
      name: "Practical Coding",
      instructions: "Inspect the implementation before changing it.",
      preferredLogicalModelId: "logical-x",
      preferredClient: "codex",
      reasoningLevel: "xhigh",
      fallbackPolicy: "logical-model",
      clientFlags: { codex: ["--no-alt-screen"] },
    });
    await fixture.application.setProjectProfile({
      projectDirectory: fixture.projectDirectory,
      promptProfileId: "practical",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "codex",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Codex session finished with exit code 0."],
      stderr: [
        "ProviderDock fallback: primary/primary-model -> secondary/secondary-model (NETWORK_ERROR).",
      ],
    });
    expect(fixture.bridges.input).toMatchObject({
      modelId: "logical-x",
      sessionInstructions: "Inspect the implementation before changing it.",
      defaultReasoningLevel: "xhigh",
      fallback: { logicalModel: { id: "logical-x" } },
    });
    expect(fixture.runner.request?.args).toEqual([
      "--strict-config",
      "--profile",
      `providerdock-${sessionId}`,
      "--no-alt-screen",
    ]);
  });
});

async function createCliFixture() {
  const root = await mkdtemp(join(tmpdir(), "provider-dock-codex-cli-"));
  const projectDirectory = join(root, "project");
  const codexHome = join(root, "codex-home");
  await Promise.all([mkdir(projectDirectory), mkdir(codexHome)]);
  const secrets = new MemorySecretStore({ ROUTER_KEY: "secret-value" });
  const sessions = new CodexRuntimeSessionManager({
    codexHome,
    runtimeRoot: join(root, "runtime"),
    secrets,
    randomId: () => sessionId,
    isProcessAlive: () => false,
  });
  const runner = new FakeProcessRunner();
  const bridges = new RecordingBridgeFactory();
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    secrets,
    new CodexLauncher(sessions, runner, bridges),
    undefined,
    undefined,
    undefined,
    new MemoryLogicalModelRepository(),
  );
  return { application, runner, bridges, projectDirectory };
}

async function runCli(
  application: ProviderDockApplication,
  argv: string[],
  environment: NodeJS.ProcessEnv = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const code = await runProviderDockCli(argv, { application, io, environment });
  return { code, stdout, stderr };
}

class FakeProcessRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;

  async start(request: CodexProcessStartRequest) {
    this.request = request;
    return { pid: 5432, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

class RecordingBridgeFactory implements CodexBridgeFactory {
  input: CreateCodexBridgeInput | undefined;
  stopCount = 0;

  create(input: CreateCodexBridgeInput) {
    this.input = input;
    return {
      start: async () => {
        const [from, to] = input.fallback?.logicalModel.routes ?? [];
        if (from !== undefined && to !== undefined) {
          input.onFallback?.({
            kind: "FALLBACK",
            logicalModelId: input.fallback?.logicalModel.id ?? input.modelId,
            from,
            to,
            errorType: "NETWORK_ERROR",
            phase: "connection-failed",
            message: "Primary connection failed.",
          });
        }
        return {
          host: "127.0.0.1" as const,
          port: 45678,
          url: "http://127.0.0.1:45678",
          baseUrl: "http://127.0.0.1:45678/v1",
        };
      },
      stop: async () => {
        this.stopCount += 1;
      },
    };
  }
}
