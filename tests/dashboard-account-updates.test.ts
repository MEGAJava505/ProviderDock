import { describe, expect, it } from "vitest";
import { NewApiPortalAdapter, displayQuota } from "../src/core/portals/new-api-portal-adapter.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { portalConnectionSchema } from "../src/core/portals/portal-types.js";
import { normalizeSubscriptions, normalizeVessaRewards } from "../src/core/portals/portal-account-data.js";
import { usagePeriodStart, usageBreakdown } from "../src/ui/usage-timeline.js";
import { createUsageTelemetryEvent } from "../src/core/usage/usage-event.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { MemoryProviderHealthRepository } from "../src/core/health/provider-health-repository.js";
import { mergeModelCatalog } from "../src/core/providers/model-catalog.js";
import { buildModelStorefront } from "../src/ui/model-storefront.js";

const now = new Date("2026-09-07T12:00:00Z");
const site = { checkInEnabled: true, quotaPerUnit: 500000, quotaDisplayType: "CUSTOM" as const,
  customCurrencySymbol: "🍊", customCurrencyExchangeRate: 1 };

describe("account display and sessions", () => {
  it("converts Bezhi raw quota to its own units and CNY using the published rate", () => {
    expect(displayQuota(46455000, site)).toEqual({ amount: 92.91, currency: "🍊", source: "site-display" });
    expect(displayQuota(500000, { ...site, quotaDisplayType: "CNY", usdExchangeRate: 7.2 })?.amount).toBe(7.2);
    expect(displayQuota(500000, { ...site, customCurrencyExchangeRate: null })).toBeNull();
    expect(displayQuota(0, site)?.amount).toBe(0);
    expect(displayQuota(-500000, site)?.amount).toBe(-1);
  });

  it("reads a Vessa session with Cookie, isolates metadata, and normalizes rewards/subscriptions", async () => {
    const requests: string[] = [];
    const connection = portalConnectionSchema.parse({ providerId: "vessa", siteUrl: "https://vsllm.cc", userId: 7, userAgent: "Browser/1",
      auth: { kind: "cookie", secretRef: "SESSION" } });
    const adapter = new NewApiPortalAdapter(new MemorySecretStore({ SESSION: "session=private-session" }), { fetchImpl: async (url, init) => {
      const path = new URL(String(url)).pathname; requests.push(path);
      expect(init?.method).toBe("GET"); expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("cookie")).toBe(path === "/api/status" ? null : "session=private-session");
      expect(headers.get("new-api-user")).toBe(path === "/api/status" ? null : "7");
      expect(headers.get("user-agent")).toBe(path === "/api/status" ? null : "Browser/1");
      const data = path.endsWith("/status") && path.includes("gwent") ? { enabled: true, charges_current: 2, extra_draws_left: 1, charges_max: 5, cooldown_seconds: 10800, next_charge_at: now.valueOf()/1000+10800 } :
        path === "/api/status" ? { quota_per_unit: 500000, quota_display_type: "CUSTOM", custom_currency_symbol: "🍊", custom_currency_exchange_rate: 1, checkin_enabled: false } :
        path === "/api/user/self" ? { id: 7, quota: 46455000, email: "private@example.com" } :
        path === "/api/subscription/self" ? { subscriptions: [{ subscription: { plan_id: 1, status: "active", end_time: now.valueOf()/1000+86400, amount_total: 5000, amount_used: 100 }, plan: { title: "Premium" } }] } :
        path === "/api/pricing" ? [{ model_name: "one", quota_type: 0, model_ratio: 1, completion_ratio: 2, enable_groups: ["cheap"] }] : { models: [] };
      return Response.json({ success: true, data, group_ratio: { cheap: 0.01 } });
    } });
    const result = await adapter.read(connection, now);
    expect(result.wallet.value?.displayBalance?.amount).toBe(92.91);
    expect(result.catalog?.value?.models[0]?.groups[0]?.prices?.inputPerMillion).toBe(0.02);
    expect(result.catalog?.value?.models[0]?.basePrices.currency).toBe("🍊");
    expect(result.rewards?.value).toMatchObject({ availableAttempts: 3, cooldownSeconds: 10800 });
    expect(result.subscriptions?.value?.items[0]).toMatchObject({ name: "Premium", status: "active" });
    expect(requests).toContain("/api/gwent/status");
    expect(JSON.stringify(result)).not.toMatch(/private-session|private@example/);
  });

  it("reads Vyce Account Credits and subscription without fabricating a quota", async () => {
    const adapter = new NewApiPortalAdapter(new MemorySecretStore({ SESSION: "jwt-secret" }), { fetchImpl: async (url, init) => {
      expect(String(url)).toBe("https://vyceai.com/user/dashboard");
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer jwt-secret");
      return Response.json({ user: { id: "account-id", totalBalance: 12.345678, tier: "pro", tierExpiresAt: "2026-10-01T00:00:00Z", email: "private@example.com" },
        keys: [{ key: "sk-private" }], models: [{ id: "one", inputPrice: 0.1, outputPrice: 0.4, status: "maintenance" }] });
    } });
    const result = await adapter.read(portalConnectionSchema.parse({ providerId: "vyce", siteUrl: "https://vyceai.com", auth: { kind: "bearer", secretRef: "SESSION" } }), now);
    expect(result.wallet.value).toMatchObject({ remainingQuota: null, displayBalance: { amount: 12.345678, currency: "USD" } });
    expect(result.subscriptions?.value?.items[0]?.status).toBe("active");
    expect(result.catalog?.value?.models[0]?.availability).toBe("maintenance");
    expect(JSON.stringify(result)).not.toMatch(/jwt-secret|sk-private|private@example/);
  });

  it("does not assume attempts or active subscriptions when fields are unknown or expired", () => {
    expect(normalizeVessaRewards({ enabled: true }).availableAttempts).toBeNull();
    expect(normalizeSubscriptions({ subscriptions: [{ subscription: { plan_id: 1, status: "active", end_time: 1 } }] }, now).items[0]?.status).toBe("expired");
  });

  it("keeps Vyce credits readable if its model response changes", async () => {
    const adapter = new NewApiPortalAdapter(new MemorySecretStore({ SESSION: "secret" }), { fetchImpl: async () =>
      Response.json({ user: { id: "one", totalBalance: 0, tier: "free" }, models: null }) });
    const result = await adapter.read(portalConnectionSchema.parse({ providerId: "vyce", siteUrl: "https://vyceai.com", auth: { kind: "cookie", secretRef: "SESSION" } }), now);
    expect(result.wallet.value?.displayBalance?.amount).toBe(0);
    expect(result.catalog?.code).toBe("INVALID_RESPONSE");
    expect(result.subscriptions?.value?.items).toEqual([]);
  });
});

describe("daily usage and disappearing models", () => {
  const profile = parseProviderProfile({ id: "one", displayName: "One", baseUrl: "https://one.invalid/v1" });
  it("groups Monday weeks over the year boundary and keeps sessions and token types separate", () => {
    expect(usagePeriodStart("2027-01-03", "week")).toBe("2026-12-28");
    expect(usagePeriodStart("2027-01-04", "week")).toBe("2027-01-04");
    const event = createUsageTelemetryEvent({ profile, modelId: "m", client: "codex", protocol: "openai-responses", sessionId: "one", outcome: "completed",
      usage: { uncachedInputTokens: 100, cacheReadInputTokens: 20, cacheWriteInputTokens: 10, outputTokens: 50, reasoningOutputTokens: 30, webSearchRequests: 2, totalTokens: 180 } });
    const rows = usageBreakdown([event, { ...event, sessionId: "two", outcome: "incomplete" }]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ total: 180, input: 100, output: 50, reasoning: 30, searches: 2 });
    expect(rows[1]?.incomplete).toBe(1);
  });

  it("keeps a disappeared discovered model visible and clears the warning when it returns", async () => {
    const records = new MemoryProviderHealthRepository();
    const health = { providerId: "one", status: "ONLINE" as const, checkedAt: now.toISOString(), latencyMs: 1, discoveredModelCount: 1, appliedFixes: [] };
    await records.record({ health, models: mergeModelCatalog(profile, [{ modelId: "gone", displayName: "Gone", raw: {} }]) });
    await records.record({ health: { ...health, discoveredModelCount: 0 }, models: [] });
    expect(buildModelStorefront([profile], await records.list(), now)[0]).toMatchObject({ modelId: "gone", status: "OFFLINE", availabilityReason: "Модель исчезла из списка API", listedForApiKey: false });
    expect(buildModelStorefront([profile], await records.list(), new Date(now.valueOf()+60001))[0]?.status).toBe("OFFLINE");
    expect(buildModelStorefront([profile], await records.list(), new Date(now.valueOf()+48*60*60*1000))).toEqual([]);
    await records.record({ health, models: mergeModelCatalog(profile, [{ modelId: "gone", displayName: "Gone", raw: {} }]) });
    expect(buildModelStorefront([profile], await records.list(), now)[0]).toMatchObject({ availabilityReason: null, listedForApiKey: true });
  });
});
