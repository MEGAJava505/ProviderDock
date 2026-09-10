import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentSessionHomeManager,
  ClaudeLauncher,
  claudeAgentSessionLayout,
  CodexLauncher,
  CodexRuntimeSessionManager,
  MemoryLogicalModelRepository,
  MemoryProjectProfileRepository,
  MemoryPromptProfileRepository,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type ClaudeBridgeFactory,
  type ClaudeProcessRunner,
  type ClaudeProcessStartRequest,
  type CliIo,
  type CodexBridgeFactory,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
  type CreateClaudeBridgeInput,
} from "../src/index.js";

const sessionId = "33333333333333333333333333333333";

describe("automatic client CLI launch", () => {
  it("selects Codex for a Responses provider", async () => {
    const fixture = await createFixture();
    await fixture.application.setProvider({
      id: "responses",
      displayName: "Responses",
      baseUrl: "https://responses.example.test/v1",
      apiType: "openai-responses",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "auto",
      "--provider",
      "responses",
      "--model",
      "gpt-x",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Codex session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.codexRunner.request).toBeDefined();
    expect(fixture.claudeRunner.request).toBeUndefined();
  });

  it("selects Claude Code for an Anthropic Messages provider", async () => {
    const fixture = await createFixture();
    await fixture.application.setProvider({
      id: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://anthropic.example.test/v1",
      apiType: "anthropic-messages",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "auto",
      "--provider",
      "anthropic",
      "--model",
      "claude-x",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.claudeRunner.request?.environment.ANTHROPIC_MODEL).toBe(
      "claude-x",
    );
    expect(fixture.codexRunner.request).toBeUndefined();
  });

  it("honors a prompt preferred-client override through project defaults", async () => {
    const fixture = await createFixture();
    await fixture.application.setProvider({
      id: "chat",
      displayName: "Chat",
      baseUrl: "https://chat.example.test/v1",
      apiType: "openai-chat-completions",
    });
    await fixture.application.setPromptProfile({
      id: "claude-project",
      name: "Claude Project",
      instructions: "Use the project review workflow.",
      preferredProviderId: "chat",
      preferredModelId: "chat-model",
      preferredClient: "claude-code",
      fallbackPolicy: "disabled",
    });
    await fixture.application.setProjectProfile({
      projectDirectory: fixture.projectDirectory,
      promptProfileId: "claude-project",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "auto",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.claudeBridges.input).toMatchObject({
      profile: { id: "chat" },
      modelId: "chat-model",
      sessionInstructions: "Use the project review workflow.",
    });
    expect(fixture.codexRunner.request).toBeUndefined();
  });

  it("uses measured per-model compatibility before the protocol heuristic", async () => {
    const fixture = await createFixture();
    await fixture.application.setProvider({
      id: "measured",
      displayName: "Measured",
      baseUrl: "https://measured.example.test/v1",
      apiType: "openai-responses",
    });
    await fixture.health.recordDiagnostics({
      providerId: "measured",
      modelId: "gpt-x",
      checkedAt: "2026-08-30T10:00:00.000Z",
      doctorLevel: 3,
      verdict: "PASS",
      capabilities: {
        text: "SUPPORTED",
        streaming: "SUPPORTED",
        tools: "SUPPORTED",
        parallel_tools: "UNKNOWN",
        reasoning: "UNKNOWN",
        images: "UNKNOWN",
        web_search: "UNKNOWN",
        long_context: "UNKNOWN",
        usage: "UNKNOWN",
        cancellation: "UNKNOWN",
        model_discovery: "SUPPORTED",
      },
      codexCompatibility: "INCOMPATIBLE",
      claudeCompatibility: "ADAPTER",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "auto",
      "--provider",
      "measured",
      "--model",
      "gpt-x",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.claudeRunner.request).toBeDefined();
    expect(fixture.codexRunner.request).toBeUndefined();
  });

  it("keeps an explicit provider client preference authoritative", async () => {
    const fixture = await createFixture();
    await fixture.application.setProvider({
      id: "forced-codex",
      displayName: "Forced Codex",
      baseUrl: "https://forced.example.test/v1",
      apiType: "openai-chat-completions",
      preferredClient: "codex",
    });
    await fixture.health.recordDiagnostics({
      providerId: "forced-codex",
      modelId: "chat-model",
      checkedAt: "2026-08-30T10:00:00.000Z",
      doctorLevel: 3,
      verdict: "PASS",
      capabilities: {
        text: "SUPPORTED",
        streaming: "SUPPORTED",
        tools: "SUPPORTED",
        parallel_tools: "UNKNOWN",
        reasoning: "UNKNOWN",
        images: "UNKNOWN",
        web_search: "UNKNOWN",
        long_context: "UNKNOWN",
        usage: "UNKNOWN",
        cancellation: "UNKNOWN",
        model_discovery: "SUPPORTED",
      },
      codexCompatibility: "INCOMPATIBLE",
      claudeCompatibility: "ADAPTER",
    });

    expect(
      await fixture.application.resolveProviderClient(
        "forced-codex",
        "chat-model",
      ),
    ).toBe("codex");
  });
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "provider-dock-auto-cli-"));
  const projectDirectory = join(root, "project");
  const codexHome = join(root, "codex-home");
  await Promise.all([mkdir(projectDirectory), mkdir(codexHome)]);
  const secrets = new MemorySecretStore();
  const codexRunner = new RecordingCodexRunner();
  const claudeRunner = new RecordingClaudeRunner();
  const claudeBridges = new RecordingClaudeBridgeFactory();
  const health = new MemoryProviderHealthRepository();
  const codexLauncher = new CodexLauncher(
    new CodexRuntimeSessionManager({
      codexHome,
      runtimeRoot: join(root, "runtime", "codex"),
      secrets,
      randomId: () => sessionId,
      isProcessAlive: () => false,
    }),
    codexRunner,
    new NoopCodexBridgeFactory(),
  );
  const claudeSessionHomes = new AgentSessionHomeManager({
    rootDirectory: join(root, "claude-home"),
    layout: claudeAgentSessionLayout,
  });
  const claudeLauncher = new ClaudeLauncher(claudeBridges, claudeRunner, claudeSessionHomes);
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    secrets,
    codexLauncher,
    undefined,
    undefined,
    claudeLauncher,
    new MemoryLogicalModelRepository(),
    new MemoryPromptProfileRepository(),
    new MemoryProjectProfileRepository(),
    health,
  );
  return {
    application,
    codexRunner,
    claudeRunner,
    claudeBridges,
    health,
    projectDirectory,
  };
}

async function runCli(
  application: ProviderDockApplication,
  argv: string[],
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const code = await runProviderDockCli(argv, {
    application,
    io,
    environment: {},
  });
  return { code, stdout, stderr };
}

class RecordingCodexRunner implements CodexProcessRunner {
  request: CodexProcessStartRequest | undefined;

  async start(request: CodexProcessStartRequest) {
    this.request = request;
    return { pid: 7654, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

class RecordingClaudeRunner implements ClaudeProcessRunner {
  request: ClaudeProcessStartRequest | undefined;

  async start(request: ClaudeProcessStartRequest) {
    this.request = request;
    return { pid: 7655, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

class NoopCodexBridgeFactory implements CodexBridgeFactory {
  create() {
    return {
      start: async () => ({
        host: "127.0.0.1" as const,
        port: 45680,
        url: "http://127.0.0.1:45680",
        baseUrl: "http://127.0.0.1:45680/v1",
      }),
      stop: async () => undefined,
    };
  }
}

class RecordingClaudeBridgeFactory implements ClaudeBridgeFactory {
  input: CreateClaudeBridgeInput | undefined;

  create(input: CreateClaudeBridgeInput) {
    this.input = input;
    return {
      start: async () => ({
        host: "127.0.0.1" as const,
        port: 45681,
        url: "http://127.0.0.1:45681",
      }),
      stop: async () => undefined,
    };
  }
}
