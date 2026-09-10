import { afterEach, describe, expect, it } from "vitest";
import { ProviderDockApplication } from "../src/application/provider-dock-application.js";
import { ProviderDashboardServer } from "../src/ui/provider-dashboard-server.js";
import { MemoryProviderProfileRepository } from "../src/core/providers/provider-profile-repository.js";
import { ProviderAdapterRegistry } from "../src/core/providers/provider-adapter-registry.js";
import { ProviderProbeService } from "../src/core/health/provider-probe-service.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { MemoryPortalRepository } from "../src/core/portals/portal-repository.js";
import { ProviderPortalService } from "../src/core/portals/provider-portal-service.js";
import { portalSnapshotSchema, ProviderPortalAdapterRegistry } from "../src/core/portals/portal-types.js";
import { NewApiPortalAdapter } from "../src/core/portals/new-api-portal-adapter.js";

const servers: ProviderDashboardServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((server) => server.stop())); });
async function setup() {
  const secrets = new MemorySecretStore();
  const calls: string[] = [];
  const routedAdapters: string[] = [];
  const adapter = new NewApiPortalAdapter(secrets, { fetchImpl: async (url, init) => {
    calls.push(String(url));
    const data = String(url).endsWith("/pricing") ? [] : String(url).endsWith("/summary") ? { models: [] } : String(url).endsWith("/status") ? { checkin_enabled: true, quota_per_unit: 500000, quota_display_type: "USD" }
      : String(url).endsWith("/self") ? { id: 1, quota: 0, group: "default" }
      : { enabled: true, stats: { checked_in_today: false } };
    if (!String(url).endsWith("/status")) {
      const headers = new Headers(init?.headers);
      if (headers.has("cookie")) {
        expect(headers.get("cookie")).toBe("session=browser-secret");
        expect(headers.get("new-api-user")).toBe("1");
      } else {
        expect(headers.get("authorization")).toBe("Bearer account-secret");
      }
    }
    return new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
  } });
  const routedAdapter = (id: "nofx" | "helyx") => ({
    id,
    displayName: id === "nofx" ? "NoFX" : "Helyx AI",
    async read(connection: { readonly siteUrl: string; readonly refreshIntervalMs: number }, now: Date) {
      routedAdapters.push(id);
      const observation = {
        status: "unsupported" as const,
        code: "UNSUPPORTED_ENDPOINT" as const,
        sourceUrl: connection.siteUrl,
        observedAt: now.toISOString(),
        expiresAt: new Date(now.valueOf() + connection.refreshIntervalMs).toISOString(),
        value: null,
      };
      return portalSnapshotSchema.parse({ site: observation, wallet: observation, checkIn: observation });
    },
  });
  const portalAdapters = new ProviderPortalAdapterRegistry()
    .register(adapter)
    .register(routedAdapter("nofx"))
    .register(routedAdapter("helyx"));
  const portals = new ProviderPortalService(new MemoryPortalRepository(), portalAdapters);
  const application = new ProviderDockApplication(new MemoryProviderProfileRepository(), new ProviderProbeService(new ProviderAdapterRegistry()),
    secrets, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, portals);
  await application.setProvider({ id: "fixture", displayName: "Fixture", baseUrl: "https://inference.invalid/v1" });
  const server = new ProviderDashboardServer({ application, healthMonitorIntervalMs: 0 });
  servers.push(server);
  const address = await server.start();
  const request = (path: string, method: string, body?: unknown) => fetch(address.url + path, {
    method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { application, request, calls, routedAdapters, secrets };
}

describe("portal dashboard integration", () => {
  it("connects an account, reads zero balance and available check-in, and disconnects without deleting its API profile", async () => {
    const { application, request, calls } = await setup();
    expect((await request("api/secrets/PORTAL", "PUT", { value: "account-secret" })).status).toBe(200);
    const connected = await request("api/providers/fixture/portal", "PUT", {
      siteUrl: "https://account.invalid/profile", auth: { kind: "bearer", secretRef: "PORTAL" },
    });
    expect(connected.status).toBe(200);
    expect((await connected.json()).portal.connection.siteUrl).toBe("https://account.invalid");
    expect(calls).toHaveLength(0);
    const checked = await request("api/providers/fixture/portal/refresh", "POST");
    expect(checked.status).toBe(200);
    const snapshot = await (await request("api/snapshot", "GET")).json();
    expect(snapshot.portals[0].latest.wallet.value.displayBalance.amount).toBe(0);
    expect(snapshot.portals[0].latest.checkIn.value.eligibility).toBe("available");
    expect(JSON.stringify(snapshot)).not.toContain("account-secret");
    expect(snapshot.portalAdapters[0].id).toBe("new-api");
    expect(calls).toHaveLength(5);
    expect((await request("api/providers/fixture/portal", "DELETE")).status).toBe(200);
    expect(await application.listProviderPortals()).toEqual([]);
    expect((await application.getProvider("fixture")).baseUrl).toBe("https://inference.invalid/v1");
  });

  it("clears observed account data when its saved token is replaced or deleted", async () => {
    const { application, request } = await setup();
    await application.setSecret("PORTAL", "account-secret");
    await application.setProviderPortal({ providerId: "fixture", siteUrl: "https://account.invalid", auth: { kind: "bearer", secretRef: "PORTAL" } });
    await application.refreshProviderPortal("fixture");
    expect((await application.listProviderPortals())[0]?.lastWallet).toBeDefined();
    await request("api/secrets/PORTAL", "PUT", { value: "replacement-token" });
    expect((await application.listProviderPortals())[0]?.latest).toBeUndefined();
    expect((await application.listProviderPortals())[0]?.lastWallet).toBeUndefined();
    await application.removeSecret("PORTAL");
    await application.refreshProviderPortal("fixture");
    expect((await application.listProviderPortals())[0]?.latest?.wallet.code).toBe("MISSING_SECRET");
  });

  it("rejects unknown providers and unsafe cabinet URLs before upstream contact", async () => {
    const { request, calls } = await setup();
    expect((await request("api/providers/missing/portal", "PUT", { siteUrl: "https://account.invalid" })).status).toBe(404);
    expect((await request("api/providers/fixture/portal", "PUT", { siteUrl: "https://user:secret@account.invalid" })).status).toBe(400);
    expect(calls).toEqual([]);
  });

  it("imports Cookie-Editor data for one selected provider, keeps it secret, and refreshes the balance", async () => {
    const { application, request, secrets } = await setup();
    await application.setProvider({ id: "other", displayName: "Other", baseUrl: "https://other.invalid/v1" });
    await application.setSecret("OTHER_PORTAL", "account-secret");
    await application.setProviderPortal({
      providerId: "other", siteUrl: "https://account.invalid",
      auth: { kind: "bearer", secretRef: "OTHER_PORTAL" },
    });
    const response = await request("api/portals/import", "POST", {
      providerId: "fixture", siteUrl: "https://account.invalid/profile", adapterId: "new-api",
      authKind: "cookie",
      userId: 1, autoRefresh: true, refreshIntervalMs: 300000,
      raw: JSON.stringify([{ domain: ".account.invalid", path: "/", name: "session", value: "browser-secret" }]),
    });
    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(JSON.stringify(payload)).not.toContain("browser-secret");
    expect(payload.imported).toEqual(["fixture"]);
    expect(payload.refreshed).toBe(true);
    const portals = await application.listProviderPortals();
    const portal = portals.find((record) => record.connection.providerId === "fixture");
    if (portal === undefined) throw new Error("Expected a portal connection.");
    expect(portal?.connection).toMatchObject({ siteUrl: "https://account.invalid", userId: 1,
      auth: { kind: "cookie" } });
    expect(portal?.latest?.wallet.value?.displayBalance?.amount).toBe(0);
    if (portal?.connection.auth.kind === "none") throw new Error("Expected a stored browser session.");
    expect(await secrets.get(portal.connection.auth.secretRef)).toBe("session=browser-secret");
    expect(portals.find((record) => record.connection.providerId === "other")?.connection.auth)
      .toEqual({ kind: "bearer", secretRef: "OTHER_PORTAL" });
    expect(await secrets.get("OTHER_PORTAL")).toBe("account-secret");
  });

  it("imports an Access Token and strips an optional Bearer prefix before storage", async () => {
    const { application, request, secrets } = await setup();
    const response = await request("api/portals/import", "POST", {
      providerId: "fixture",
      siteUrl: "https://account.invalid/profile",
      adapterId: "new-api",
      authKind: "bearer",
      autoRefresh: true,
      refreshIntervalMs: 300000,
      raw: "Bearer account-secret",
    });

    expect(response.status).toBe(200);
    expect(JSON.stringify(await response.json())).not.toContain("account-secret");
    const portal = (await application.listProviderPortals())[0];
    expect(portal?.connection).toMatchObject({
      siteUrl: "https://account.invalid",
      adapterId: "new-api",
      auth: { kind: "bearer" },
    });
    if (!portal || portal.connection.auth.kind === "none") throw new Error("Expected token auth.");
    expect(await secrets.get(portal.connection.auth.secretRef)).toBe("account-secret");
    expect(portal.latest?.wallet.status).toBe("ok");
  });

  it("overrides the generic adapter for NoFX and Helyx imports by hostname", async () => {
    const { application, request, routedAdapters } = await setup();
    await application.setProvider({ id: "helyx", displayName: "Helyx", baseUrl: "https://api.helyx.invalid/v1" });
    const imports = [
      { providerId: "fixture", siteUrl: "https://portal.nofx.one/en/api-keys", expected: "nofx" },
      { providerId: "helyx", siteUrl: "https://helyxai.space/dashboard", expected: "helyx" },
    ] as const;

    for (const item of imports) {
      const hostname = new URL(item.siteUrl).hostname;
      const response = await request("api/portals/import", "POST", {
        providerId: item.providerId,
        siteUrl: item.siteUrl,
        adapterId: "new-api",
        authKind: "cookie",
        autoRefresh: true,
        refreshIntervalMs: 300000,
        raw: JSON.stringify([{ domain: "." + hostname, path: "/", name: "session", value: "browser-secret" }]),
      });
      expect(response.status).toBe(200);
    }

    const portals = await application.listProviderPortals();
    expect(portals.find((record) => record.connection.providerId === "fixture")?.connection.adapterId).toBe("nofx");
    expect(portals.find((record) => record.connection.providerId === "helyx")?.connection.adapterId).toBe("helyx");
    expect(routedAdapters).toEqual(["nofx", "helyx"]);
  });

  it("rejects cookies from another domain without changing portal or secret state", async () => {
    const { application, request, secrets } = await setup();
    const response = await request("api/portals/import", "POST", {
      providerId: "fixture", siteUrl: "https://account.invalid", adapterId: "new-api",
      authKind: "cookie",
      autoRefresh: true, refreshIntervalMs: 300000,
      raw: JSON.stringify([{ domain: ".other.invalid", path: "/", name: "session", value: "browser-secret" }]),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "NO_MATCHING_COOKIES" });
    expect(await application.listProviderPortals()).toEqual([]);
    expect(await secrets.listReferences()).toEqual([]);
  });
});
