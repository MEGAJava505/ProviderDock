import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CodexLauncher,
  CodexRuntimeSessionManager,
  MemorySecretStore,
  parseProviderProfile,
  type CodexProcessRunner,
  type CodexProcessStartRequest,
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
});

async function createFixture(isProcessAlive: (pid: number) => boolean = () => false) {
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
