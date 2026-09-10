import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MemoryLogicalModelRepository,
  MemoryProjectProfileRepository,
  MemoryPromptProfileRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProfileBundleConflictError,
  ProfileBundleImportError,
  ProfileBundleValidationError,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  runProviderDockCli,
  type CliIo,
  type ProviderProfile,
  type ProviderProfileInput,
  type ProviderProfileRepository,
} from "../src/index.js";

describe("profile bundles", () => {
  it("round-trips all configuration profiles without exporting secret values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-bundle-"));
    const sourceSecrets = new MemorySecretStore({
      ROUTER_KEY: "actual-secret-value",
    });
    const source = createApplication({ secrets: sourceSecrets });
    await source.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    });
    await source.setLogicalModel({
      id: "gpt-x",
      routes: [{ providerId: "router", modelId: "gpt-x", priority: 100 }],
    });
    await source.setPromptProfile({
      id: "practical",
      name: "Practical",
      instructions: "Inspect the implementation first.",
      preferredProviderId: "router",
      preferredModelId: "gpt-x",
      preferredLogicalModelId: "gpt-x",
      fallbackPolicy: "logical-model",
    });
    await source.setProjectProfile({
      projectDirectory: join(directory, "project"),
      promptProfileId: "practical",
    });

    const bundle = await source.exportProfileBundle(
      new Date("2026-08-30T10:00:00.000Z"),
    );
    const serialized = JSON.stringify(bundle);
    expect(serialized).toContain("ROUTER_KEY");
    expect(serialized).not.toContain("actual-secret-value");

    const targetSecrets = new MemorySecretStore();
    const target = createApplication({ secrets: targetSecrets });
    await expect(target.importProfileBundle(bundle)).resolves.toEqual({
      providers: { created: 1, updated: 0 },
      logicalModels: { created: 1, updated: 0 },
      promptProfiles: { created: 1, updated: 0 },
      projectProfiles: { created: 1, updated: 0 },
    });
    expect(await target.getProvider("router")).toMatchObject({
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    });
    expect(await target.getLogicalModel("gpt-x")).toMatchObject({
      routes: [{ providerId: "router", modelId: "gpt-x" }],
    });
    expect(await target.getPromptProfile("practical")).toMatchObject({
      preferredLogicalModelId: "gpt-x",
    });
    expect(await target.getProjectProfile(join(directory, "project"))).toMatchObject({
      promptProfileId: "practical",
    });
    expect(await targetSecrets.listReferences()).toEqual([]);

    await expect(target.importProfileBundle(bundle)).rejects.toBeInstanceOf(
      ProfileBundleConflictError,
    );
    await target.setProvider({
      ...(await target.getProvider("router")),
      displayName: "Locally modified",
    });
    await expect(
      target.importProfileBundle(bundle, { overwrite: true }),
    ).resolves.toMatchObject({
      providers: { created: 0, updated: 1 },
    });
    expect((await target.getProvider("router")).displayName).toBe("Router");
  });

  it("rejects dangling references before mutating any repository", async () => {
    const source = createApplication();
    await source.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
    });
    await source.setLogicalModel({
      id: "gpt-x",
      routes: [{ providerId: "router", modelId: "gpt-x" }],
    });
    const bundle = await source.exportProfileBundle(
      new Date("2026-08-30T10:00:00.000Z"),
    );
    const invalid = { ...bundle, providers: [] };
    const target = createApplication();

    await expect(target.importProfileBundle(invalid)).rejects.toBeInstanceOf(
      ProfileBundleValidationError,
    );
    expect(await target.listProviders()).toEqual([]);
    expect(await target.listLogicalModels()).toEqual([]);
  });

  it("rolls back already-written entries when a repository write fails", async () => {
    const providers = new FailingProviderProfileRepository("b-provider");
    const target = createApplication({ providers });
    const source = createApplication();
    for (const id of ["a-provider", "b-provider"]) {
      await source.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
      });
    }
    const bundle = await source.exportProfileBundle(
      new Date("2026-08-30T10:00:00.000Z"),
    );

    await expect(target.importProfileBundle(bundle)).rejects.toBeInstanceOf(
      ProfileBundleImportError,
    );
    expect(await providers.list()).toEqual([]);
  });

  it("exports and imports bundles through the CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-bundle-cli-"));
    const filePath = join(directory, "profiles.json");
    const source = createApplication();
    await source.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
    });

    const exported = await runCli(source, [
      "profiles",
      "export",
      "--file",
      filePath,
    ]);
    expect(exported).toMatchObject({ code: 0, stderr: [] });
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      format: "providerdock-profile-bundle",
      version: 1,
      providers: [{ id: "router" }],
    });
    expect((await runCli(source, ["profiles", "export", "--file", filePath])).stderr.join(
      "\n",
    )).toContain("already exists");

    const target = createApplication();
    const imported = await runCli(target, [
      "profiles",
      "import",
      "--file",
      filePath,
    ]);
    expect(imported).toMatchObject({ code: 0, stderr: [] });
    expect(imported.stdout.join("\n")).toContain("providers 1 created/0 updated");
    expect((await target.getProvider("router")).displayName).toBe("Router");
  });
});

function createApplication(
  options: {
    readonly providers?: ProviderProfileRepository;
    readonly secrets?: MemorySecretStore;
  } = {},
): ProviderDockApplication {
  return new ProviderDockApplication(
    options.providers ?? new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
    options.secrets,
    undefined,
    undefined,
    undefined,
    undefined,
    new MemoryLogicalModelRepository(),
    new MemoryPromptProfileRepository(),
    new MemoryProjectProfileRepository(),
  );
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

class FailingProviderProfileRepository implements ProviderProfileRepository {
  private readonly delegate = new MemoryProviderProfileRepository();

  constructor(private readonly failingId: string) {}

  list(): Promise<readonly ProviderProfile[]> {
    return this.delegate.list();
  }

  get(id: string): Promise<ProviderProfile | undefined> {
    return this.delegate.get(id);
  }

  upsert(input: ProviderProfileInput): Promise<ProviderProfile> {
    if (input.id === this.failingId) {
      return Promise.reject(new Error("simulated write failure"));
    }
    return this.delegate.upsert(input);
  }

  delete(id: string): Promise<boolean> {
    return this.delegate.delete(id);
  }
}
