import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ModelUnavailableError,
  LogicalModelInUseByPromptProfileError,
  LogicalModelNotFoundError,
  PromptProfileNotFoundError,
  PromptProfileInUseByProjectProfileError,
  ProjectProfileNotFoundError,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderDoctor,
  ProviderInUseByLogicalModelError,
  ProviderInUseByPromptProfileError,
  ProviderNotFoundError,
  ProviderProbeService,
  SecretVaultUnavailableError,
  mergeModelCatalog,
  type CodexLauncher,
} from "../src/index.js";

describe("ProviderDockApplication", () => {
  it("supports provider set, get, list, and remove", async () => {
    const application = createApplication();

    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    expect((await application.getProvider("router")).displayName).toBe("Router");
    expect(await application.listProviders()).toHaveLength(1);
    await application.removeProvider("router");
    expect(await application.listProviders()).toHaveLength(0);
  });

  it("uses a typed not-found failure", async () => {
    const application = createApplication();
    await expect(application.getProvider("missing")).rejects.toBeInstanceOf(ProviderNotFoundError);
    await expect(application.removeProvider("missing")).rejects.toBeInstanceOf(
      ProviderNotFoundError,
    );
  });

  it("reports when a writable OS vault is unavailable", async () => {
    const application = createApplication();
    await expect(application.setSecret("ROUTER_KEY", "secret")).rejects.toBeInstanceOf(
      SecretVaultUnavailableError,
    );
  });

  it("validates logical-model provider references and protects routes from dangling", async () => {
    const application = createApplication();
    await application.setProvider({
      id: "primary",
      displayName: "Primary",
      baseUrl: "https://primary.example.test/v1",
    });
    await application.setProvider({
      id: "secondary",
      displayName: "Secondary",
      baseUrl: "https://secondary.example.test/v1",
    });

    await expect(
      application.setLogicalModel({
        id: "bad",
        routes: [{ providerId: "missing", modelId: "gpt-x" }],
      }),
    ).rejects.toBeInstanceOf(ProviderNotFoundError);

    await application.setLogicalModel({
      id: "gpt-x",
      routes: [
        { providerId: "primary", modelId: "gpt-x", priority: 100 },
        { providerId: "secondary", modelId: "gpt-x", priority: 90 },
      ],
    });
    expect(await application.getLogicalModel("gpt-x")).toMatchObject({ id: "gpt-x" });
    await expect(application.removeProvider("primary")).rejects.toBeInstanceOf(
      ProviderInUseByLogicalModelError,
    );

    await application.removeLogicalModel("gpt-x");
    await expect(application.getLogicalModel("gpt-x")).rejects.toBeInstanceOf(
      LogicalModelNotFoundError,
    );
    await application.removeProvider("primary");
  });

  it("validates prompt-profile references and protects preferred routes from dangling", async () => {
    const application = createApplication();
    for (const id of ["primary", "direct"]) {
      await application.setProvider({
        id,
        displayName: id,
        baseUrl: `https://${id}.example.test/v1`,
      });
    }
    await application.setLogicalModel({
      id: "gpt-x",
      routes: [{ providerId: "primary", modelId: "gpt-x", priority: 100 }],
    });

    await expect(
      application.setPromptProfile({
        id: "bad-provider",
        name: "Bad",
        instructions: "test",
        preferredProviderId: "missing",
      }),
    ).rejects.toBeInstanceOf(ProviderNotFoundError);
    await expect(
      application.setPromptProfile({
        id: "bad-model",
        name: "Bad",
        instructions: "test",
        preferredLogicalModelId: "missing",
      }),
    ).rejects.toBeInstanceOf(LogicalModelNotFoundError);

    await application.setPromptProfile({
      id: "practical",
      name: "Practical Coding",
      instructions: "Inspect existing implementation first.",
      preferredProviderId: "direct",
      preferredLogicalModelId: "gpt-x",
      preferredClient: "auto",
      reasoningLevel: "xhigh",
      fallbackPolicy: "logical-model",
    });
    expect(await application.getPromptProfile("practical")).toMatchObject({
      id: "practical",
      preferredProviderId: "direct",
      preferredLogicalModelId: "gpt-x",
    });
    await expect(application.removeProvider("direct")).rejects.toBeInstanceOf(
      ProviderInUseByPromptProfileError,
    );
    await expect(application.removeLogicalModel("gpt-x")).rejects.toBeInstanceOf(
      LogicalModelInUseByPromptProfileError,
    );

    await application.removePromptProfile("practical");
    await expect(application.getPromptProfile("practical")).rejects.toBeInstanceOf(
      PromptProfileNotFoundError,
    );
    await application.removeProvider("direct");
    await application.removeLogicalModel("gpt-x");
  });

  it("binds exact project directories to prompt profiles without dangling references", async () => {
    const application = createApplication();
    const projectDirectory = await mkdtemp(
      join(tmpdir(), "provider-dock-application-project-"),
    );
    await expect(
      application.setProjectProfile({
        projectDirectory,
        promptProfileId: "missing",
      }),
    ).rejects.toBeInstanceOf(PromptProfileNotFoundError);

    await application.setPromptProfile({
      id: "practical",
      name: "Practical",
      instructions: "Work practically.",
    });
    await application.setProjectProfile({
      projectDirectory,
      promptProfileId: "practical",
    });
    expect(await application.getProjectProfile(projectDirectory)).toMatchObject({
      projectDirectory,
      promptProfileId: "practical",
    });
    await expect(application.removePromptProfile("practical")).rejects.toBeInstanceOf(
      PromptProfileInUseByProjectProfileError,
    );

    await application.removeProjectProfile(projectDirectory);
    await expect(
      application.getProjectProfile(projectDirectory),
    ).rejects.toBeInstanceOf(ProjectProfileNotFoundError);
    await application.removePromptProfile("practical");
  });

  it("resolves automatic clients from explicit preferences and protocol compatibility", async () => {
    const application = createApplication();
    await application.setProvider({
      id: "responses",
      displayName: "Responses",
      baseUrl: "https://responses.example.test/v1",
      apiType: "openai-responses",
    });
    await application.setProvider({
      id: "anthropic",
      displayName: "Anthropic",
      baseUrl: "https://anthropic.example.test/v1",
      apiType: "anthropic-messages",
    });
    await application.setProvider({
      id: "chat-claude",
      displayName: "Chat Claude",
      baseUrl: "https://chat.example.test/v1",
      apiType: "openai-chat-completions",
      preferredClient: "claude-code",
    });

    expect(await application.resolveProviderClient("responses")).toBe("codex");
    expect(await application.resolveProviderClient("anthropic")).toBe(
      "claude-code",
    );
    expect(await application.resolveProviderClient("chat-claude")).toBe(
      "claude-code",
    );

    await application.setLogicalModel({
      id: "logical-claude",
      routes: [
        {
          providerId: "anthropic",
          modelId: "claude-x",
          priority: 100,
        },
        {
          providerId: "responses",
          modelId: "gpt-x",
          priority: 90,
        },
      ],
    });
    expect(
      await application.resolveLogicalModelClient("logical-claude"),
    ).toBe("claude-code");

    await application.setPromptProfile({
      id: "codex-override",
      name: "Codex override",
      instructions: "Use Codex.",
      preferredProviderId: "chat-claude",
      preferredModelId: "chat-model",
      preferredClient: "codex",
    });
    expect(
      await application.resolvePromptProfileClient("codex-override"),
    ).toBe("codex");
  });

  it("persists a Doctor report as a per-model capability snapshot", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), {
          status: 200,
        });
      }
      return new Response(
        JSON.stringify({
          output_text: "OK",
          status: "completed",
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { status: 200 },
      );
    });
    const secrets = new MemorySecretStore();
    const adapters = new ProviderAdapterRegistry().register(
      new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl: fetchMock }),
    );
    const health = new MemoryProviderHealthRepository();
    const application = new ProviderDockApplication(
      new MemoryProviderProfileRepository(),
      new ProviderProbeService(adapters),
      secrets,
      undefined,
      adapters,
      new ProviderDoctor({
        secretStore: secrets,
        adapterRegistry: adapters,
        fetchImpl: fetchMock,
        now: () => new Date("2026-08-30T10:00:00.000Z"),
      }),
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    await application.setProvider({
      id: "responses",
      displayName: "Responses",
      baseUrl: "https://responses.example.test/v1",
      apiType: "openai-responses",
    });

    await expect(
      application.diagnoseProvider("responses", { modelId: "gpt-x", level: 1 }),
    ).resolves.toMatchObject({
      modelId: "gpt-x",
      protocol: "openai-responses",
      verdict: "PASS",
    });
    expect(await application.getProviderHealth("responses")).toMatchObject({
      providerId: "responses",
      history: [],
      diagnostics: [
        {
          modelId: "gpt-x",
          checkedAt: "2026-08-30T10:00:00.000Z",
          capabilities: {
            text: "SUPPORTED",
            model_discovery: "SUPPORTED",
          },
          codexCompatibility: "NATIVE",
          claudeCompatibility: "INCOMPATIBLE",
        },
      ],
    });
  });

  it("runs metadata probes only when the health policy says they are due", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-x" }] }), { status: 200 }),
    );
    const secrets = new MemorySecretStore();
    const adapters = new ProviderAdapterRegistry().register(
      new GenericOpenAiAdapter({ secretStore: secrets, fetchImpl: fetchMock }),
    );
    const application = new ProviderDockApplication(
      new MemoryProviderProfileRepository(),
      new ProviderProbeService(adapters, {
        now: () => new Date("2026-08-30T12:00:00.000Z"),
      }),
      secrets,
      undefined,
      adapters,
    );
    await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "none" },
      healthCheck: { metadataTtlMs: 60_000 },
    });

    expect(
      await application.probeDueProviders(
        new Date("2026-08-30T12:00:00.000Z"),
      ),
    ).toEqual([
      expect.objectContaining({
        providerId: "router",
        decision: { action: "probe" },
        result: expect.objectContaining({
          health: expect.objectContaining({ status: "ONLINE" }),
        }),
      }),
    ]);
    expect(
      await application.probeDueProviders(
        new Date("2026-08-30T12:00:30.000Z"),
      ),
    ).toEqual([
      {
        providerId: "router",
        decision: {
          action: "skip",
          reason: "metadata-ttl",
          nextProbeAt: "2026-08-30T12:01:00.000Z",
        },
      },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it("passes persisted model reasoning capability to the Codex launcher", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({ exitCode: 0, signal: null }));
    const codex = { launch: codexLaunch };
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      codex as unknown as CodexLauncher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    const profile = await application.setProvider({
      id: "agentrouter",
      displayName: "AgentRouter",
      baseUrl: "https://agentrouter.org/v1",
      manualModelIds: ["glm-5.3"],
    });
    await health.record({
      health: {
        providerId: "agentrouter",
        status: "ONLINE",
        checkedAt: "2026-08-30T10:00:00.000Z",
        latencyMs: 12,
        discoveredModelCount: 1,
        appliedFixes: [],
      },
      models: mergeModelCatalog(profile, [
        {
          modelId: "glm-5.3",
          displayName: "glm-5.3",
          raw: { supported_reasoning_levels: ["low", "high", "max"] },
        },
      ]),
    });

    await application.launchCodex({
      providerId: "agentrouter",
      modelId: "glm-5.3",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    });

    expect(codexLaunch.mock.calls[0]?.[0]?.modelCatalog).toMatchObject([
      {
        modelId: "glm-5.3",
        reasoning: {
          kind: "thinking-mode",
          mode: "forced",
          source: "official-model-catalog",
        },
      },
    ]);
  });

  it("rejects models absent from a successful catalog and lists available models", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      { launch: codexLaunch } as unknown as CodexLauncher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    const provider = await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-responses",
    });
    await health.record({
      health: {
        providerId: provider.id,
        status: "ONLINE",
        checkedAt: "2026-09-13T10:00:00.000Z",
        latencyMs: 1,
        discoveredModelCount: 1,
        appliedFixes: [],
      },
      models: mergeModelCatalog(provider, [
        { modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", raw: {} },
      ]),
    });

    await expect(application.launchCodex({
      providerId: provider.id,
      modelId: "claude-opus-5",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    })).rejects.toMatchObject({
      constructor: ModelUnavailableError,
      availableModelIds: ["gpt-5.6-sol"],
      message: expect.stringContaining("gpt-5.6-sol"),
    });
    expect(codexLaunch).not.toHaveBeenCalled();
  });

  it("keeps explicitly configured manual models launchable when discovery is unavailable", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      { launch: codexLaunch } as unknown as CodexLauncher,
    );
    const provider = await application.setProvider({
      id: "manual",
      displayName: "Manual",
      baseUrl: "https://manual.example.test/v1",
      apiType: "openai-responses",
      manualModelIds: ["gpt-5.6-sol"],
    });

    await application.launchCodex({
      providerId: provider.id,
      modelId: "gpt-5.6-sol",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    });

    expect(codexLaunch).toHaveBeenCalledTimes(1);
  });

  it("rejects manual-only models when an authoritative catalog is available", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      { launch: codexLaunch } as unknown as CodexLauncher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    const provider = await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-responses",
      manualModelIds: ["manual-only"],
    });
    await health.record({
      health: {
        providerId: provider.id,
        status: "ONLINE",
        checkedAt: "2026-09-13T10:00:00.000Z",
        latencyMs: 1,
        discoveredModelCount: 1,
        appliedFixes: [],
      },
      models: mergeModelCatalog(provider, [
        { modelId: "discovered", displayName: "Discovered", raw: {} },
      ]),
    });

    await expect(application.launchCodex({
      providerId: provider.id,
      modelId: "manual-only",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    })).rejects.toMatchObject({
      constructor: ModelUnavailableError,
      availableModelIds: ["discovered"],
    });
    expect(codexLaunch).not.toHaveBeenCalled();
  });

  it("keeps a previously discovered model launchable after an empty degraded refresh", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      { launch: codexLaunch } as unknown as CodexLauncher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    const provider = await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      apiType: "openai-responses",
    });
    await health.record({
      health: {
        providerId: provider.id,
        status: "ONLINE",
        checkedAt: "2026-09-13T10:00:00.000Z",
        latencyMs: 1,
        discoveredModelCount: 1,
        appliedFixes: [],
      },
      models: mergeModelCatalog(provider, [
        { modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", raw: {} },
      ]),
    });
    await health.record({
      health: {
        providerId: provider.id,
        status: "DEGRADED",
        checkedAt: "2026-09-13T10:01:00.000Z",
        latencyMs: 1,
        discoveredModelCount: 0,
        appliedFixes: [],
      },
      models: mergeModelCatalog(provider, []),
    });

    await application.launchCodex({
      providerId: provider.id,
      modelId: "gpt-5.6-sol",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    });

    expect(codexLaunch).toHaveBeenCalledTimes(1);
  });

  it("removes logical routes whose provider catalog authoritatively omits their model", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const codexLaunch = vi.fn(async (_input: Parameters<CodexLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      { launch: codexLaunch } as unknown as CodexLauncher,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      health,
    );
    const primary = await application.setProvider({
      id: "primary",
      displayName: "Primary",
      baseUrl: "https://primary.example.test/v1",
      apiType: "openai-responses",
    });
    const secondary = await application.setProvider({
      id: "secondary",
      displayName: "Secondary",
      baseUrl: "https://secondary.example.test/v1",
      apiType: "openai-responses",
    });
    await health.record({
      health: {
        providerId: primary.id,
        status: "ONLINE",
        checkedAt: "2026-09-13T10:00:00.000Z",
        latencyMs: 1,
        discoveredModelCount: 1,
        appliedFixes: [],
      },
      models: mergeModelCatalog(primary, [
        { modelId: "gpt-5.6-sol", displayName: "GPT-5.6 Sol", raw: {} },
      ]),
    });
    await application.setLogicalModel({
      id: "logical-gpt",
      routes: [
        { providerId: primary.id, modelId: "claude-opus-5", priority: 100 },
        { providerId: secondary.id, modelId: "gpt-5.6-sol", priority: 90 },
      ],
    });

    await application.launchCodexLogicalModel({
      logicalModelId: "logical-gpt",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    });

    expect(codexLaunch).toHaveBeenCalledTimes(1);
    expect(codexLaunch.mock.calls[0]?.[0]?.fallback?.logicalModel.routes).toEqual([
      { providerId: secondary.id, modelId: "gpt-5.6-sol", priority: 90, enabled: true },
    ]);
  });

});

function createApplication(): ProviderDockApplication {
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
  );
}
