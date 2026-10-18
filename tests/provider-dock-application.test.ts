import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  CredentialManager,
  FileCredentialMetadataRepository,
  MemoryProviderHealthRepository,
  MemoryProviderProfileRepository,
  MemoryCredentialMetadataRepository,
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
  type ClaudeLauncher,
  type CodexLauncher,
} from "../src/index.js";
import { ApplicationCredentialBindings } from "../src/core/security/credential-bindings.js";
import {
  FilePortalRepository,
  MemoryPortalRepository,
  PortalRepositoryCorruptionError,
} from "../src/core/portals/portal-repository.js";

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

  it("invalidates Doctor evidence before overwriting or removing a referenced secret", async () => {
    const profiles = new MemoryProviderProfileRepository();
    await profiles.upsert({ id: "router", displayName: "Router", baseUrl: "https://router.test/v1",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" } });
    const secrets = new MemorySecretStore({ ROUTER_KEY: "old-secret" });
    const health = new MemoryProviderHealthRepository();
    const invalidate = vi.spyOn(health, "invalidateDiagnostics");
    const app = new ProviderDockApplication(profiles, new ProviderProbeService(new ProviderAdapterRegistry()),
      secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined, health);
    await app.setSecret("ROUTER_KEY", "replacement-secret");
    expect(invalidate).toHaveBeenCalledWith("router");
    invalidate.mockClear();
    await app.removeSecret("ROUTER_KEY");
    expect(invalidate).toHaveBeenCalledWith("router");
  });

  it("invalidates stale Doctor evidence after activating a different provider API key", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const portals = new MemoryPortalRepository();
    await profiles.upsert({ id: "router", displayName: "Router", baseUrl: "https://router.test/v1",
      auth: { kind: "bearer", secretRef: "OLD_API" } });
    const secrets = new MemorySecretStore({ OLD_API: "old-secret" });
    const health = new MemoryProviderHealthRepository();
    const invalidate = vi.spyOn(health, "invalidateDiagnostics");
    const manager = new CredentialManager({ secrets,
      metadata: new MemoryCredentialMetadataRepository(),
      bindings: new ApplicationCredentialBindings(profiles, portals) });
    const candidate = await manager.add({ providerId: "router", purpose: "provider-api", value: "new-secret" });
    const app = new ProviderDockApplication(profiles, new ProviderProbeService(new ProviderAdapterRegistry()),
      secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      health, undefined, undefined, undefined, undefined, undefined, undefined, manager);
    await app.activateCredential("router", "provider-api", candidate.id);
    expect(invalidate).toHaveBeenCalledWith("router");
    invalidate.mockClear();
    await app.addCredential({ providerId: "router", purpose: "provider-api",
      value: "newer-secret", activate: true });
    expect(invalidate).toHaveBeenCalledWith("router");
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

  it("rejects an unknown model after an empty degraded refresh", async () => {
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

    await expect(application.launchCodex({
      providerId: provider.id,
      modelId: "claude-opus-5",
      projectDirectory: tmpdir(),
      route: { kind: "auto" },
    })).rejects.toMatchObject({
      constructor: ModelUnavailableError,
      availableModelIds: ["gpt-5.6-sol"],
    });
    expect(codexLaunch).not.toHaveBeenCalled();
  });

  it("applies degraded catalog validation to Claude launches", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const health = new MemoryProviderHealthRepository();
    const claudeLaunch = vi.fn(async (_input: Parameters<ClaudeLauncher["launch"]>[0]) => ({
      exitCode: 0,
      signal: null,
    }));
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      undefined,
      undefined,
      undefined,
      undefined,
      { launch: claudeLaunch } as unknown as ClaudeLauncher,
      undefined,
      undefined,
      undefined,
      health,
    );
    const provider = await application.setProvider({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      apiType: "anthropic-messages",
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

    await expect(application.launchClaude({
      providerId: provider.id,
      modelId: "claude-opus-5",
      projectDirectory: tmpdir(),
    })).rejects.toMatchObject({
      constructor: ModelUnavailableError,
      availableModelIds: ["gpt-5.6-sol"],
    });
    expect(claudeLaunch).not.toHaveBeenCalled();
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

describe("ApplicationCredentialBindings", () => {
  it("rotates provider API credentials without changing the portal session binding", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const portals = new MemoryPortalRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "OLD_API" },
    });
    await portals.update("fixture", () => ({
      connection: {
        providerId: "fixture",
        adapterId: "new-api",
        siteUrl: "https://account.invalid",
        auth: { kind: "cookie", secretRef: "OLD_SESSION" },
        autoRefresh: true,
        refreshIntervalMs: 300000,
      },
      revision: "00000000-0000-4000-8000-000000000001",
      failures: 0,
    }));
    const bindings = new ApplicationCredentialBindings(profiles, portals);

    await bindings.activate({ providerId: "fixture", purpose: "provider-api", secretRef: "NEW_API" });

    expect((await profiles.get("fixture"))?.auth).toEqual({ kind: "bearer", secretRef: "NEW_API" });
    expect((await portals.get("fixture"))?.connection.auth).toEqual({ kind: "cookie", secretRef: "OLD_SESSION" });
    expect(await bindings.isReferenced("OLD_API")).toBe(false);
    expect(await bindings.isReferenced("NEW_API")).toBe(true);
  });

  it("rotates a portal session independently and enumerates active references", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const portals = new MemoryPortalRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "API" },
    });
    await portals.update("fixture", () => ({
      connection: {
        providerId: "fixture",
        adapterId: "new-api",
        siteUrl: "https://account.invalid",
        auth: { kind: "cookie", secretRef: "SESSION" },
        autoRefresh: true,
        refreshIntervalMs: 300000,
      },
      revision: "00000000-0000-4000-8000-000000000002",
      failures: 0,
    }));
    const bindings = new ApplicationCredentialBindings(profiles, portals);

    await bindings.activate({ providerId: "fixture", purpose: "portal-session", secretRef: "NEW_SESSION" });

    expect((await portals.get("fixture"))?.connection.auth).toEqual({ kind: "cookie", secretRef: "NEW_SESSION" });
    expect(await bindings.list()).toEqual(expect.arrayContaining([
      { providerId: "fixture", purpose: "provider-api", secretRef: "API" },
      { providerId: "fixture", purpose: "portal-session", secretRef: "NEW_SESSION" },
    ]));
    expect(await bindings.isReferenced("SESSION")).toBe(false);
  });

  it("exposes credential operations through the application without returning plaintext", async () => {
    const registryPath = join(await mkdtemp(join(tmpdir(), "provider-dock-registry-loss-")), "registry.json");
    const profiles = new MemoryProviderProfileRepository();
    const portals = new MemoryPortalRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "OLD_API" },
    });
    const secrets = new MemorySecretStore();
    const manager = new CredentialManager({
      secrets,
      metadata: new FileCredentialMetadataRepository(registryPath),
      bindings: new ApplicationCredentialBindings(profiles, portals),
    });
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(new ProviderAdapterRegistry()),
      secrets,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      undefined,
      undefined,
      manager,
    );

    const added = await application.addCredential({
      providerId: "fixture",
      purpose: "provider-api",
      value: "fixture-api-secret",
      activate: true,
    });

    expect(added.maskedValue).toBe("fix…cret");
    expect(JSON.stringify(added)).not.toContain("fixture-api-secret");
    expect((await application.getProvider("fixture")).auth).toMatchObject({
      kind: "bearer",
      secretRef: expect.stringMatching(/^credential-/),
    });
    const firstRef = (await application.getProvider("fixture")).auth;
    if (firstRef.kind === "none") throw new Error("Expected a managed API credential.");
    expect(await application.listManagedSecretReferences()).toContain(firstRef.secretRef);

    await expect(application.setSecret(firstRef.secretRef, "unexpected-replacement"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await secrets.get(firstRef.secretRef)).toBe("fixture-api-secret");
    expect((await application.listCredentials("fixture", "provider-api"))[0]?.maskedValue)
      .toBe("fix…cret");

    await application.addCredential({
      providerId: "fixture",
      purpose: "provider-api",
      value: "second-api-secret",
      activate: true,
    });
    await expect(application.removeSecret(firstRef.secretRef))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await secrets.get(firstRef.secretRef)).toBe("fixture-api-secret");

    await unlink(registryPath);
    await expect(application.setSecret(firstRef.secretRef, "lost-registry-overwrite"))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(application.removeSecret(firstRef.secretRef))
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await secrets.get(firstRef.secretRef)).toBe("fixture-api-secret");
    await expect(application.listManagedSecretReferences())
      .rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("keeps the rotated-out provider key available for rollback and refuses to drop the active one", async () => {
    const profiles = new MemoryProviderProfileRepository();
    const portals = new MemoryPortalRepository();
    const secrets = new MemorySecretStore();
    const health = new MemoryProviderHealthRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "SEED_API" },
    });
    const manager = new CredentialManager({
      secrets,
      metadata: new MemoryCredentialMetadataRepository(),
      bindings: new ApplicationCredentialBindings(profiles, portals),
    });
    const application = new ProviderDockApplication(
      profiles, new ProviderProbeService(new ProviderAdapterRegistry()),
      secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      health, undefined, undefined, undefined, undefined, undefined, undefined, manager,
    );

    const first = await application.addCredential({
      providerId: "fixture", purpose: "provider-api", value: "rollback-key-one", label: "first", activate: true,
    });
    const second = await application.addCredential({
      providerId: "fixture", purpose: "provider-api", value: "rollback-key-two", label: "second", activate: true,
    });
    expect(first.maskedValue).not.toBe(second.maskedValue);

    // Rotation keeps both keys of the same provider: the new one active, the prior one retained for rollback.
    const afterRotation = await application.listCredentials("fixture", "provider-api");
    expect(afterRotation).toHaveLength(2);
    expect(afterRotation.find((entry) => entry.id === first.id)?.state).toBe("available");
    expect(afterRotation.find((entry) => entry.id === second.id)?.state).toBe("active");

    // The active (in-use) credential cannot be removed.
    await expect(application.removeCredential("fixture", second.id, "provider-api"))
      .rejects.toMatchObject({ code: "ACTIVE_REFERENCE" });

    // Explicitly re-activating the retained key rolls back the active binding.
    const rolledBack = await application.activateCredential("fixture", "provider-api", first.id);
    expect(rolledBack.state).toBe("active");
    const afterRollback = await application.listCredentials("fixture", "provider-api");
    expect(afterRollback.find((entry) => entry.id === first.id)?.state).toBe("active");
    expect(afterRollback.find((entry) => entry.id === second.id)?.state).toBe("available");

    // Once it is no longer active or referenced, the rotated-out key can be dropped.
    await application.removeCredential("fixture", second.id, "provider-api");
    const afterRemoval = await application.listCredentials("fixture", "provider-api");
    expect(afterRemoval).toHaveLength(1);
    expect(afterRemoval[0]?.id).toBe(first.id);
    expect(afterRemoval[0]?.state).toBe("active");
  });

  it("refuses to delete an unavailable credential while the portal catalog is corrupt, revealing no path", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const profiles = new MemoryProviderProfileRepository();
    const portals = new FilePortalRepository(catalogPath);
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "portal-session-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(),
      providerId: "fixture",
      purpose: "portal-session",
      secretRef,
      maskedValue: "unavailable",
      state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets,
      metadata,
      bindings: new ApplicationCredentialBindings(profiles, portals),
    });
    const before = await readFile(catalogPath, "utf8");

    // The destructive check is fail-closed: an unreadable catalog means "usage unknown", never "unused".
    const rejection = await manager
      .remove("fixture", record.id, "portal-session")
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: "CONFLICT" });
    const message = (rejection as { message: string }).message;
    expect(message).toBe(
      "Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    );
    expect(message).not.toContain(catalogPath);

    // Nothing was deleted: ciphertext, metadata record, and the catalog bytes are all intact.
    expect(await secrets.get(secretRef)).toBe("portal-session-ciphertext");
    expect(await metadata.get(record.id)).toBeDefined();
    expect(await readFile(catalogPath, "utf8")).toBe(before);
  });
  it("stays fail-closed for an available, unreferenced provider-api key while the catalog is corrupt", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const portals = new FilePortalRepository(catalogPath);
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "provider-api-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(),
      providerId: "fixture",
      purpose: "provider-api",
      secretRef,
      maskedValue: "pro…text",
      state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets,
      metadata,
      bindings: new ApplicationCredentialBindings(new MemoryProviderProfileRepository(), portals),
    });

    // Even an available, profile-unreferenced key cannot be confirmed unused while the catalog is unreadable.
    await expect(manager.remove("fixture", record.id, "provider-api"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect(await secrets.get(secretRef)).toBe("provider-api-ciphertext");
    expect(await metadata.get(record.id)).toBeDefined();
  });
  it("still reports a known profile reference as true (not an error) when the catalog is corrupt", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const profiles = new MemoryProviderProfileRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "PROFILE_API" },
    });
    const bindings = new ApplicationCredentialBindings(profiles, new FilePortalRepository(catalogPath));

    // Profiles are enumerated first, so a known reference short-circuits before the corrupt catalog is read.
    expect(await bindings.isReferenced("PROFILE_API")).toBe(true);

    // Through the manager a known reference is refused as ACTIVE_REFERENCE, never masked into CONFLICT.
    const secrets = new MemorySecretStore({ PROFILE_API: "profile-api-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(),
      providerId: "fixture",
      purpose: "provider-api",
      secretRef: "PROFILE_API",
      maskedValue: "pro…text",
      state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({ secrets, metadata, bindings });
    await expect(manager.remove("fixture", record.id, "provider-api"))
      .rejects.toMatchObject({ code: "ACTIVE_REFERENCE" });
    expect(await secrets.get("PROFILE_API")).toBe("profile-api-ciphertext");
  });
  it("keeps provider API bindings readable through the tolerant list() when the catalog is corrupt", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const profiles = new MemoryProviderProfileRepository();
    await profiles.upsert({
      id: "fixture",
      displayName: "Fixture",
      baseUrl: "https://inference.invalid/v1",
      auth: { kind: "bearer", secretRef: "API_REF" },
    });
    const portals = new FilePortalRepository(catalogPath);
    const bindings = new ApplicationCredentialBindings(profiles, portals);

    // The corruption is real: a direct portal read throws.
    await expect(portals.list()).rejects.toBeInstanceOf(PortalRepositoryCorruptionError);
    // Yet the non-destructive read path stays tolerant and still surfaces the provider API binding.
    expect(await bindings.list()).toEqual([
      { providerId: "fixture", purpose: "provider-api", secretRef: "API_REF" },
    ]);
  });

  it("propagates the fail-closed CONFLICT through application.removeCredential when the catalog is corrupt", async () => {
    const catalogPath = await makeCorruptPortalCatalog();
    const profiles = new MemoryProviderProfileRepository();
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "app-portal-ciphertext-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "portal-session",
      secretRef, maskedValue: "app…sess", state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets, metadata,
      bindings: new ApplicationCredentialBindings(profiles, new FilePortalRepository(catalogPath)),
    });
    const application = new ProviderDockApplication(
      profiles, new ProviderProbeService(new ProviderAdapterRegistry()),
      secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, manager,
    );
    const before = await readFile(catalogPath, "utf8");

    // The application forwards the manager's fail-closed guard verbatim: usage-unknown, never usage-none.
    const rejection = await application
      .removeCredential("fixture", record.id, "portal-session")
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: "CONFLICT" });
    expect((rejection as { message: string }).message).toBe(
      "Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    );
    expect((rejection as { message: string }).message).not.toContain(catalogPath);

    // Nothing was deleted: ciphertext, metadata record, and the catalog bytes are all intact.
    expect(await secrets.get(secretRef)).toBe("app-portal-ciphertext-canary");
    expect(await metadata.get(record.id)).toBeDefined();
    expect(await readFile(catalogPath, "utf8")).toBe(before);
  });

  it("fails closed to CONFLICT (not a raw error) when the portal catalog path is an unreadable directory", async () => {
    // The reviewer's reopened defect: a portal catalog that is a directory yields a raw EISDIR, which
    // previously propagated instead of the fixed CONFLICT — so removal could reject unhandled.
    const catalogPath = await makeUnreadableStorePath("portals.json");
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "eisdir-portal-ciphertext-canary" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "portal-session",
      secretRef, maskedValue: "eis…sess", state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets, metadata,
      bindings: new ApplicationCredentialBindings(
        new MemoryProviderProfileRepository(), new FilePortalRepository(catalogPath),
      ),
    });

    const rejection = await manager
      .remove("fixture", record.id, "portal-session")
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: "CONFLICT" });
    const message = (rejection as { message: string }).message;
    expect(message).toBe(
      "Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    );
    expect(message).not.toContain(catalogPath);

    // Nothing was deleted: the fail-closed guard runs before any vault/metadata mutation.
    expect(await secrets.get(secretRef)).toBe("eisdir-portal-ciphertext-canary");
    expect(await metadata.get(record.id)).toBeDefined();
  });

  it("projects an EACCES portal-seam fault to a fixed cause, never leaking its path or canary", async () => {
    const seamCanary = `portal-seam-canary-${randomUUID()}`;
    const rawPath = `C:\\fake\\master-keys\\${seamCanary}\\portals.json`;
    const failure = Object.assign(new Error(`EACCES: permission denied, open '${rawPath}'`), { code: "EACCES" });
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "eacces-portal-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "portal-session",
      secretRef, maskedValue: "eac…sess", state: "unavailable",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets, metadata,
      bindings: new ApplicationCredentialBindings(
        new MemoryProviderProfileRepository(), throwingPortalRepository(failure),
      ),
    });

    const rejection = await manager
      .remove("fixture", record.id, "portal-session")
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: "CONFLICT" });
    const message = (rejection as { message: string }).message;
    expect(message).toBe(
      "Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
    );
    expect(message).not.toContain(seamCanary);
    expect(message).not.toContain(rawPath);
    expect(await secrets.get(secretRef)).toBe("eacces-portal-ciphertext");
    expect(await metadata.get(record.id)).toBeDefined();
  });

  it("pins a profile-read failure separately: EIO on the provider store fails closed before the portal read", async () => {
    const seamCanary = `profile-seam-canary-${randomUUID()}`;
    const rawPath = `C:\\fake\\home\\${seamCanary}\\providers.json`;
    const failure = Object.assign(new Error(`EIO: i/o error, read '${rawPath}'`), { code: "EIO" });
    // If the portal read were (wrongly) reached, it would surface this distinct marker instead.
    const portalCanary = `portal-should-not-be-read-${randomUUID()}`;
    const portals = throwingPortalRepository(new Error(portalCanary));
    const secretRef = `credential-${randomUUID()}`;
    const secrets = new MemorySecretStore({ [secretRef]: "profile-eio-ciphertext" });
    const metadata = new MemoryCredentialMetadataRepository();
    const record = await metadata.upsert({
      id: randomUUID(), providerId: "fixture", purpose: "provider-api",
      secretRef, maskedValue: "eio…api", state: "available",
      createdAt: "2026-09-27T00:00:00.000Z",
    });
    const manager = new CredentialManager({
      secrets, metadata,
      bindings: new ApplicationCredentialBindings(throwingProfileRepository(failure), portals),
    });

    const rejection = await manager
      .remove("fixture", record.id, "provider-api")
      .then(() => undefined, (error: unknown) => error);
    expect(rejection).toMatchObject({ code: "CONFLICT" });
    const message = (rejection as { message: string }).message;
    // The provider-store cause is distinct from the catalog cause: the failure is pinned to the profile read.
    expect(message).toBe(
      "Использование ключа невозможно проверить, пока список провайдеров недоступен; сначала восстановите хранилище.",
    );
    expect(message).not.toContain(seamCanary);
    expect(message).not.toContain(rawPath);
    expect(message).not.toContain(portalCanary);
    expect(await secrets.get(secretRef)).toBe("profile-eio-ciphertext");
    expect(await metadata.get(record.id)).toBeDefined();
  });
});

function createApplication(): ProviderDockApplication {
  return new ProviderDockApplication(
    new MemoryProviderProfileRepository(),
    new ProviderProbeService(new ProviderAdapterRegistry()),
  );
}

// A portal catalog of raw NUL bytes: unparseable JSON, so FilePortalRepository.list() fails
// closed with a PortalRepositoryCorruptionError instead of returning records.
async function makeCorruptPortalCatalog(): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "provider-dock-portal-corrupt-")), "portals.json");
  await writeFile(path, "\u0000\u0000\u0000", { encoding: "utf8" });
  return path;
}

// A store path that is actually a directory: reading it as a file fails with a raw EISDIR. It stands
// in for any read isReferenced cannot finish (a directory where a file was expected, a permission or
// I/O fault) — the reference-check must fail-closed to CONFLICT rather than propagate the raw error.
async function makeUnreadableStorePath(basename: string): Promise<string> {
  const path = join(await mkdtemp(join(tmpdir(), "provider-dock-unreadable-")), basename);
  await mkdir(path);
  return path;
}

// A portal repository whose destructive-seam read rejects with the given raw error (its message may
// embed a file path or canary). Used to prove isReferenced projects one fixed, secret-free cause.
function throwingPortalRepository(failure: Error): MemoryPortalRepository {
  const portals = new MemoryPortalRepository();
  portals.list = async () => { throw failure; };
  return portals;
}

// A provider-profile repository whose read rejects; pins the profile-read failure independently.
function throwingProfileRepository(failure: Error): MemoryProviderProfileRepository {
  const profiles = new MemoryProviderProfileRepository();
  profiles.list = async () => { throw failure; };
  return profiles;
}
