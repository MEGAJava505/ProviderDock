import { describe, expect, it, vi } from "vitest";
import { normalizeNewApiCatalog, normalizeNewApiPerformance } from "../src/core/portals/new-api-catalog.js";
import { NewApiPortalAdapter } from "../src/core/portals/new-api-portal-adapter.js";
import { portalConnectionSchema } from "../src/core/portals/portal-types.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { buildModelStorefront } from "../src/ui/model-storefront.js";
import { providerProfileSchema } from "../src/core/providers/provider-profile.js";

const now = new Date("2026-09-07T12:00:00Z");
const model = { model_name: "model-one", quota_type: 0, model_ratio: 1.5, completion_ratio: 6,
  cache_ratio: 0.1, create_cache_ratio: 1.25, enable_groups: ["default", "premium", "free", "unknown"],
  supported_endpoint_types: ["openai", "openai-response"], vendor_id: 1 };
const pricing = { success: true, data: [model], group_ratio: { default: 1, premium: 2, free: 0 },
  vendors: [{ id: 1, name: "Example" }] };

describe("New API storefront data", () => {
  it("converts token ratios once, preserves free groups and leaves missing multipliers unknown", () => {
    const result = normalizeNewApiCatalog(pricing).models[0]!;
    expect(result.basePrices).toEqual({ currency: "USD", inputPerMillion: 3, outputPerMillion: 18,
      cacheReadInputPerMillion: expect.closeTo(0.3), cacheWriteInputPerMillion: 3.75, perRequest: null });
    expect(result.groups[1]?.prices?.outputPerMillion).toBe(36);
    expect(result.groups[2]?.prices?.inputPerMillion).toBe(0);
    expect(result.groups[3]).toMatchObject({ multiplier: null, prices: null });
    expect(result.endpointTypes).toEqual(["openai", "openai-response"]);
    expect(result.vendor).toBe("Example");
  });

  it("keeps per-request pricing separate and never estimates dynamic billing as a flat rate", () => {
    const result = normalizeNewApiCatalog({ ...pricing, data: [
      { ...model, model_name: "request", quota_type: 1, model_price: 0.2 },
      { ...model, model_name: "dynamic", billing_mode: "tiered_expr", billing_expr: "unknown-expression" },
    ] }).models;
    expect(result[0]?.basePrices).toMatchObject({ perRequest: 0.2, inputPerMillion: null, outputPerMillion: null });
    expect(result[0]?.groups[1]?.prices?.perRequest).toBe(0.4);
    expect(result[1]?.billing).toBe("dynamic");
    expect(result[1]?.basePrices.inputPerMillion).toBeNull();
    expect(JSON.stringify(result)).not.toContain("unknown-expression");
  });

  it("does not coerce null, absent, negative, overflowing or string prices to free", () => {
    for (const value of [undefined, null, "0", -1, Number.MAX_VALUE]) {
      const row = normalizeNewApiCatalog({ data: [{ ...model, model_ratio: value }] }).models[0]!;
      expect(row.basePrices.inputPerMillion).toBeNull();
      expect(row.basePrices.outputPerMillion).toBeNull();
    }
    const row = normalizeNewApiCatalog({ data: [{ ...model, cache_ratio: undefined, completion_ratio: undefined }] }).models[0]!;
    expect(row.basePrices.inputPerMillion).toBe(3);
    expect(row.basePrices.outputPerMillion).toBeNull();
    expect(row.basePrices.cacheReadInputPerMillion).toBeNull();
  });

  it("rejects ambiguous duplicate models and malformed or unbounded catalogs", () => {
    expect(() => normalizeNewApiCatalog({ data: [model, model] })).toThrow();
    expect(() => normalizeNewApiCatalog({ data: {} })).toThrow();
    expect(() => normalizeNewApiCatalog({ data: Array(5001).fill(model) })).toThrow();
  });

  it("preserves the provider's percentage and latency units without inventing load", () => {
    const result = normalizeNewApiPerformance({ models: [{ model_name: "model-one", avg_tps: 3.82,
      avg_latency_ms: 14300, success_rate: 36.51 }, { model_name: "empty", success_rate: 999 }] });
    expect(result.models[0]).toEqual({ modelId: "model-one", tokensPerSecond: 3.82, latencyMs: 14300, successRatePct: 36.51 });
    expect(result.models[1]).toMatchObject({ tokensPerSecond: null, latencyMs: null, successRatePct: null });
    expect(result).not.toHaveProperty("load");
  });

  it("reads metadata with the account token, exposes site-only models and preserves manual billing estimates", async () => {
    const connection = portalConnectionSchema.parse({ providerId: "one", siteUrl: "https://one.invalid/profile",
      userId: 7, auth: { kind: "bearer", secretRef: "ACCOUNT" } });
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      const path = new URL(String(url)).pathname;
      expect(init?.method).toBe("GET");
      expect(new Headers(init?.headers).get("authorization")).toBe(path === "/api/status" ? null : "Bearer portal-secret");
      expect(new Headers(init?.headers).get("New-Api-User")).toBe(path === "/api/status" ? null : "7");
      return Response.json(path === "/api/pricing" ? pricing : { success: true, data:
        path.endsWith("/self") ? { id: 7, quota: 0 } : path.endsWith("/checkin") ? { enabled: false } :
          path.endsWith("/summary") ? { models: [{ model_name: "model-one", avg_tps: 10 }] } :
            { checkin_enabled: false, quota_display_type: "USD", quota_per_unit: 500000 } });
    });
    const latest = await new NewApiPortalAdapter(new MemorySecretStore({ ACCOUNT: "portal-secret", API: "inference-secret" }), { fetchImpl }).read(connection, now);
    expect(latest.catalog?.value?.models).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    const profile = providerProfileSchema.parse({ id: "one", displayName: "One", baseUrl: "https://api.invalid/v1",
      modelPricing: { "model-one": { currency: "USD", inputPerMillion: 99, outputPerMillion: 100 } } });
    const rows = buildModelStorefront([profile], [], new Date(now.valueOf()+300001), [{ connection, revision: "318a0772-f91e-4100-9e3f-f60c0b809c44", failures: 0, latest }]);
    expect(rows[0]).toMatchObject({ status: "UNKNOWN", listedForApiKey: false, pricing: { inputPerMillion: 99, source: "manual" },
      siteModel: { basePrices: { inputPerMillion: 3 } }, siteCatalog: { stale: true }, sitePerformance: { stale: true, tokensPerSecond: 10 } });
    expect(JSON.stringify(rows)).not.toMatch(/portal-secret|inference-secret/);
    expect(profile.modelPricing["model-one"]?.inputPerMillion).toBe(99);
  });

  it("keeps wallet available if pricing requires another auth scheme; hides catalog on account mismatch", async () => {
    const connection = portalConnectionSchema.parse({ providerId: "one", siteUrl: "https://one.invalid",
      userId: 7, auth: { kind: "bearer", secretRef: "ACCOUNT" } });
    const read = async (mismatch: boolean) => new NewApiPortalAdapter(new MemorySecretStore({ ACCOUNT: "portal-secret" }), {
      fetchImpl: async (url) => String(url).endsWith("/pricing")
        ? mismatch ? Response.json(pricing) : new Response("portal-secret", { status: 401 })
        : Response.json({ success: true, data: String(url).endsWith("/self") ? { id: mismatch ? 8 : 7, quota: 5 }
          : String(url).endsWith("/status") ? { checkin_enabled: false } : { models: [] } }),
    }).read(connection, now);
    expect((await read(false)).wallet.status).toBe("ok");
    expect((await read(false)).catalog).toMatchObject({ status: "auth-required", value: null });
    expect((await read(true)).catalog).toMatchObject({ code: "ACCOUNT_MISMATCH", value: null });
  });
});
