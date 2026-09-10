import { describe, expect, it, vi } from "vitest";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { NofxPortalAdapter } from "../src/core/portals/nofx-portal-adapter.js";
import { portalConnectionSchema } from "../src/core/portals/portal-types.js";

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

describe("NoFX portal adapter", () => {
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
