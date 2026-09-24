import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { ensureWorkerBuild } from "./support/worker-build.js";
import { MemorySecretStore } from "../src/core/security/secret-store.js";
import { NewApiPortalAdapter } from "../src/core/portals/new-api-portal-adapter.js";
import { FilePortalRepository, MemoryPortalRepository, PortalRepositoryLockError } from "../src/core/portals/portal-repository.js";
import { ProviderPortalService } from "../src/core/portals/provider-portal-service.js";
import { portalConnectionSchema, portalSnapshotSchema, ProviderPortalAdapterRegistry } from "../src/core/portals/portal-types.js";
import type { PortalRecord } from "../src/core/portals/portal-types.js";

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

// Spawn a portal-writer worker in its own OS process; resolve on exit 0, reject
// with captured stderr otherwise.
const runWorker = (worker: string, args: readonly string[]) => new Promise<void>((resolve, reject) => {
  const child = spawn(process.execPath, [worker, ...args], { stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", reject);
  child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(`worker ${args[1]} exited ${code}: ${stderr}`)));
});

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

  it("does not lose a concurrent update from an independent writer on the same file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-cross-"));
    try {
      const path = join(directory, "accounts.json");
      // Independent instances model separate processes: each has its own
      // in-process queue, so only a cross-process lock can serialize them.
      const writerA = new FilePortalRepository(path);
      const writerB = new FilePortalRepository(path);
      const record = (providerId: string, siteUrl: string): PortalRecord => ({
        connection: portalConnectionSchema.parse({ ...profile, providerId, siteUrl }),
        revision: randomUUID(),
        failures: 0,
      });
      await Promise.all([
        writerA.update("one", () => record("one", "https://one.invalid/profile")),
        writerB.update("two", () => record("two", "https://two.invalid")),
      ]);
      const ids = (await new FilePortalRepository(path).list())
        .map((entry) => entry.connection.providerId)
        .sort();
      expect(ids).toEqual(["one", "two"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("serializes two real OS processes writing one accounts file without losing an update", async () => {
    // The in-process test above uses two repository instances in one process;
    // this one proves the on-disk lock across genuinely separate OS processes,
    // the case src/cli.ts actually produces (a fresh application per invocation).
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const worker = join(root, "tests", "support", "portal-writer-process.mjs");
    const dist = join(root, "dist", "core", "portals");
    // The child imports the compiled build and `vitest run` does not build.
    // Rebuild if any required artifact is missing or older than ANY source file
    // (a dependency change, not just portal-repository.ts, must invalidate it).
    await ensureWorkerBuild(root, [
      join(dist, "portal-repository.js"),
      join(dist, "portal-types.js"),
    ]);
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-procs-"));
    try {
      const path = join(directory, "accounts.json");
      const perWriter = 12;
      await Promise.all([
        runWorker(worker, [path, "a-", String(perWriter)]),
        runWorker(worker, [path, "b-", String(perWriter)]),
      ]);

      const ids = (await new FilePortalRepository(path).list())
        .map((entry) => entry.connection.providerId)
        .sort();
      const expected = Array.from({ length: perWriter }, (_, index) => [`a-${index}`, `b-${index}`]).flat().sort();
      // Every update from both processes survives: no last-rename-wins loss.
      expect(ids).toEqual(expected);
      expect(new Set(ids).size).toBe(expected.length);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("loses an update across two real processes WITHOUT the lock — the negative control the lock exists to prevent", async () => {
    // Same two-real-process race as above, but the worker's nolock mode does a
    // RAW read-modify-write with no cross-process lock. A rendezvous makes both
    // processes read the identical base before either writes, so last-rename-wins
    // is deterministic: exactly one of the two records survives. This is the RED
    // state; the locked test above is GREEN. No production code is bypassed and
    // nothing temporary is left behind — the failure mode lives only in the
    // .mjs worker's nolock branch.
    const root = dirname(dirname(fileURLToPath(import.meta.url)));
    const worker = join(root, "tests", "support", "portal-writer-process.mjs");
    const dist = join(root, "dist", "core", "portals");
    await ensureWorkerBuild(root, [join(dist, "portal-repository.js"), join(dist, "portal-types.js")]);
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-nolock-"));
    try {
      const path = join(directory, "accounts.json");
      const rendezvous = join(directory, "rendezvous");
      await import("node:fs/promises").then(({ mkdir }) => mkdir(rendezvous));
      await Promise.all([
        runWorker(worker, [path, "a-", "1", "nolock", rendezvous]),
        runWorker(worker, [path, "b-", "1", "nolock", rendezvous]),
      ]);
      const ids = (await new FilePortalRepository(path).list()).map((entry) => entry.connection.providerId);
      // Without the lock exactly one writer's record survives — an update is lost.
      expect(ids).toHaveLength(1);
      expect(["a-0", "b-0"]).toContain(ids[0]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 60_000);

  it("fails a busy write closed with a secret-free, exact-path recovery message and no store change", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-busy-"));
    try {
      const path = join(directory, "accounts.json");
      const lockPath = `${path}.lock`;
      // Seed one record, then hold the lock as a concurrent writer would.
      const seed = new FilePortalRepository(path);
      await seed.update("kept", () => ({
        connection: portalConnectionSchema.parse({ providerId: "kept", siteUrl: "https://kept.invalid",
          auth: { kind: "bearer", secretRef: "TOP-SECRET-REF" } }),
        revision: randomUUID(), failures: 0,
      }));
      await writeFile(lockPath, "");

      const blocked = new FilePortalRepository(path, { busyTimeoutMs: 120, retryIntervalMs: 10 });
      const attempt = blocked.update("added", () => ({
        connection: portalConnectionSchema.parse({ providerId: "added", siteUrl: "https://added.invalid",
          auth: { kind: "bearer", secretRef: "TOP-SECRET-REF" } }),
        revision: randomUUID(), failures: 0,
      }));
      const error = await attempt.then(() => undefined, (reason) => reason);
      expect(error).toBeInstanceOf(PortalRepositoryLockError);
      const message = (error as Error).message;
      expect(message).toContain(lockPath);                       // exact lock path
      expect(message).toContain("No changes were made.");
      expect(message).toMatch(/if no ProviderDock process is running/); // deletion advice is CONDITIONAL, never for a live lock
      expect(message).not.toMatch(/TOP-SECRET-REF|account-secret/);     // no secret leaks
      // The held lock and the seeded store are untouched by the failed write.
      await expect(readFile(lockPath, "utf8")).resolves.toBe("");
      const ids = (await seed.list()).map((entry) => entry.connection.providerId).sort();
      expect(ids).toEqual(["kept"]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses to overwrite a newer revision when compensating a failed managed import", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-compensate-"));
    try {
      const path = join(directory, "accounts.json");
      const registry = new ProviderPortalAdapterRegistry().register(new NewApiPortalAdapter(secrets(), { fetchImpl: async (url) => json(bodyFor(url)) }));
      const serviceA = new ProviderPortalService(new FilePortalRepository(path), registry, () => now);
      const serviceB = new ProviderPortalService(new FilePortalRepository(path), registry, () => now);
      const previous = await serviceA.configure(profile);
      const staged = await serviceA.configure(profile);
      // An independent writer commits a newer revision before A compensates.
      const newer = await serviceB.configure(profile);

      const restored = await serviceA.restoreIfUnchanged(staged, previous);

      // Compensation is a no-op — the response must signal recovery, not a
      // partial success, and the newer revision must survive untouched.
      expect(restored).toBe(false);
      const currentNow = await new FilePortalRepository(path).get("one");
      expect(currentNow?.revision).toBe(newer.revision);
      expect(currentNow?.revision).not.toBe(previous.revision);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("migrates legacy records while preserving connection secrets and dropping invalid snapshots", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-migrate-"));
    try {
      const path = join(directory, "accounts.json");
      await writeFile(path, JSON.stringify({ version: 1, records: [{
        connection: profile,
        revision: "11111111-1111-4111-8111-111111111111",
        failures: 2,
        latest: { invalid: true },
      }] }));
      const repository = new FilePortalRepository(path);
      expect(await repository.list()).toEqual([expect.objectContaining({
        connection: expect.objectContaining({
          providerId: "one",
          auth: { kind: "bearer", secretRef: "ACCOUNT_TOKEN" },
        }),
        failures: 0,
      })]);
      expect(repository.status()).toMatchObject({ state: "recovered" });
      await repository.update("one", (record) => record);
      expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
        version: 2,
        records: [{ connection: { auth: { secretRef: "ACCOUNT_TOKEN" } } }],
      });
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it("refuses to hide or overwrite a corrupt durable account store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-portals-corrupt-"));
    try {
      const path = join(directory, "accounts.json");
      const corrupt = '{"version":1,"records":[';
      await writeFile(path, corrupt);
      const repository = new FilePortalRepository(path);
      await expect(repository.list()).rejects.toThrow(/malformed JSON/);
      await expect(repository.update("one", () => ({
        connection: profile,
        revision: "11111111-1111-4111-8111-111111111111",
        failures: 0,
      }))).rejects.toThrow(/malformed JSON/);
      expect(await readFile(path, "utf8")).toBe(corrupt);
      const status = repository.status();
      expect(status).toMatchObject({ state: "corrupt", message: expect.stringMatching(/malformed JSON/) });
      expect(status.backupPath).toBeDefined();
      expect(await readFile(status.backupPath!, "utf8")).toBe(corrupt);
      expect((await readdir(directory)).filter((name) => name.endsWith(".bak"))).toHaveLength(1);
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
