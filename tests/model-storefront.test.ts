import { describe, expect, it } from "vitest";
import { buildModelStorefront } from "../src/ui/model-storefront.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { mergeModelCatalog } from "../src/core/providers/model-catalog.js";
import { createProviderRuntimeHealthSignal } from "../src/core/health/provider-runtime-health.js";
import type { ProviderHealthRecord } from "../src/core/health/provider-health-repository.js";
import { calculateUsageCost } from "../src/core/usage/usage-event.js";

const now = new Date("2026-09-07T12:00:00Z");
const profile = parseProviderProfile({ id: "one", displayName: "One", baseUrl: "https://one.invalid/v1", manualModelIds: ["shared"],
  modelPricing: { shared: { currency: "USD", inputPerMillion: 1.25, outputPerMillion: 5 } } });
const probe = { providerId: "one", status: "ONLINE" as const, checkedAt: now.toISOString(), latencyMs: 12, discoveredModelCount: 1, appliedFixes: [] };
const record: ProviderHealthRecord = { providerId: "one", history: [], diagnostics: [], runtimeSignals: [],
  latest: { health: probe, models: mergeModelCatalog(profile, [{ modelId: "shared", displayName: "Shared", raw: {} }]) } };
const signal = (observedAt: string, failed = false) => createProviderRuntimeHealthSignal({ providerId: "one", modelId: "shared",
  client: "codex", protocol: "openai-responses", observedAt: new Date(observedAt), outcome: failed ? "failed" : "completed",
  ...(failed ? { errorType: "RATE_LIMIT" as const, httpStatus: 429 } : {}) });

describe("model storefront", () => {
  it("does not price unconfigured paid server tools as free", () => {
    expect(calculateUsageCost({ uncachedInputTokens: 10, cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0, outputTokens: 2, reasoningOutputTokens: 0,
      webSearchRequests: 1, totalTokens: 12 }, profile.modelPricing.shared)).toBeUndefined();
  });
  it("keeps equal model IDs from different providers and distinguishes unknown from free", () => {
    const second = parseProviderProfile({ ...profile, id: "two", displayName: "Two", modelPricing: {} });
    const rows = buildModelStorefront([profile, second], [record], now);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ providerId: "one", status: "UNKNOWN", pricing: { inputPerMillion: 1.25, source: "manual", verifiedAt: null }, balance: null, providerLoad: null });
    expect(rows[1]).toMatchObject({ providerId: "two", status: "UNKNOWN", pricing: null });
    expect(rows[0]).not.toHaveProperty("latencyMs"); // Catalog HTTP time is not inference latency.
    const free = parseProviderProfile({ ...profile, modelPricing: { shared: { inputPerMillion: 0, outputPerMillion: 0 } } });
    expect(buildModelStorefront([free], [], now)[0]?.pricing?.inputPerMillion).toBe(0);
  });

  it("preserves real model evidence across successful metadata refreshes", () => {
    const row = buildModelStorefront([profile], [{ ...record, runtimeSignals: [signal("2026-09-07T11:59:00Z", true)] }], now)[0];
    expect(row).toMatchObject({ status: "RATE_LIMITED", total: 1, err: 1, rateLimited: 1, providerLoad: null });
  });

  it("expires old checks, bounds local observations, and respects disabled providers", () => {
    const history = [signal("2026-09-05T12:00:00Z", true), ...Array.from({ length: 35 }, () => signal("2026-09-07T11:00:00Z"))];
    expect(buildModelStorefront([profile], [{ ...record, runtimeSignals: history }], now)[0])
      .toMatchObject({ status: "UNKNOWN", stale: true, total: 30, ok: 30, rateLimited: 0 });
    expect(buildModelStorefront([{ ...profile, enabled: false }], [{ ...record, runtimeSignals: [signal("2026-09-07T11:59:00Z")] }], now)[0]?.status).toBe("DISABLED");
  });

  it("lets a fresh account authentication error override earlier model success", () => {
    const latest = { ...record.latest!, health: { ...probe, status: "AUTH_ERROR" as const } };
    expect(buildModelStorefront([profile], [{ ...record, latest, runtimeSignals: [signal("2026-09-07T11:59:00Z")] }], now)[0]?.status).toBe("AUTH_ERROR");
  });
});
