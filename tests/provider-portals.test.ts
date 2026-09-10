import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { NewApiPortalAdapter } from "../src/core/portals/new-api-portal-adapter.js";
import { FilePortalRepository, MemoryPortalRepository } from "../src/core/portals/portal-repository.js";
import { ProviderPortalService } from "../src/core/portals/provider-portal-service.js";
import { portalConnectionSchema, portalSnapshotSchema, ProviderPortalAdapterRegistry } from "../src/core/portals/portal-types.js";

const now = new Date("2026-09-07T12:00:00Z");
const profile = portalConnectionSchema.parse({ providerId: "one", siteUrl: "https://one.invalid/profile",
  auth: { kind: "bearer", secretRef: "ACCOUNT_TOKEN" } });
const site = { checkin_enabled: true, quota_per_unit: 500000, quota_display_type: "USD" };
const wallet = { id: 42, quota: 150000000, used_quota: 500, group: "default", email: "private@example.invalid", access_token: "do-not-serialize" };
const checkIn = { enabled: true, min_quota: 500000, max_quota: 1000000,
  stats: { checked_in_today: true, total_checkins: 2, total_quota: 1000000,
    records: [{ checkin_date: "2026-09-07", quota_awarded: 500000 }] } };
const json = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { headers: { "content-type": "application/json" } });
const bodyFor = (url: string | URL | Request) => String(url).endsWith("/pricing") ? [] : String(url).endsWith("/summary") ? { models: [] } : String(url).endsWith("/status") ? site : String(url).endsWith("/self") ? wallet : checkIn;
const secrets = () => new MemorySecretStore({ ACCOUNT_TOKEN: "account-secret" });

describe("New API portal", () => {
  it("reads an account using only GET and returns wallet/check-in without private profile fields", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      expect(init?.method).toBe("GET");
      expect(init?.redirect).toBe("manual");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBe(String(url).endsWith("/status") ? null : "Bearer account-secret");
      return json(bodyFor(url));
    });
    const result = await new NewApiPortalAdapter(secrets(), { fetchImpl }).read(profile, now);
    expect(result.wallet.value).toMatchObject({ remainingQuota: 150000000, usedQuota: 500, group: "default",
      displayBalance: { amount: 300, currency: "USD", source: "site-display" } });
    expect(result.checkIn.value).toMatchObject({ eligibility: "claimed", totalCheckins: 2, siteTimeZone: null });
    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname).sort()).toEqual(["/api/perf-metrics/summary", "/api/pricing", "/api/status", "/api/user/checkin", "/api/user/self"]);
    expect(JSON.stringify(result)).not.toMatch(/private@example|do-not-serialize|account-secret/);
    expect(result.wallet.value).not.toHaveProperty("id");
  });

  it.each([0, -500000])("preserves actual quota %s instead of hiding zero or overdraft", async (quota) => {
    const adapter = new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(String(url).endsWith("/self") ? { ...wallet, quota } : bodyFor(url)) });
    expect((await adapter.read(profile, now)).wallet.value?.remainingQuota).toBe(quota);
  });

  it("does not guess currency conversion or treat missing quota as zero", async () => {
    const adapter = new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(String(url).endsWith("/status") ? { ...site, quota_display_type: "CUSTOM" } : bodyFor(url)) });
    expect((await adapter.read(profile, now)).wallet.value?.displayBalance).toBeNull();
    const missing = new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(String(url).endsWith("/self") ? { id: 42 } : bodyFor(url)) });
    expect((await missing.read(profile, now)).wallet).toMatchObject({ status: "error", code: "INVALID_RESPONSE", value: null });
  });

  it("distinguishes global enablement, personal eligibility and disabled check-in", async () => {
    const read = async (data: unknown) => new NewApiPortalAdapter(secrets(), {
      fetchImpl: async (url) => json(String(url).endsWith("/checkin") ? data : bodyFor(url)),
    }).read(profile, now);
    expect((await read({ enabled: true })).checkIn.value?.eligibility).toBe("unknown");
    expect((await read({ enabled: true, stats: { checked_in_today: false } })).checkIn.value?.eligibility).toBe("available");
    expect((await read({ enabled: false })).checkIn.value?.eligibility).toBe("disabled");
  });

  it("handles wallet and check-in failures independently without reflecting upstream text", async () => {
    const adapter = new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => String(url).endsWith("/checkin")
      ? new Response('account-secret private@example.invalid', { status: 404 }) : json(bodyFor(url)) });
    const result = await adapter.read(profile, now);
    expect(result.wallet.status).toBe("ok");
    expect(result.checkIn).toMatchObject({ status: "unsupported", code: "UNSUPPORTED_ENDPOINT", value: null });
    expect(JSON.stringify(result)).not.toMatch(/account-secret|private@example/);
  });

  it("does not contact private endpoints without an account credential", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => json(bodyFor(url)));
    const result = await new NewApiPortalAdapter(new MemorySecretStore(), { fetchImpl }).read(profile, now);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(result.wallet).toMatchObject({ status: "auth-required", code: "MISSING_SECRET" });
    expect(result.checkIn.value).toBeNull();
  });

  it.each([401, 403, 302, 429])("normalizes HTTP %s without retrying or forwarding secrets", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => String(url).endsWith("/status") ? json(site) :
      new Response("account-secret", { status, headers: { location: "https://other.invalid", "retry-after": "600" } }));
    const result = await new NewApiPortalAdapter(secrets(), { fetchImpl }).read(profile, now);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(result.wallet.value).toBeNull();
    expect(JSON.stringify(result)).not.toContain("account-secret");
    if (status === 429) expect(result.wallet.retryAt).toBe("2026-09-07T12:10:00.000Z");
  });

  it("rejects HTML login pages, oversized JSON, and a different account ID", async () => {
    for (const response of [new Response("<html>login</html>", { headers: { "content-type": "text/html" } }),
      new Response("x".repeat(1_048_577), { headers: { "content-type": "application/json" } })]) {
      const result = await new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => String(url).endsWith("/self") ? response : json(bodyFor(url)) }).read(profile, now);
      expect(result.wallet.code).toBe("INVALID_RESPONSE");
    }
    const mismatch = await new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(bodyFor(url)) }).read({ ...profile, userId: 43 }, now);
    expect(mismatch.wallet.code).toBe("ACCOUNT_MISMATCH");
    expect(mismatch.checkIn).toMatchObject({ code: "ACCOUNT_MISMATCH", value: null });
  });

  it("bounds a stalled response body without letting metadata hold the UI forever", async () => {
    const cancelled = vi.fn();
    const adapter = new NewApiPortalAdapter(secrets(), { timeoutMs: 25, fetchImpl: async (url) =>
      String(url).endsWith("/self") ? new Response(new ReadableStream({ cancel: cancelled }),
        { headers: { "content-type": "application/json" } }) : json(bodyFor(url)) });
    const result = await adapter.read(profile, now);
    expect(result.wallet.code).toBe("TIMEOUT");
    expect(cancelled).toHaveBeenCalledOnce();
    expect(result.checkIn.status).toBe("ok");
  });

  it.each(["not-a-url", "https://user:pass@example.invalid", "https://example.invalid/?token=secret", "http://example.invalid", "file:///secret"])("rejects unsafe site configuration %s", (siteUrl) => {
    expect(() => portalConnectionSchema.parse({ ...profile, siteUrl })).toThrow();
  });
});

describe("portal state and polling", () => {
  function setup(fetchImpl: typeof fetch, records = new MemoryPortalRepository()) {
    let date = now;
    const service = new ProviderPortalService(records,
      new ProviderPortalAdapterRegistry().register(new NewApiPortalAdapter(secrets(), { fetchImpl })), () => date);
    return { service, records, advance: (ms: number) => { date = new Date(date.valueOf() + ms); } };
  }
  it("coalesces simultaneous refreshes and respects the background TTL", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => json(bodyFor(url)));
    const { service, advance } = setup(fetchImpl);
    await service.configure(profile);
    await Promise.all(Array.from({ length: 15 }, () => service.refresh("one")));
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    await service.refreshDue(["one"]);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    advance(300_001);
    await service.refreshDue(["one"]);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
  });

  it("keeps last known balance separate and pauses automatic polling after expired auth", async () => {
    let expired = false;
    const fetchImpl = vi.fn<typeof fetch>(async (url) => expired && !String(url).endsWith("/status") ? new Response("private", { status: 401 }) : json(bodyFor(url)));
    const { service, advance } = setup(fetchImpl);
    await service.configure(profile);
    await service.refresh("one");
    expired = true;
    const result = await service.refresh("one");
    expect(result?.latest?.wallet.value).toBeNull();
    expect(result?.lastWallet?.value.remainingQuota).toBe(150000000);
    advance(3_600_000);
    await service.refreshDue(["one"]);
    expect(fetchImpl).toHaveBeenCalledTimes(10);
    await service.invalidateSecret("ACCOUNT_TOKEN");
    expect((await service.list())[0]).not.toHaveProperty("lastWallet");
  });

  it("keeps polling public settings when the connection intentionally has no account token", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (url) => json(bodyFor(url)));
    const { service, advance } = setup(fetchImpl);
    await service.configure({ ...profile, auth: { kind: "none" } });
    await service.refreshDue(["one"]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    advance(300_001);
    await service.refreshDue(["one"]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });

  it("does not recreate a disconnected account when its previous read finishes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const seen = new Promise<void>((resolve) => { started = resolve; });
    const { service } = setup(async (url) => { started(); await gate; return json(bodyFor(url)); });
    await service.configure(profile);
    const pending = service.refresh("one");
    await seen;
    await service.disconnect("one");
    release();
    await pending;
    expect(await service.list()).toEqual([]);
  });

  it("honors Retry-After even for repeated manual refreshes", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("limited", { status: 429, headers: { "retry-after": "600" } }));
    const { service } = setup(fetchImpl);
    await service.configure(profile);
    await service.refresh("one");
    await service.refresh("one");
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  it("discards in-flight results after reconnecting or removing an account", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let started!: () => void;
    const seen = new Promise<void>((resolve) => { started = resolve; });
    const { service } = setup(async (url) => { started(); await gate; return json(bodyFor(url)); });
    await service.configure(profile);
    const pending = service.refresh("one");
    await seen;
    await service.configure({ ...profile, siteUrl: "https://different.invalid" });
    release();
    await pending;
    const current = (await service.list())[0];
    expect(current?.connection.siteUrl).toBe("https://different.invalid");
    expect(current?.latest).toBeUndefined();
    await service.disconnect("one");
    expect(await service.list()).toEqual([]);
  });

  it("reuses the adapter across sites without merging their account identities", async () => {
    const { service } = setup(async (url) => json(bodyFor(url)));
    await service.configure(profile);
    await service.configure({ ...profile, providerId: "two", siteUrl: "https://two.invalid" });
    await service.refreshDue(["one", "two"]);
    const records = await service.list();
    expect(records).toHaveLength(2);
    expect(records[0]?.latest?.wallet.value?.accountFingerprint).not.toBe(records[1]?.latest?.wallet.value?.accountFingerprint);
  });

  it("persists normalized records atomically without losing concurrent provider updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-"));
    try {
      const path = join(directory, "accounts.json");
      const registry = new ProviderPortalAdapterRegistry().register(new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(bodyFor(url)) }));
      const service = new ProviderPortalService(new FilePortalRepository(path), registry, () => now);
      await Promise.all([service.configure(profile), service.configure({ ...profile, providerId: "two", siteUrl: "https://two.invalid" })]);
      await service.refreshDue(["one", "two"]);
      expect(await new FilePortalRepository(path).list()).toHaveLength(2);
      expect(await readFile(path, "utf8")).not.toMatch(/account-secret|private@example|do-not-serialize/);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("reroutes and migrates an existing NoFX record saved with the generic adapter", async () => {
    const records = new MemoryPortalRepository();
    await records.update("one", () => ({
      connection: portalConnectionSchema.parse({
        ...profile,
        siteUrl: "https://nofx.one",
        adapterId: "new-api",
        auth: { kind: "none" },
      }),
      revision: "75df7b98-35f8-46c1-aedf-3fc955426a93",
      failures: 0,
    }));
    const reads: string[] = [];
    const observation = {
      status: "unsupported" as const,
      code: "UNSUPPORTED_ENDPOINT" as const,
      sourceUrl: "https://nofx.one",
      observedAt: now.toISOString(),
      expiresAt: new Date(now.valueOf() + 300_000).toISOString(),
      value: null,
    };
    const registry = new ProviderPortalAdapterRegistry()
      .register({
        id: "new-api",
        displayName: "New API",
        async read() { reads.push("new-api"); return portalSnapshotSchema.parse({ site: observation, wallet: observation, checkIn: observation }); },
      })
      .register({
        id: "nofx",
        displayName: "NoFX",
        async read() { reads.push("nofx"); return portalSnapshotSchema.parse({ site: observation, wallet: observation, checkIn: observation }); },
      });
    const service = new ProviderPortalService(records, registry, () => now);

    const refreshed = await service.refresh("one");

    expect(reads).toEqual(["nofx"]);
    expect(refreshed?.connection.adapterId).toBe("nofx");
    expect((await records.get("one"))?.connection.adapterId).toBe("nofx");
  });
});
