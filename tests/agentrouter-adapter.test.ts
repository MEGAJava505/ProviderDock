import { describe, expect, it, vi } from "vitest";
import {
  AgentRouterAdapter,
  GoRouterAdapter,
  MemorySecretStore,
  MemoryProviderProfileRepository,
  ProviderAdapterRegistry,
  ProviderDockApplication,
  ProviderProbeService,
  agentRouterIdentityDefaults,
  createAgentRouterProfile,
  createGoRouterProfile,
} from "../src/index.js";

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
