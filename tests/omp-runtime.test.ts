import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createOmpPilotPolicy, OmpRuntime, type OmpRuntimeSelection } from "../src/clients/omp/omp-runtime.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { ompConfigSchemaCommit } from "../src/clients/omp/omp-config-compiler.js";
import { createOmpRuntimePaths } from "../src/clients/omp/omp-runtime-paths.js";
import { providerSecretRevisionFingerprint } from "../src/core/security/secret-revision.js";
import { fingerprintOmpProviderProfile } from "../src/migration/omp-provider-mapping.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "dock-omp-runtime-"));
  directories.push(root);
  const executable = join(root, "omp.exe");
  const bytes = Buffer.from("verified fixture artifact; never executed");
  await writeFile(executable, bytes);
  const projectDirectory = join(root, "проект с пробелами");
  await mkdir(projectDirectory);
  const artifact = {
    executable, sha256: createHash("sha256").update(bytes).digest("hex"),
    sourceCommit: ompConfigSchemaCommit,
  };
  const secretStore = { get: vi.fn(async () => "fixture-secret-never-persist") };
  const options = {
    rootDirectory: join(root, "managed"), artifact, secretStore,
    ambientEnvironment: {
      PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT,
      OPENAI_API_KEY: "ambient-secret", NODE_OPTIONS: "--require=evil",
      PI_CODING_AGENT_DIR: "old-home", USERPROFILE: root, HOME: root,
      HTTPS_PROXY: "http://unapproved-proxy.invalid", CODEX_HOME: "old-codex",
    },
  };
  const selection: OmpRuntimeSelection = {
    route: {
      profile: parseProviderProfile({
        id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1",
        apiType: "openai-chat-completions", auth: { kind: "bearer", secretRef: "fixture.key" },
      }),
      accountId: "chosen-account", allowedOrigins: ["https://fixture.invalid"],
      models: [{ id: "literal/model:one", contextWindow: 8192, maxTokens: 256 }],
    },
    projectDirectory, mode: "tui", permissionAcknowledgement: "read-only-pilot-no-sandbox",
  };
  return { root, options, selection, runtime: new OmpRuntime(options), secretStore };
}

describe("managed OMP runtime preflight and preparation", () => {
  it("disables keyless built-in catalog discovery in the isolated pilot", () => {
    expect(createOmpPilotPolicy().disabledProviders).toEqual(
      expect.arrayContaining(["google-vertex", "lm-studio", "ollama", "zenmux"]),
    );
  });

  it("rejects a route whose active profile binding changed after selection", async () => {
    const f = await fixture();
    const expectedProfileSha256 = fingerprintOmpProviderProfile(f.selection.route.profile);
    let currentProfileSha256 = expectedProfileSha256;
    const runtime = new OmpRuntime({ ...f.options,
      currentProfileFingerprint: async () => currentProfileSha256 });
    const selection = { ...f.selection, expectedProfileSha256 };
    expect(await runtime.preflight(selection)).toMatchObject({ ok: true });
    currentProfileSha256 = "f".repeat(64);
    expect(await runtime.preflight(selection)).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    await expect(runtime.prepare(randomUUID(), selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
  });
  it("rejects a credential rotated after route selection but before OMP preparation", async () => {
    const f = await fixture();
    let revision = "a".repeat(64);
    const secretStore = {
      revision: async () => revision,
      get: vi.fn(async () => { revision = "b".repeat(64); return "untested-new-secret"; }),
    };
    const expectedCredentialFingerprint = await providerSecretRevisionFingerprint(f.selection.route.profile, secretStore);
    const runtime = new OmpRuntime({ ...f.options, secretStore });
    const selection = { ...f.selection, expectedCredentialFingerprint };
    expect(await runtime.preflight(selection)).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    revision = "a".repeat(64);
    await expect(runtime.prepare(randomUUID(), selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
    expect(await readdir(f.root)).not.toContain("managed");
  });
  it("preflights without launching, writing files, or exposing credentials", async () => {
    const f = await fixture();
    const result = await f.runtime.preflight(f.selection);
    expect(result).toMatchObject({ ok: true, modelId: "literal/model:one", api: "openai-completions" });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    expect(f.secretStore.get).toHaveBeenCalledExactlyOnceWith("fixture.key");
    expect(await readdir(f.root)).toEqual(expect.arrayContaining(["omp.exe", "проект с пробелами"]));
    expect(await readdir(f.root)).not.toContain("managed");
  });

  it.each([
    ["missing executable", "EXECUTABLE_NOT_FOUND", (f: Awaited<ReturnType<typeof fixture>>) => { f.options.artifact.executable += ".missing"; }],
    ["wrong checksum", "OMP_ARTIFACT_MISMATCH", (f: Awaited<ReturnType<typeof fixture>>) => { f.options.artifact.sha256 = "0".repeat(64); }],
    ["wrong pin", "OMP_ARTIFACT_MISMATCH", (f: Awaited<ReturnType<typeof fixture>>) => { f.options.artifact.sourceCommit = "0".repeat(40); }],
  ])("rejects %s before reading the vault", async (_name, code, mutate) => {
    const f = await fixture();
    mutate(f);
    const runtime = new OmpRuntime(f.options);
    expect(await runtime.preflight(f.selection)).toMatchObject({ ok: false, diagnostic: { code } });
    expect(f.secretStore.get).not.toHaveBeenCalled();
  });

  it("requires new permission acknowledgement instead of adopting legacy approvals", async () => {
    const f = await fixture();
    const result = await f.runtime.preflight({ ...f.selection, permissionAcknowledgement: undefined });
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_PERMISSION_CONFIRMATION_REQUIRED" } });
    expect(f.secretStore.get).not.toHaveBeenCalled();
  });

  it("classifies missing cwd, ambiguous model and unresolved protocol locally", async () => {
    const f = await fixture();
    expect(await f.runtime.preflight({ ...f.selection, projectDirectory: join(f.root, "missing") }))
      .toMatchObject({ ok: false, diagnostic: { code: "PROJECT_DIRECTORY_UNAVAILABLE" } });
    expect(await f.runtime.preflight({
      ...f.selection, route: { ...f.selection.route, models: [...f.selection.route.models, { id: "second" }] },
    })).toMatchObject({ ok: false, diagnostic: { code: "OMP_CONFIG_INVALID" } });
    expect(await f.runtime.preflight({
      ...f.selection, route: { ...f.selection.route, profile: { ...f.selection.route.profile, apiType: "auto" } },
    })).toMatchObject({ ok: false, diagnostic: { code: "PROTOCOL_UNRESOLVED" } });
    expect(f.secretStore.get).not.toHaveBeenCalled();
  });

  it("redacts vault errors and never falls back to ambient credentials", async () => {
    const f = await fixture();
    f.secretStore.get.mockRejectedValue(new Error("fixture-secret in private failure"));
    const result = await f.runtime.preflight(f.selection);
    expect(result).toMatchObject({ ok: false, diagnostic: { stage: "credentials", code: "CREDENTIAL_UNAVAILABLE" } });
    expect(JSON.stringify(result)).not.toContain("fixture-secret");
    f.secretStore.get.mockResolvedValue(undefined as unknown as string);
    expect(await f.runtime.preflight(f.selection)).toMatchObject({ ok: false, diagnostic: { code: "CREDENTIAL_MISSING" } });
  });

  it("creates isolated non-secret config with only selected child credentials and safe pilot flags", async () => {
    const f = await fixture();
    const prepared = await f.runtime.prepare(randomUUID(), f.selection);
    expect(prepared.executable).toBe(f.options.artifact.executable);
    expect(prepared.cwd).toBe(f.selection.projectDirectory);
    expect(prepared.args).toEqual(expect.arrayContaining([
      "--approval-mode", "always-ask", "--tools", "read",
      "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-title",
    ]));
    expect(prepared.args.join(" ")).not.toMatch(/secret|--api-key|codex|claude/);
    expect(prepared.environment.OPENAI_API_KEY).toBeUndefined();
    expect(prepared.environment.NODE_OPTIONS).toBeUndefined();
    expect(prepared.environment.HTTPS_PROXY).toBeUndefined();
    expect(prepared.environment.CODEX_HOME).toBeUndefined();
    expect(prepared.environment.PI_CONFIG_DIR).toBe("config");
    expect(prepared.environment.USERPROFILE).toBe(prepared.homeDirectory);
    expect(prepared.environment.HOME).toBe(prepared.homeDirectory);
    expect(prepared.environment.PI_CODING_AGENT_DIR).toBe(prepared.agentDirectory);
    expect(prepared.environment.XDG_DATA_HOME).toBe(join(prepared.homeDirectory, "xdg-data"));
    const selectedVars = Object.entries(prepared.environment).filter(([key]) => key.startsWith("PROVIDERDOCK_OMP_"));
    expect(selectedVars).toHaveLength(1);
    expect(selectedVars[0]![1]).toBe("fixture-secret-never-persist");
    const models = await readFile(join(prepared.agentDirectory, "models.yml"), "utf8");
    const policy = await readFile(join(prepared.agentDirectory, "config.yml"), "utf8");
    expect(models + policy).not.toContain("fixture-secret-never-persist");
    expect(models).toContain(selectedVars[0]![0]);
    expect(JSON.parse(policy)).toMatchObject({
      retry: { enabled: false }, mcp: { enableProjectConfig: false },
      fetch: { enabled: false },
      startup: { setupWizard: false, checkUpdate: false, showSplash: false },
      tools: { approvalMode: "always-ask", approval: { task: "deny", eval: "deny", browser: "deny", computer: "deny" } },
    });
    expect(JSON.parse(policy)).not.toHaveProperty("update");
    expect(await readdir(join(prepared.homeDirectory, "xdg-data"))).toContain("omp");
  });

  it("makes per-run immutable configs but provider/account-scoped session storage", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const first = await f.runtime.prepare(runId, f.selection);
    const second = await f.runtime.prepare(randomUUID(), { ...f.selection, mode: "rpc" });
    expect(first.agentDirectory).not.toBe(second.agentDirectory);
    expect(first.sessionsDirectory).toBe(second.sessionsDirectory);
    expect(second.args).toEqual(expect.arrayContaining(["--mode", "rpc"]));
    await expect(f.runtime.prepare(runId, f.selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_RUNTIME_DIRECTORY_UNAVAILABLE" },
    });
    await expect(f.runtime.prepare("../escape", f.selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_CONFIG_INVALID" },
    });
  });

  it("rejects a symlinked managed root without writing through it", async () => {
    const f = await fixture();
    const target = join(f.root, "elsewhere");
    await mkdir(target);
    await symlink(target, f.options.rootDirectory, process.platform === "win32" ? "junction" : "dir");
    expect(await f.runtime.preflight(f.selection)).toMatchObject({
      ok: false, diagnostic: { code: "OMP_RUNTIME_DIRECTORY_UNAVAILABLE" },
    });
    expect(await readdir(target)).toEqual([]);
  });

  it("rehashes the executable at prepare time to catch drift after preflight", async () => {
    const f = await fixture();
    expect(await f.runtime.preflight(f.selection)).toMatchObject({ ok: true });
    await writeFile(f.options.artifact.executable, "changed artifact");
    await expect(f.runtime.prepare(randomUUID(), f.selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_ARTIFACT_MISMATCH" },
    });
  });

  it.each([
    [".omp/config.yml", '{"speechgen":{"enabled":true},"tools":{"approval":{"tts":"allow"}}}'],
    [".omp/config.yml", "["],
    [".env", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.local", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.development", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.development.local", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.production", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.production.local", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.test", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.test.local", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".env.staging.local", "OMP_TEST_SECRET=must-not-be-loaded"],
    [".omp/settings.json", '{"tools":{"approval":{"tts":"allow"}}}'],
    [".claude/settings.json", "{}"],
    [".claude/settings.local.json", "{}"],
    [".codex/config.toml", "model = 'inherited'"],
    [".cursor/settings.json", "{}"],
    [".gemini/settings.json", "{}"],
    ["opencode.json", "{}"],
    ["opencode.jsonc", "{}"],
    [".opencode/opencode.json", "{}"],
    [".opencode/opencode.jsonc", "{}"],
  ])("refuses unreviewed bootstrap settings %s without loading or quarantining them", async (relative, bytes) => {
    const f = await fixture();
    const path = join(f.selection.projectDirectory, relative);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    expect(await f.runtime.preflight(f.selection)).toMatchObject({
      ok: false, diagnostic: { code: "OMP_PROJECT_SETTINGS_UNREVIEWED" },
    });
    await expect(f.runtime.prepare(randomUUID(), f.selection)).rejects.toMatchObject({
      diagnostic: { code: "OMP_PROJECT_SETTINGS_UNREVIEWED" },
    });
    expect(await readFile(path, "utf8")).toBe(bytes);
    expect((await readdir(dirname(path))).filter(name => name.includes(".broken-"))).toEqual([]);
    expect(f.secretStore.get).not.toHaveBeenCalled();
    expect(await readdir(f.root)).not.toContain("managed");
  });

  it.each(["scope-file", "runs-file", "sessions-junction"])("rejects known unusable storage %s in preflight", async (kind) => {
    const f = await fixture();
    const paths = createOmpRuntimePaths({
      rootDirectory: f.options.rootDirectory, providerId: "fixture", accountId: "chosen-account",
    });
    if (kind === "scope-file") {
      await mkdir(dirname(paths.scopeDirectory), { recursive: true });
      await writeFile(paths.scopeDirectory, "not a directory");
    } else if (kind === "runs-file") {
      await mkdir(paths.scopeDirectory, { recursive: true });
      await writeFile(join(paths.scopeDirectory, "runs"), "not a directory");
    } else {
      await mkdir(paths.agentDirectory, { recursive: true });
      const target = join(f.root, "unrelated-sessions");
      await mkdir(target);
      await symlink(target, paths.sessionsDirectory, process.platform === "win32" ? "junction" : "dir");
    }
    expect(await f.runtime.preflight(f.selection)).toMatchObject({
      ok: false, diagnostic: { code: "OMP_RUNTIME_DIRECTORY_UNAVAILABLE" },
    });
    expect(f.secretStore.get).not.toHaveBeenCalled();
  });
});
