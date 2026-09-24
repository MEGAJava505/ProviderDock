import { describe, expect, it, vi } from "vitest";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { HelyxPortalAdapter } from "../src/core/portals/helyx-portal-adapter.js";
import { NofxPortalAdapter } from "../src/core/portals/nofx-portal-adapter.js";
import { portalConnectionSchema } from "../src/core/portals/portal-types.js";

// Consolidated cookie-portal adapter suites: Helyx portal adapter (was
// helyx-portal) and NoFX portal adapter (was nofx-portal). Each keeps its own
// describe and per-suite fixtures so a failure points at exactly one adapter.

describe("Helyx portal adapter", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  const connection = portalConnectionSchema.parse({
    providerId: "helyx",
    siteUrl: "https://helyxai.space",
    adapterId: "helyx",
    auth: { kind: "cookie", secretRef: "HELYX_COOKIE" },
  });
  const dashboard = '<p class="d-label">Current Balance</p><p class="d-stat">$12.75</p>' +
    '<p class="d-label">Total Used Tokens</p><p class="d-stat">1,234,567</p>' +
    '<p class="d-label">Used Balance</p><p class="d-stat">$3.25</p>';
  const models = '<table><tr class="model-row" data-provider="Anthropic" data-discount="0" data-claim="0">' +
    '<td data-label="Model"><b>Claude Haiku 4.5</b></td>' +
    '<td data-label="API string"><span class="slug-pill">claude-haiku-4-5</span></td>' +
    '<td data-label="Context">1M</td>' +
    '<td data-label="Rate / 1M"><span>in</span> $1.00 <span>out</span> $5.00</td>' +
    '</tr><tr class="model-row" data-provider="OpenAI">' +
    '<td data-label="Model"><b>GPT Test</b></td><td data-label="API string">gpt-test</td>' +
    '<td data-label="Context">128K</td><td data-label="Rate / 1M">in $2.50 out $10.00</td></tr></table>';
  const html = (value: string, status = 200, headers: Record<string, string> = {}) => new Response(value, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
  });
  it("parses the dashboard wallet and public server-rendered model catalog", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      if (path === "/dashboard") {
        expect(headers.get("cookie")).toBe("helyx_session=browser-secret");
        return html(dashboard);
      }
      if (path === "/models-list") {
        expect(headers.get("cookie")).toBeNull();
        return html(models);
      }
      throw new Error("Unexpected URL: " + url);
    });
    const snapshot = await new HelyxPortalAdapter(
      new MemorySecretStore({ HELYX_COOKIE: "helyx_session=browser-secret" }),
      { fetchImpl },
    ).read(connection, now);

    expect(snapshot.wallet.value).toMatchObject({
      remainingQuota: null,
      usedQuota: 1234567,
      displayBalance: { amount: 12.75, currency: "USD", source: "site-display" },
    });
    expect(snapshot.catalog?.value?.models).toEqual([
      expect.objectContaining({
        modelId: "claude-haiku-4-5",
        description: "Claude Haiku 4.5",
        vendor: "Anthropic",
        contextTokens: 1000000,
        billing: "tokens",
        basePrices: expect.objectContaining({ inputPerMillion: 1, outputPerMillion: 5 }),
      }),
      expect.objectContaining({
        modelId: "gpt-test",
        contextTokens: 128000,
        basePrices: expect.objectContaining({ inputPerMillion: 2.5, outputPerMillion: 10 }),
      }),
    ]);
    expect(snapshot.site.status).toBe("unsupported");
    expect(snapshot.checkIn.status).toBe("unsupported");
    expect(JSON.stringify(snapshot)).not.toContain("browser-secret");
  });
  it("keeps the public catalog available when the dashboard redirects to signup", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => new URL(String(url)).pathname === "/dashboard"
      ? html("", 302, { location: "/signup.php" })
      : html(models));
    const snapshot = await new HelyxPortalAdapter(
      new MemorySecretStore({ HELYX_COOKIE: "expired" }),
      { fetchImpl },
    ).read(connection, now);

    expect(snapshot.wallet).toMatchObject({ status: "auth-required", code: "AUTH_REQUIRED", httpStatus: 302 });
    expect(snapshot.catalog?.status).toBe("ok");
    expect(snapshot.catalog?.value?.models).toHaveLength(2);
  });

  it("does not request the private dashboard without a cookie", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => html(models));
    const snapshot = await new HelyxPortalAdapter(new MemorySecretStore(), { fetchImpl }).read(connection, now);

    expect(snapshot.wallet).toMatchObject({ status: "auth-required", code: "MISSING_SECRET" });
    expect(snapshot.catalog?.status).toBe("ok");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});
describe("NoFX portal adapter", () => {
  const now = new Date("2026-09-09T12:00:00.000Z");
  const connection = portalConnectionSchema.parse({
    providerId: "nofx",
    siteUrl: "https://nofx.one",
    adapterId: "nofx",
    auth: { kind: "cookie", secretRef: "NOFX_COOKIE" },
  });
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
  const html = (value: string) => new Response(value, { headers: { "content-type": "text/html; charset=utf-8" } });
  it("reads the wallet and model catalog through an active transient API key", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const path = new URL(String(url)).pathname;
      const headers = new Headers(init?.headers);
      if (path === "/api/portal/api-keys") {
        expect(headers.get("cookie")).toBe("session=browser-secret");
        return json({
          items: [{ id: "key-1", user_id: "user-42", key: "transient-api-key", status: "active", group: "default" }],
          usage: { "key-1": { today_actual_cost: 1.2, total_actual_cost: 3.4 } },
        });
      }
      if (path === "/en/api-keys") {
        expect(headers.get("cookie")).toBe("session=browser-secret");
        return html('<script>window.__data="{\\"api_base_url\\":\\"https:\\/\\/b45b95fa18bf.nofx.one\\"}"</script>');
      }
      expect(headers.get("authorization")).toBe("Bearer transient-api-key");
      if (path === "/v1/usage") {
        return json({
          balance: 25,
          remaining: 19.5,
          unit: "USD",
          isValid: true,
          planName: "Pro",
          usage: { total: { total_tokens: 123456, total_requests: 18 } },
          model_stats: [],
        });
      }
      if (path === "/v1/models") {
        return json({
          object: "list",
          data: [{ id: "claude-sonnet", object: "model", owned_by: "Anthropic", type: "chat", display_name: "Claude Sonnet" }],
        });
      }
      throw new Error("Unexpected URL: " + url);
    });
    const adapter = new NofxPortalAdapter(
      new MemorySecretStore({ NOFX_COOKIE: "session=browser-secret" }),
      { fetchImpl },
    );

    const snapshot = await adapter.read(connection, now);

    expect(snapshot.wallet.value).toMatchObject({
      group: "Pro",
      remainingQuota: null,
      usedQuota: 123456,
      displayBalance: { amount: 19.5, currency: "USD", source: "site-display" },
    });
    expect(snapshot.catalog?.value?.models).toEqual([
      expect.objectContaining({
        modelId: "claude-sonnet",
        description: "Claude Sonnet",
        vendor: "Anthropic",
        endpointTypes: ["chat"],
        billing: "unknown",
      }),
    ]);
    expect(snapshot.site.status).toBe("unsupported");
    expect(snapshot.checkIn.status).toBe("unsupported");
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(JSON.stringify(snapshot)).not.toMatch(/browser-secret|transient-api-key|user-42/);
  });

  it("classifies the portal API-key load failure as expired authentication", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => json({ code: "API_KEYS_LOAD_FAILED" }, 500));
    const snapshot = await new NofxPortalAdapter(
      new MemorySecretStore({ NOFX_COOKIE: "session=expired" }),
      { fetchImpl },
    ).read(connection, now);

    expect(snapshot.wallet).toMatchObject({ status: "auth-required", code: "AUTH_REQUIRED", httpStatus: 500 });
    expect(snapshot.catalog).toMatchObject({ status: "auth-required", code: "AUTH_REQUIRED", httpStatus: 500 });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("does not contact the portal when its saved cookie is missing", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const snapshot = await new NofxPortalAdapter(new MemorySecretStore(), { fetchImpl }).read(connection, now);

    expect(snapshot.wallet).toMatchObject({ status: "auth-required", code: "MISSING_SECRET" });
    expect(snapshot.catalog).toMatchObject({ status: "auth-required", code: "MISSING_SECRET" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
