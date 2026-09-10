import { randomUUID } from "node:crypto";
import type { PortalRepository } from "./portal-repository.js";
import { portalAdapterIdForSite, portalConnectionSchema, portalSnapshotSchema, PortalConfigurationError,
  type ProviderPortalAdapterRegistry, type PortalRecord } from "./portal-types.js";

export class ProviderPortalService {
  private readonly pending = new Map<string, Promise<PortalRecord | undefined>>();
  constructor(private readonly records: PortalRepository, private readonly adapters: ProviderPortalAdapterRegistry,
    private readonly now: () => Date = () => new Date()) {}
  list() { return this.records.list(); }
  listAdapters() { return this.adapters.list(); }
  async configure(input: unknown): Promise<PortalRecord> {
    const parsed = portalConnectionSchema.parse(input);
    const connection = portalConnectionSchema.parse({
      ...parsed,
      adapterId: portalAdapterIdForSite(parsed.siteUrl, parsed.adapterId),
    });
    this.adapters.resolve(connection.adapterId);
    return (await this.records.update(connection.providerId, () => ({ connection, revision: randomUUID(), failures: 0 })))!;
  }
  async disconnect(providerId: string) { await this.records.update(providerId, () => undefined); }
  async invalidateSecret(reference: string) {
    for (const record of await this.records.list()) {
      if (record.connection.auth.kind === "none" || record.connection.auth.secretRef !== reference) continue;
      await this.records.update(record.connection.providerId, (current) => current && current.connection.auth.kind !== "none" &&
        current.connection.auth.secretRef === reference ? { connection: current.connection, revision: randomUUID(), failures: 0 } : current);
    }
  }
  async refresh(providerId: string, force = true): Promise<PortalRecord | undefined> {
    const record = await this.records.get(providerId);
    if (!record) throw new PortalConfigurationError("Connect this provider's account first.");
    const now = this.now();
    const limitedUntil = Math.max(0, ...Object.values(record.latest ?? {}).map((item) => item?.retryAt ? Date.parse(item.retryAt) : 0));
    if (limitedUntil > now.valueOf()) return record;
    if (!force && (!record.connection.autoRefresh ||
        (record.nextRefreshAt && Date.parse(record.nextRefreshAt) > now.valueOf()) ||
        (record.connection.auth.kind !== "none" && record.latest?.wallet.status === "auth-required"))) return record;
    const key = providerId + ":" + record.revision;
    const existing = this.pending.get(key);
    if (existing) return existing;
    const task = this.readAndStore(record, now).finally(() => { this.pending.delete(key); });
    this.pending.set(key, task);
    return task;
  }
  async refreshDue(providerIds: readonly string[]): Promise<void> {
    const enabled = new Set(providerIds);
    const queue = (await this.records.list()).filter((record) => enabled.has(record.connection.providerId));
    // Shared worker pool, no per-provider timer and no inference calls.
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      while (queue.length) {
        const record = queue.shift();
        if (record) await this.refresh(record.connection.providerId, false).catch(() => undefined);
      }
    }));
  }
  private async readAndStore(record: PortalRecord, now: Date): Promise<PortalRecord | undefined> {
    const adapterId = portalAdapterIdForSite(record.connection.siteUrl, record.connection.adapterId);
    const connection = adapterId === record.connection.adapterId
      ? record.connection
      : portalConnectionSchema.parse({ ...record.connection, adapterId });
    const latest = portalSnapshotSchema.parse(await this.adapters.resolve(adapterId).read(connection, now));
    const failed = Object.values(latest).some((item) => item?.status === "error");
    const failures = failed ? Math.min(10, record.failures + 1) : 0;
    const delay = Math.min(3_600_000, record.connection.refreshIntervalMs * 2 ** Math.min(failures, 4));
    const retryAt = Math.max(now.valueOf() + delay, ...Object.values(latest).map((item) => item?.retryAt ? Date.parse(item.retryAt) : 0));
    return this.records.update(record.connection.providerId, (current) => {
      if (!current || current.revision !== record.revision) return current;
      return { ...current, connection, latest, failures, nextRefreshAt: new Date(retryAt).toISOString(),
        ...(latest.wallet.value ? { lastWallet: { value: latest.wallet.value, observedAt: latest.wallet.observedAt } } : {}) };
    });
  }
}
