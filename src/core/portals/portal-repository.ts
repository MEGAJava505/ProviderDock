import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { portalRecordSchema, type PortalRecord } from "./portal-types.js";

const storageVersion = 2 as const;
const recoverableRecordSchema = z.object({
  connection: portalRecordSchema.shape.connection,
  revision: portalRecordSchema.shape.revision,
}).passthrough();
const legacyDocumentSchema = z.object({
  version: z.literal(1),
  records: z.array(z.unknown()).max(1_000),
}).strict();
const documentSchema = z.object({
  version: z.literal(storageVersion),
  records: z.array(portalRecordSchema).max(1_000),
}).strict().refine(
  (value) => new Set(value.records.map((record) => record.connection.providerId)).size === value.records.length,
  "Duplicate portal connection.",
);
// Catalogs add hundreds of models per provider; retain a bounded file for many accounts.
const maximumBytes = 64 * 1024 * 1024;
export interface PortalRepositoryStatus {
  readonly state: "healthy" | "recovered" | "corrupt";
  readonly message?: string;
  readonly backupPath?: string;
}
export interface PortalRepository {
  list(): Promise<readonly PortalRecord[]>;
  get(providerId: string): Promise<PortalRecord | undefined>;
  update(providerId: string, operation: (record: PortalRecord | undefined) => PortalRecord | undefined): Promise<PortalRecord | undefined>;
  status(): PortalRepositoryStatus;
}

/** One serialization queue for configuration changes and snapshot compare-and-swap. */
export class FilePortalRepository implements PortalRepository {
  private queue: Promise<void> = Promise.resolve();
  private repositoryStatus: PortalRepositoryStatus = { state: "healthy" };
  private backupTask?: Promise<string>;
  constructor(private readonly filePath: string) {}
  status(): PortalRepositoryStatus { return this.repositoryStatus; }
  async list(): Promise<readonly PortalRecord[]> {
    try {
      const source = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(source) > maximumBytes) {
        const error = new PortalRepositoryCorruptionError(
          `Portal account store '${this.filePath}' is too large.`,
        );
        await this.markCorrupt(source, error);
        throw error;
      }
      try {
        return this.parseDocument(source);
      } catch (error) {
        if (!(error instanceof PortalRepositoryCorruptionError)) throw error;
        await this.markCorrupt(source, error);
        throw error;
      }
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
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
      const source = JSON.stringify(documentSchema.parse({ version: storageVersion, records: remaining })) + "\n";
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

  private async markCorrupt(
    source: string,
    error: PortalRepositoryCorruptionError,
  ): Promise<void> {
    try {
      const backupPath = await (this.backupTask ??= this.writeBackup(source));
      this.repositoryStatus = {
        state: "corrupt",
        message: error.message,
        backupPath,
      };
    } catch (backupError) {
      const detail = backupError instanceof Error
        ? backupError.message
        : String(backupError);
      this.repositoryStatus = {
        state: "corrupt",
        message: `${error.message} Backup failed: ${detail}`,
      };
    }
  }

  private async writeBackup(source: string): Promise<string> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const backupPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
    await writeFile(backupPath, source, {
      flag: "wx",
      encoding: "utf8",
      mode: 0o600,
    });
    return backupPath;
  }

  private parseDocument(source: string): readonly PortalRecord[] {
    let input: unknown;
    try {
      input = JSON.parse(source);
    } catch (error) {
      throw new PortalRepositoryCorruptionError(
        `Portal account store '${this.filePath}' contains malformed JSON.`,
        { cause: error },
      );
    }

    const current = documentSchema.safeParse(input);
    if (current.success) {
      this.repositoryStatus = { state: "healthy" };
      return current.data.records;
    }

    const legacy = legacyDocumentSchema.safeParse(input);
    if (!legacy.success) {
      throw new PortalRepositoryCorruptionError(
        `Portal account store '${this.filePath}' has an unsupported or invalid schema.`,
        { cause: current.error },
      );
    }

    const records: PortalRecord[] = [];
    const providerIds = new Set<string>();
    for (const [index, value] of legacy.data.records.entries()) {
      const recovered = recoverLegacyRecord(value);
      if (recovered === undefined) {
        throw new PortalRepositoryCorruptionError(
          `Portal account store '${this.filePath}' has an unrecoverable connection at record ${index}.`,
        );
      }
      if (providerIds.has(recovered.connection.providerId)) {
        throw new PortalRepositoryCorruptionError(
          `Portal account store '${this.filePath}' contains duplicate provider '${recovered.connection.providerId}'.`,
        );
      }
      providerIds.add(recovered.connection.providerId);
      records.push(recovered);
    }
    this.repositoryStatus = {
      state: "recovered",
      message: "Legacy portal observations were repaired; durable connections were preserved.",
    };
    return records;
  }
}

export class PortalRepositoryCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PortalRepositoryCorruptionError";
  }
}

function recoverLegacyRecord(input: unknown): PortalRecord | undefined {
  const complete = portalRecordSchema.safeParse(input);
  if (complete.success) return complete.data;

  const stored = recoverableRecordSchema.safeParse(input);
  if (!stored.success) return undefined;
  return portalRecordSchema.parse({
    connection: stored.data.connection,
    revision: stored.data.revision,
    failures: 0,
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export class MemoryPortalRepository implements PortalRepository {
  private readonly records = new Map<string, PortalRecord>();
  status(): PortalRepositoryStatus { return { state: "healthy" }; }
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
