import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { portalRecordSchema, type PortalRecord } from "./portal-types.js";

const documentSchema = z.object({ version: z.literal(1), records: z.array(portalRecordSchema).max(1_000) }).strict()
  .refine((value) => new Set(value.records.map((record) => record.connection.providerId)).size === value.records.length,
    "Duplicate portal connection.");
// Catalogs add hundreds of models per provider; retain a bounded file for many accounts.
const maximumBytes = 64 * 1024 * 1024;
export interface PortalRepository {
  list(): Promise<readonly PortalRecord[]>;
  get(providerId: string): Promise<PortalRecord | undefined>;
  update(providerId: string, operation: (record: PortalRecord | undefined) => PortalRecord | undefined): Promise<PortalRecord | undefined>;
}

/** One serialization queue for configuration changes and snapshot compare-and-swap. */
export class FilePortalRepository implements PortalRepository {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly filePath: string) {}
  async list(): Promise<readonly PortalRecord[]> {
    try {
      const source = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(source) > maximumBytes) throw new RangeError("Portal file is too large.");
      return documentSchema.parse(JSON.parse(source)).records;
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
      throw error;
    }
  }
  async get(providerId: string) { return (await this.list()).find((record) => record.connection.providerId === providerId); }
  update(providerId: string, operation: (record: PortalRecord | undefined) => PortalRecord | undefined): Promise<PortalRecord | undefined> {
    const task = this.queue.then(async () => {
      const records = [...await this.list()];
      const current = records.find((record) => record.connection.providerId === providerId);
      const updated = operation(current);
      const next = updated === undefined ? undefined : portalRecordSchema.parse(updated);
      if (next && next.connection.providerId !== providerId) throw new Error("Portal provider ID mismatch.");
      const remaining = records.filter((record) => record.connection.providerId !== providerId);
      if (next) remaining.push(next);
      const source = JSON.stringify(documentSchema.parse({ version: 1, records: remaining })) + "\n";
      if (Buffer.byteLength(source) > maximumBytes) throw new RangeError("Portal file is too large.");
      await mkdir(dirname(this.filePath), { recursive: true });
      const temporary = this.filePath + "." + randomUUID() + ".tmp";
      try {
        await writeFile(temporary, source, { flag: "wx", encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.filePath);
      } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
      return next;
    });
    this.queue = task.then(() => undefined, () => undefined);
    return task;
  }
}

export class MemoryPortalRepository implements PortalRepository {
  private readonly records = new Map<string, PortalRecord>();
  async list() { return structuredClone([...this.records.values()]); }
  async get(providerId: string) { return structuredClone(this.records.get(providerId)); }
  async update(providerId: string, operation: (record: PortalRecord | undefined) => PortalRecord | undefined) {
    const updated = operation(structuredClone(this.records.get(providerId)));
    if (!updated) { this.records.delete(providerId); return undefined; }
    const record = portalRecordSchema.parse(updated);
    if (record.connection.providerId !== providerId) throw new Error("Portal provider ID mismatch.");
    this.records.set(providerId, record);
    return structuredClone(record);
  }
}
