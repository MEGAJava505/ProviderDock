import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AgentSessionHomeManager,
  ClaudeLauncher,
  claudeAgentSessionLayout,
  MemoryLogicalModelRepository,
  MemoryProviderProfileRepository,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type ClaudeBridgeFactory,
  type ClaudeProcessRunner,
  type ClaudeProcessStartRequest,
  type CliIo,
  type CreateClaudeBridgeInput,
} from "../src/index.js";

describe("Claude management CLI", () => {
  it("launches a logical model through the managed fallback bridge and reports switches", async () => {
    const fixture = await createCliFixture();
    await fixture.application.setProvider({
      id: "primary",
      displayName: "Primary",
      baseUrl: "https://primary.example.test/v1",
      apiType: "anthropic-messages",
    });
    await fixture.application.setProvider({
      id: "secondary",
      displayName: "Secondary",
      baseUrl: "https://secondary.example.test/v1",
      apiType: "openai-chat-completions",
    });
    await fixture.application.setLogicalModel({
      id: "logical-claude",
      routes: [
        { providerId: "primary", modelId: "primary-model", priority: 100 },
        { providerId: "secondary", modelId: "secondary-model", priority: 90 },
      ],
    });

    const result = await runCli(fixture.application, [
      "launch",
      "claude",
      "--logical-model",
      "logical-claude",
      "--project",
      fixture.projectDirectory,
      "--executable",
      "claude-test",
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [
        "ProviderDock fallback: primary/primary-model -> secondary/secondary-model (NETWORK_ERROR).",
      ],
    });
    expect(fixture.bridges.input).toMatchObject({
      modelId: "logical-claude",
      fallback: {
        logicalModel: { id: "logical-claude" },
        profiles: [{ id: "primary" }, { id: "secondary" }],
      },
    });
    expect(fixture.runner.request).toMatchObject({
      executable: "claude-test",
      cwd: fixture.projectDirectory,
      environment: { ANTHROPIC_MODEL: "logical-claude" },
    });
    expect(fixture.bridges.stopCount).toBe(1);
  });

  it("rejects mixing a logical model with a physical provider or model", async () => {
    const fixture = await createCliFixture();
    const result = await runCli(fixture.application, [
      "launch",
      "claude",
      "--logical-model",
      "logical-claude",
      "--provider",
      "primary",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result.code).toBe(1);
    expect(result.stderr).toEqual([
      "Error: --logical-model cannot be combined with --provider or --model.",
    ]);
    expect(fixture.bridges.input).toBeUndefined();
  });

  it("launches a prompt profile with injected instructions, flags, and fallback", async () => {
    const fixture = await createCliFixture();
    await fixture.application.setProvider({
      id: "primary",
      displayName: "Primary",
      baseUrl: "https://primary.example.test/v1",
      apiType: "anthropic-messages",
    });
    await fixture.application.setProvider({
      id: "secondary",
      displayName: "Secondary",
      baseUrl: "https://secondary.example.test/v1",
      apiType: "openai-chat-completions",
    });
    await fixture.application.setLogicalModel({
      id: "logical-claude",
      routes: [
        { providerId: "primary", modelId: "primary-model", priority: 100 },
        { providerId: "secondary", modelId: "secondary-model", priority: 90 },
      ],
    });
    await fixture.application.setPromptProfile({
      id: "review",
      name: "Review",
      instructions: "Review all affected invariants.",
      preferredLogicalModelId: "logical-claude",
      preferredClient: "claude-code",
      fallbackPolicy: "logical-model",
      clientFlags: { claudeCode: ["--verbose"] },
    });

    const result = await runCli(fixture.application, [
      "launch",
      "claude",
      "--prompt-profile",
      "review",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [
        "ProviderDock fallback: primary/primary-model -> secondary/secondary-model (NETWORK_ERROR).",
      ],
    });
    expect(fixture.bridges.input).toMatchObject({
      modelId: "logical-claude",
      sessionInstructions: "Review all affected invariants.",
      fallback: { logicalModel: { id: "logical-claude" } },
    });
    expect(fixture.runner.request?.args).toEqual(["--permission-mode", "manual", "--verbose"]);
    expect(fixture.runner.request?.environment.ANTHROPIC_MODEL).toBe(
      "logical-claude",
    );
  });

  it("uses an exact project profile when no route selector is provided", async () => {
    const fixture = await createCliFixture();
    await fixture.application.setProvider({
      id: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://anthropic.example.test/v1",
      apiType: "anthropic-messages",
    });
    await fixture.application.setPromptProfile({
      id: "project-default",
      name: "Project Default",
      instructions: "Use this project's conventions.",
      preferredProviderId: "anthropic",
      preferredModelId: "claude-x",
      preferredClient: "claude-code",
      fallbackPolicy: "disabled",
    });
    await fixture.application.setProjectProfile({
      projectDirectory: fixture.projectDirectory,
      promptProfileId: "project-default",
    });

    const result = await runCli(fixture.application, [
      "launch",
      "claude",
      "--project",
      fixture.projectDirectory,
    ]);

    expect(result).toMatchObject({
      code: 0,
      stdout: ["Claude Code session finished with exit code 0."],
      stderr: [],
    });
    expect(fixture.bridges.input).toMatchObject({
      profile: { id: "anthropic" },
      modelId: "claude-x",
      sessionInstructions: "Use this project's conventions.",
    });
    expect(fixture.bridges.input?.fallback).toBeUndefined();
  });
});

async function createCliFixture() {
  const root = await mkdtemp(join(tmpdir(), "provider-dock-claude-cli-"));
  const projectDirectory = join(root, "project");
  await mkdir(projectDirectory);
  const runner = new FakeClaudeProcessRunner();
  const bridges = new RecordingClaudeBridgeFactory();
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    undefined,
    undefined,
    undefined,
    undefined,
    new ClaudeLauncher(
      bridges,
      runner,
      new AgentSessionHomeManager({
        rootDirectory: join(root, "claude-home"),
        layout: claudeAgentSessionLayout,
      }),
    ),
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

class FakeClaudeProcessRunner implements ClaudeProcessRunner {
  request: ClaudeProcessStartRequest | undefined;

  async start(request: ClaudeProcessStartRequest) {
    this.request = request;
    return { pid: 6543, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

class RecordingClaudeBridgeFactory implements ClaudeBridgeFactory {
  input: CreateClaudeBridgeInput | undefined;
  stopCount = 0;

  create(input: CreateClaudeBridgeInput) {
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
          port: 45679,
          url: "http://127.0.0.1:45679",
        };
      },
      stop: async () => {
        this.stopCount += 1;
      },
    };
  }
}
