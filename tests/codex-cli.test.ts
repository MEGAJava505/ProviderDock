import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeSessionManager,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type CliIo,
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
    expect(Object.values(fixture.runner.request?.environment ?? {})).toContain("secret-value");

    const recovery = await runCli(fixture.application, ["recover", "codex"]);
    expect(recovery).toMatchObject({ code: 0, stdout: ["No stale Codex sessions found."] });
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
  const application = new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    secrets,
    new CodexLauncher(sessions, runner),
  );
  return { application, runner, projectDirectory };
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
