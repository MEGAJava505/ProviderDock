import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ProviderProbeService,
  parseProviderProfile,
} from "../src/index.js";

describe("ProviderProbeService", () => {
  it("returns an online snapshot and merges discovered with manual models", async () => {
    const registry = registryWithResponse(
      new Response(JSON.stringify({ data: [{ id: "discovered" }] }), { status: 200 }),
    );
    const probe = new ProviderProbeService(registry, {
      now: () => new Date("2026-08-29T00:00:00.000Z"),
      monotonicNow: sequenceClock(10, 25),
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      manualModelIds: ["manual", "discovered"],
    });

    const result = await probe.probe(profile);

    expect(result.health).toEqual({
      providerId: "router",
      status: "ONLINE",
      checkedAt: "2026-08-29T00:00:00.000Z",
      latencyMs: 15,
      discoveredModelCount: 1,
      appliedFixes: [],
    });
    expect(result.models.map(({ modelId, source, healthStatus }) => ({
      modelId,
      source,
      healthStatus,
    }))).toEqual([
      { modelId: "discovered", source: "discovered", healthStatus: "ONLINE" },
      { modelId: "manual", source: "manual", healthStatus: "UNKNOWN" },
    ]);
  });

  it.each([
    [401, "AUTH_ERROR", "AUTH_ERROR"],
    [429, "RATE_LIMITED", "RATE_LIMIT"],
    [503, "OFFLINE", "PROVIDER_UNAVAILABLE"],
  ] as const)(
    "maps HTTP %s to %s health",
    async (httpStatus, expectedHealth, expectedError) => {
      const result = await new ProviderProbeService(
        registryWithResponse(new Response("failure", { status: httpStatus })),
      ).probe(
        parseProviderProfile({
          id: "router",
          displayName: "Router",
          baseUrl: "https://example.test/v1",
          manualModelIds: ["configured-model"],
        }),
      );

      expect(result.health.status).toBe(expectedHealth);
      expect(result.health.errorType).toBe(expectedError);
      expect(result.health.httpStatus).toBe(httpStatus);
      expect(result.models[0]?.healthStatus).toBe("UNKNOWN");
    },
  );

  it("does not contact disabled providers", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const registry = new ProviderAdapterRegistry().register(
      new GenericOpenAiAdapter({
        secretStore: new MemorySecretStore(),
        fetchImpl: fetchMock,
      }),
    );

    const result = await new ProviderProbeService(registry).probe(
      parseProviderProfile({
        id: "router",
        displayName: "Router",
        baseUrl: "https://example.test/v1",
        enabled: false,
      }),
    );

    expect(result.health.status).toBe("DISABLED");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function registryWithResponse(response: Response): ProviderAdapterRegistry {
  return new ProviderAdapterRegistry().register(
    new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response),
    }),
  );
}

function sequenceClock(...values: number[]): () => number {
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)] ?? 0;
}
