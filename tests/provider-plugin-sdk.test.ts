import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  createDefaultApplicationAsync,
  createProviderPluginContext,
  GenericOpenAiAdapter,
  instantiateProviderPlugin,
  loadProviderPlugins,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  parseProviderProfile,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderPluginExecutionError,
  ProviderPluginLoadError,
  ProviderPluginValidationError,
  ProviderProbeService,
  ProviderRequestError,
  runProviderDockCli,
  validateProviderPluginDefinition,
  type CliIo,
  type ProviderAdapter,
  type ProviderPluginDefinition,
} from "../src/index.js";

describe("provider plugin SDK", () => {
  it("loads an explicitly configured local module and exposes its adapter", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-plugin-"));
    const modulePath = join(directory, "fixture-plugin.mjs");
    await writeFile(
      modulePath,
      `export default {
        manifest: {
          apiVersion: 1,
          id: "fixture",
          name: "Fixture Provider",
          version: "1.2.3",
          description: "Test plugin",
          adapterIds: ["plugin:fixture/catalog"]
        },
        createAdapters() {
          return [{
            id: "plugin:fixture/catalog",
            supports(profile) {
              return profile.adapterId === "plugin:fixture/catalog";
            },
            prepareProfile(profile) {
              return { ...profile, apiType: "custom" };
            },
            async discoverModels() {
              return [{
                modelId: "fixture-model",
                displayName: "Fixture Model",
                raw: { source: "fixture" }
              }];
            }
          }];
        }
      };`,
      "utf8",
    );

    const application = await createDefaultApplicationAsync({
      environment: { PROVIDER_DOCK_HOME: join(directory, "home") },
      platform: "linux",
      pluginPaths: [modulePath],
    });
    expect(application.listProviderPlugins()).toEqual([
      expect.objectContaining({
        id: "fixture",
        name: "Fixture Provider",
        version: "1.2.3",
        adapterIds: ["plugin:fixture/catalog"],
      }),
    ]);

    await application.setProvider({
      id: "fixture-provider",
      displayName: "Fixture",
      baseUrl: "https://fixture.example.test/v1",
      adapterId: "plugin:fixture/catalog",
    });
    const probe = await application.probeProvider("fixture-provider");
    expect(probe).toMatchObject({
      health: { status: "ONLINE", discoveredModelCount: 1 },
      models: [{ modelId: "fixture-model", displayName: "Fixture Model" }],
    });

    const listed = await runCli(application, ["plugins", "list", "--json"]);
    expect(listed.code).toBe(0);
    expect(JSON.parse(listed.stdout[0] ?? "[]")).toEqual([
      expect.objectContaining({
        id: "fixture",
        adapterIds: ["plugin:fixture/catalog"],
      }),
    ]);
  });

  it("does not import or scan anything when no explicit paths are supplied", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-no-plugin-"));
    const importer = vi.fn().mockRejectedValue(new Error("must not execute"));
    const application = await createDefaultApplicationAsync({
      environment: { PROVIDER_DOCK_HOME: join(directory, "home") },
      platform: "linux",
      pluginPaths: [],
      pluginImporter: importer,
    });

    expect(importer).not.toHaveBeenCalled();
    expect(application.listProviderPlugins()).toEqual([]);
    expect((await runCli(application, ["plugins", "list"])).stdout).toEqual([
      "No provider plugins loaded.",
    ]);
  });

  it("injects authentication through host HTTP without exposing the secret store", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const context = createProviderPluginContext({
      secretStore: new MemorySecretStore({ ROUTER_KEY: "actual-secret" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      auth: {
        kind: "query",
        parameterName: "api_key",
        secretRef: "ROUTER_KEY",
      },
    });

    const response = await context.http.request(profile, "models");

    expect(context).not.toHaveProperty("secretStore");
    expect(context.http).not.toHaveProperty("secrets");
    const requestedUrl = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(requestedUrl.origin).toBe("https://router.example.test");
    expect(requestedUrl.searchParams.get("api_key")).toBe("actual-secret");
    expect(response.url).toBe("");
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("rejects cross-origin endpoints and protected header overrides", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const context = createProviderPluginContext({
      secretStore: new MemorySecretStore({ ROUTER_KEY: "actual-secret" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    });

    await expect(
      context.http.request(profile, "https://attacker.example.test/collect"),
    ).rejects.toMatchObject({
      type: "INVALID_REQUEST",
    } satisfies Partial<ProviderRequestError>);
    await expect(
      context.http.request(profile, "models", {
        headers: { Authorization: "Bearer plugin-value" },
      }),
    ).rejects.toMatchObject({
      type: "INVALID_REQUEST",
    } satisfies Partial<ProviderRequestError>);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("validates manifests, declared adapters, and adapter results", async () => {
    expect(() =>
      validateProviderPluginDefinition({
        manifest: {
          apiVersion: 2,
          id: "fixture",
          name: "Fixture",
          version: "1.0",
          adapterIds: ["plugin:other/main"],
        },
        createAdapters: () => [],
      }),
    ).toThrow(ProviderPluginValidationError);

    const context = createProviderPluginContext({
      secretStore: new MemorySecretStore(),
    });
    await expect(
      instantiateProviderPlugin(
        validDefinition({
          manifestAdapterIds: ["plugin:fixture/main"],
          adapters: [validAdapter("plugin:fixture/other")],
        }),
        context,
        "fixture.mjs",
      ),
    ).rejects.toThrow(/adapter manifest mismatch/);

    const loaded = await instantiateProviderPlugin(
      validDefinition({
        adapters: [
          {
            ...validAdapter("plugin:fixture/main"),
            discoverModels: async () => [
              { modelId: "duplicate", displayName: "One", raw: {} },
              { modelId: "duplicate", displayName: "Two", raw: {} },
            ],
          },
        ],
      }),
      context,
      "fixture.mjs",
    );
    const profile = pluginProfile();
    await expect(
      loaded.adapters[0]?.discoverModels(profile),
    ).rejects.toBeInstanceOf(ProviderPluginExecutionError);
  });

  it("prevents prepareProfile from mutating protected provider fields", async () => {
    const loaded = await instantiateProviderPlugin(
      validDefinition({
        adapters: [
          {
            ...validAdapter("plugin:fixture/main"),
            prepareProfile(profile) {
              const mutable = profile as { baseUrl: string };
              mutable.baseUrl = "https://attacker.example.test";
              return profile;
            },
          },
        ],
      }),
      createProviderPluginContext({ secretStore: new MemorySecretStore() }),
      "fixture.mjs",
    );
    const original = pluginProfile();

    expect(() => loaded.adapters[0]?.prepareProfile?.(original)).toThrow(
      ProviderPluginExecutionError,
    );
    expect(original.baseUrl).toBe("https://router.example.test/v1");
  });

  it("rejects non-local, duplicate, malformed, and colliding modules", async () => {
    const registry = new ProviderAdapterRegistry();
    const common = {
      adapterRegistry: registry,
      secretStore: new MemorySecretStore(),
    };
    await expect(
      loadProviderPlugins({ ...common, modulePaths: ["provider-package"] }),
    ).rejects.toBeInstanceOf(ProviderPluginLoadError);
    await expect(
      loadProviderPlugins({
        ...common,
        modulePaths: ["https://example.test/plugin.mjs"],
      }),
    ).rejects.toThrow(/local file path/);

    const directory = await mkdtemp(join(tmpdir(), "provider-dock-plugin-errors-"));
    const firstPath = join(directory, "first.mjs");
    const secondPath = join(directory, "second.mjs");
    await Promise.all([
      writeFile(firstPath, "export default {};", "utf8"),
      writeFile(secondPath, "export default {};", "utf8"),
    ]);
    await expect(
      loadProviderPlugins({
        ...common,
        modulePaths: [firstPath, firstPath],
        importer: vi.fn(),
      }),
    ).rejects.toThrow(/configured more than once/);
    await expect(
      loadProviderPlugins({
        ...common,
        modulePaths: [firstPath],
        importer: async () => ({}),
      }),
    ).rejects.toThrow(/must export default or providerDockPlugin/);
    await expect(
      loadProviderPlugins({
        ...common,
        modulePaths: [firstPath, secondPath],
        importer: async () => ({ default: validDefinition() }),
      }),
    ).rejects.toThrow(/already loaded/);

    registry.register(validAdapter("plugin:fixture/main"));
    await expect(
      loadProviderPlugins({
        ...common,
        modulePaths: [firstPath],
        importer: async () => ({ default: validDefinition() }),
      }),
    ).rejects.toThrow(/already registered/);
  });

  it("does not fall through to a generic adapter for a missing explicit plugin ID", () => {
    const secrets = new MemorySecretStore();
    const registry = new ProviderAdapterRegistry().register(
      new GenericOpenAiAdapter({ secretStore: secrets }),
    );

    expect(() =>
      registry.resolve(
        parseProviderProfile({
          id: "router",
          displayName: "Router",
          baseUrl: "https://router.example.test/v1",
          adapterId: "plugin:missing/main",
        }),
      ),
    ).toThrow(/No adapter is registered/);
  });

  it("accepts plugin adapter IDs in the provider CLI and rejects malformed IDs", async () => {
    const application = new ProviderDockApplication(
      new MemoryProviderProfileRepository(),
      new ProviderProbeService(new ProviderAdapterRegistry()),
    );
    const saved = await runCli(application, [
      "providers",
      "set",
      "--id",
      "router",
      "--name",
      "Router",
      "--base-url",
      "https://router.example.test/v1",
      "--adapter",
      "plugin:fixture/main",
    ]);
    expect(saved.code).toBe(0);
    expect((await application.getProvider("router")).adapterId).toBe(
      "plugin:fixture/main",
    );

    const rejected = await runCli(application, [
      "providers",
      "set",
      "--id",
      "bad",
      "--name",
      "Bad",
      "--base-url",
      "https://router.example.test/v1",
      "--adapter",
      "plugin:INVALID",
    ]);
    expect(rejected.code).toBe(1);
    expect(rejected.stderr.join("\n")).toContain(
      "plugin:PLUGIN_ID/ADAPTER_ID",
    );
  });
});

interface ValidDefinitionOptions {
  readonly manifestAdapterIds?: readonly string[];
  readonly adapters?: readonly ProviderAdapter[];
}

function validDefinition(
  options: ValidDefinitionOptions = {},
): ProviderPluginDefinition {
  const adapters = options.adapters ?? [validAdapter("plugin:fixture/main")];
  return {
    manifest: {
      apiVersion: 1,
      id: "fixture",
      name: "Fixture",
      version: "1.0.0",
      description: "Fixture plugin",
      adapterIds: [...(options.manifestAdapterIds ?? ["plugin:fixture/main"])],
    },
    createAdapters: () => adapters,
  };
}

function validAdapter(id: string): ProviderAdapter {
  return {
    id,
    supports: (profile) => profile.adapterId === id,
    discoverModels: async () => [
      { modelId: "fixture-model", displayName: "Fixture Model", raw: {} },
    ],
  };
}

function pluginProfile() {
  return parseProviderProfile({
    id: "router",
    displayName: "Router",
    baseUrl: "https://router.example.test/v1",
    adapterId: "plugin:fixture/main",
    auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
    secretHeaders: { "x-provider-secret": "SECONDARY_KEY" },
  });
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
