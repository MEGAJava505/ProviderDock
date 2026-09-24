import { describe, expect, it, vi } from "vitest";
import {
  AgentRouterAdapter,
  GenericAnthropicAdapter,
  GenericOpenAiAdapter,
  GoRouterAdapter,
  MemoryProviderProfileRepository,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  agentRouterIdentityDefaults,
  createAgentRouterProfile,
  createGoRouterProfile,
  parseProviderProfile,
} from "../src/index.js";

// Consolidated provider-adapter suites: GenericAnthropicAdapter (was
// generic-anthropic-adapter), GenericOpenAiAdapter (was generic-openai-adapter),
// and AgentRouterAdapter/GoRouterAdapter (was agentrouter-adapter). Each keeps
// its own describe so a failure points at exactly one adapter.

describe("GenericAnthropicAdapter", () => {
  it("discovers Anthropic models with required version and secret auth headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-x", display_name: "Claude X" },
            { id: "claude-x", display_name: "Claude X current" },
            { id: "claude-y" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new GenericAnthropicAdapter({
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "secret" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "anthropic",
      displayName: "Anthropic Gateway",
      baseUrl: "https://anthropic.test/v1",
      apiType: "anthropic-messages",
      adapterId: "generic-anthropic",
      auth: { kind: "header", headerName: "x-api-key", secretRef: "ANTHROPIC_KEY" },
    });

    expect(adapter.supports(profile)).toBe(true);
    const models = await adapter.discoverModels(profile);
    expect(models.map((model) => model.modelId)).toEqual(["claude-x", "claude-y"]);
    expect(models[0]?.displayName).toBe("Claude X current");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://anthropic.test/v1/models");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });
  it("normalizes unsupported model schemas as protocol errors", async () => {
    const adapter = new GenericAnthropicAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: "missing-id" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    const profile = parseProviderProfile({
      id: "anthropic",
      displayName: "Anthropic Gateway",
      baseUrl: "https://anthropic.test/v1",
      apiType: "anthropic-messages",
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "PROTOCOL_ERROR",
    });
  });
});
describe("GenericOpenAiAdapter", () => {
  it("discovers and deduplicates models with secret-backed authentication", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-x", display_name: "GPT X" },
            { id: "gpt-x", display_name: "GPT X duplicate" },
            { id: "gpt-y" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore({ ROUTER_KEY: "secret-value" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
      staticHeaders: { "X-Client": "ProviderDock" },
      queryParameters: { source: "desktop" },
    });

    const models = await adapter.discoverModels(profile);

    expect(models.map((model) => model.modelId)).toEqual(["gpt-x", "gpt-y"]);
    expect(models[0]?.displayName).toBe("GPT X duplicate");
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://example.test/v1/models?source=desktop");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-value");
    expect(headers.get("x-client")).toBe("ProviderDock");
  });
  it("fails before the request when a referenced secret is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "header", headerName: "x-api-key", secretRef: "MISSING_KEY" },
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "AUTH_ERROR",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retains only a sanitized upstream error detail", async () => {
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: {
              message: "api_key=sk-secret12345 rejected",
              code: "invalid_api_key",
              raw: "must-not-be-retained",
            },
          }),
          { status: 401 },
        ),
      ),
    });

    await expect(
      adapter.discoverModels(
        parseProviderProfile({
          id: "router",
          displayName: "Router",
          baseUrl: "https://example.test/v1",
        }),
      ),
    ).rejects.toMatchObject({
      type: "AUTH_ERROR",
      sanitizedDetail: expect.stringContaining("[REDACTED]"),
    });
  });
  it("normalizes malformed success payloads as protocol errors", async () => {
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      ),
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "PROTOCOL_ERROR",
    });
  });
});
describe("AgentRouterAdapter", () => {
  it("applies the known client identity and filters non-OpenAI models", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "openai-only", supported_endpoint_types: ["openai"] },
            { id: "anthropic-only", supported_endpoint_types: ["anthropic"] },
            { id: "unspecified" },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new AgentRouterAdapter({
      secretStore: new MemorySecretStore({ AGENTROUTER_API_KEY: "secret-value" }),
      fetchImpl: fetchMock,
    });
    const profile = createAgentRouterProfile();

    const models = await adapter.discoverModels(profile);

    expect(models.map((model) => model.modelId)).toEqual(["openai-only", "unspecified"]);
    const requestHeaders = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(requestHeaders.get("authorization")).toBe("Bearer secret-value");
    expect(requestHeaders.get("user-agent")).toBe(agentRouterIdentityDefaults["User-Agent"]);
    expect(requestHeaders.get("originator")).toBe(agentRouterIdentityDefaults.Originator);
  });

  it("does not invent GLM reasoning levels when AgentRouter omits metadata", async () => {
    const adapter = new AgentRouterAdapter({
      secretStore: new MemorySecretStore({ AGENTROUTER_API_KEY: "secret-value" }),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: [
              { id: "glm-5.3", object: "model", owned_by: "custom", supported_endpoint_types: ["openai"] },
            ],
          }),
          { status: 200 },
        ),
      ),
    });

    const models = await adapter.discoverModels(createAgentRouterProfile());

    expect(models).toHaveLength(1);
    expect(models[0]?.raw.supported_reasoning_levels).toBeUndefined();
  });
  it("preserves an explicit identity override", () => {
    const adapter = new AgentRouterAdapter({ secretStore: new MemorySecretStore() });
    const prepared = adapter.prepareProfile(
      createAgentRouterProfile({
        overrides: { staticHeaders: { "user-agent": "custom-client", Originator: "custom" } },
      }),
    );

    expect(prepared.staticHeaders).toEqual({
      "user-agent": "custom-client",
      Originator: "custom",
    });
  });

  it("reports scoped compatibility fixes through provider diagnostics", async () => {
    const adapter = new AgentRouterAdapter({
      secretStore: new MemorySecretStore({ AGENTROUTER_API_KEY: "secret-value" }),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ data: [{ id: "model-x" }] }), { status: 200 }),
      ),
    });
    const result = await new ProviderProbeService(
      new ProviderAdapterRegistry().register(adapter),
    ).probe(createAgentRouterProfile());

    expect(result.health.status).toBe("ONLINE");
    expect(result.health.appliedFixes).toEqual([
      "fix.auth.client-identity",
      "fix.models.openai-endpoint-filter",
    ]);
  });
  it("persists identity defaults through the application service", async () => {
    const adapter = new AgentRouterAdapter({ secretStore: new MemorySecretStore() });
    const adapters = new ProviderAdapterRegistry().register(adapter);
    const profiles = new MemoryProviderProfileRepository();
    const application = new ProviderDockApplication(
      profiles,
      new ProviderProbeService(adapters),
      undefined,
      undefined,
      adapters,
    );

    const stored = await application.setProvider({
      id: "agentrouter",
      displayName: "AgentRouter",
      baseUrl: "https://agentrouter.org/v1",
      apiType: "auto",
      adapterId: "agentrouter",
      auth: { kind: "bearer", secretRef: "AGENTROUTER_API_KEY" },
    });

    expect(stored.staticHeaders).toMatchObject(agentRouterIdentityDefaults);
    expect((await profiles.get("agentrouter"))?.staticHeaders).toMatchObject(
      agentRouterIdentityDefaults,
    );
  });
});
describe("GoRouterAdapter", () => {
  it("uses an isolated adapter scope without invented provider fixes", () => {
    const profile = createGoRouterProfile({
      baseUrl: "https://gorouter.example/v1",
      secretRef: "GOROUTER_API_KEY",
    });
    const adapter = new GoRouterAdapter({ secretStore: new MemorySecretStore() });

    expect(profile.adapterId).toBe("gorouter");
    expect(profile.staticHeaders).toEqual({});
    expect(adapter.supports(profile)).toBe(true);
    expect(adapter.compatibilityFixes()).toEqual([]);
  });
});
