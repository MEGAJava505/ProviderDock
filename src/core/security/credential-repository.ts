import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { secretReferenceSchema } from "../providers/provider-profile.js";

export const credentialPurposes = ["provider-api", "portal-session"] as const;
export const credentialPurposeSchema = z.enum(credentialPurposes);
export type CredentialPurpose = z.infer<typeof credentialPurposeSchema>;

export const credentialStates = ["active", "available", "revoked", "unavailable"] as const;
export const credentialStateSchema = z.enum(credentialStates);
export type CredentialState = z.infer<typeof credentialStateSchema>;

const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const credentialRecordSchema = z
  .object({
    id: z.string().uuid(),
    providerId: providerIdSchema,
    purpose: credentialPurposeSchema,
    secretRef: secretReferenceSchema,
    label: z.string().trim().min(1).max(128).optional(),
    maskedValue: z.string().trim().min(1).max(128),
    state: credentialStateSchema,
    createdAt: z.string().datetime(),
    lastUsedAt: z.string().datetime().optional(),
  })
  .strict();

export type CredentialRecord = z.infer<typeof credentialRecordSchema>;

const credentialDocumentSchema = z
  .object({ version: z.literal(1), records: z.array(credentialRecordSchema).max(10_000) })
  .strict();

export interface CredentialMetadataRepository {
  list(): Promise<readonly CredentialRecord[]>;
  get(id: string): Promise<CredentialRecord | undefined>;
  upsert(record: CredentialRecord): Promise<CredentialRecord>;
  delete(id: string): Promise<boolean>;
  isInitialized?(): Promise<boolean>;
  initializeEmpty?(): Promise<void>;
  withTransaction?<T>(work: () => Promise<T>): Promise<T>;
}

/**
 * Timings for the on-disk registry lock. The lock is a mutual-exclusion
 * directory that is NEVER reclaimed automatically: a crashed writer's lock is
 * left in place and the next writer fails closed with a named manual-recovery
 * target once the busy window elapses. Live-writer safety over auto-convenience.
 */
export interface CredentialRegistryLockOptions {
  readonly busyTimeoutMs?: number;
  readonly retryIntervalMs?: number;
}

interface LockOwnerMarker {
  readonly ownerId?: unknown;
  readonly pid?: unknown;
  readonly acquiredAt?: unknown;
}

const LOCK_MARKER_NAME = "owner.json";

/**
 * Raised when the registry writer cannot be acquired: the busy timeout elapsed
 * while another writer held the lock. The lock is never reclaimed automatically,
 * so the message always names the lock directory as an exact manual-recovery
 * target for the case where the owning process has crashed.
 */
export class CredentialRegistryLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialRegistryLockError";
  }
}

export class FileCredentialMetadataRepository implements CredentialMetadataRepository {
  private readonly busyTimeoutMs: number;
  private readonly retryIntervalMs: number;

  constructor(private readonly filePath: string, lock: CredentialRegistryLockOptions = {}) {
    this.busyTimeoutMs = lock.busyTimeoutMs ?? 3_000;
    this.retryIntervalMs = lock.retryIntervalMs ?? 25;
  }

  withTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.withDirectoryLock(`${this.filePath}.transaction.lock`, work);
  }

  async isInitialized(): Promise<boolean> {
    try {
      const entry = await lstat(this.filePath);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("Credential registry is not a regular file.");
      }
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  async initializeEmpty(): Promise<void> {
    await this.withWriteLock(async () => {
      try {
        await writeFile(this.filePath, `${JSON.stringify({ version: 1, records: [] })}\n`, {
          encoding: "utf8", flag: "wx", mode: 0o600,
        });
      } catch (error) {
        if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
        await this.list();
      }
    });
  }

  async list(): Promise<readonly CredentialRecord[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return credentialDocumentSchema.parse(JSON.parse(contents)).records;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async get(id: string): Promise<CredentialRecord | undefined> {
    return (await this.list()).find((record) => record.id === id);
  }

  async upsert(recordInput: CredentialRecord): Promise<CredentialRecord> {
    const record = credentialRecordSchema.parse(recordInput);
    return this.withWriteLock(async () => {
      const records = [...(await this.list())];
      const index = records.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) records[index] = record;
      else records.push(record);
      records.sort((left, right) => left.id.localeCompare(right.id));
      await this.writeAtomically(records);
      return record;
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.withWriteLock(async () => {
      const records = [...(await this.list())];
      const remaining = records.filter((record) => record.id !== id);
      if (remaining.length === records.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async withWriteLock<T>(work: () => Promise<T>): Promise<T> {
    return this.withDirectoryLock(`${this.filePath}.lock`, work);
  }

  private async withDirectoryLock<T>(lockPath: string, work: () => Promise<T>): Promise<T> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const deadline = Date.now() + this.busyTimeoutMs;
    let acquired = false;
    for (;;) {
      try {
        await mkdir(lockPath);
        acquired = true;
        break;
      } catch (error) {
        if (!(isNodeError(error) && error.code === "EEXIST")) throw error;
        if (Date.now() >= deadline) break;
        // A held lock is never reclaimed automatically. There is no atomic way
        // to prove the owner is dead AND keep that proof true until the delete:
        // a crashed owner's directory is indistinguishable from a live
        // successor that took it (or replaced it) in the gap between any check
        // and the removal. So we only wait and retry; on the busy timeout we
        // fail closed with a named manual-recovery target below.
        await delay(this.retryIntervalMs);
      }
    }
    if (!acquired) {
      throw new CredentialRegistryLockError(
        `Credential registry writer is busy; the lock at '${lockPath}' was held for ` +
        `the whole wait and is never reclaimed automatically. No changes were made. ` +
        `Retry; if no ProviderDock process is running, the owner crashed — remove that ` +
        `lock directory manually to recover. It holds no account data or secret.`,
      );
    }
    const ownerId = randomUUID();
    if (!(await this.writeOwnerMarker(lockPath, ownerId))) {
      // The owner marker is what lets release destroy only our own directory.
      // Without it we cannot prove the lock we later remove is still ours, so
      // fail closed: drop the lock we just made and abort without touching the
      // registry rather than hold a directory we cannot safely release.
      await this.releaseLock(lockPath, ownerId);
      throw new CredentialRegistryLockError(
        `Credential registry writer could not publish its ownership marker at ` +
        `'${lockPath}'. No changes were made. Retry; if this persists, remove the ` +
        `lock directory manually once no ProviderDock process is running.`,
      );
    }
    await this.onLockHeld(lockPath, ownerId);
    try {
      return await work();
    } finally {
      // A committed write must not be reported as failed because lock cleanup
      // failed: callers may otherwise roll back its protected payload.
      await this.releaseLock(lockPath, ownerId);
    }
  }

  /**
   * Deterministic-concurrency test seam. Invoked once while this writer holds
   * the lock, before its protected work runs, so a test can inject a successor
   * taking the lock mid-work and assert release never destroys it. No-op in
   * production.
   */
  protected async onLockHeld(_lockPath: string, _ownerId: string): Promise<void> {}

  protected async writeOwnerMarker(lockPath: string, ownerId: string): Promise<boolean> {
    try {
      await writeFile(
        join(lockPath, LOCK_MARKER_NAME),
        JSON.stringify({ ownerId, pid: process.pid, acquiredAt: new Date().toISOString() }),
        { encoding: "utf8", mode: 0o600 },
      );
      return true;
    } catch {
      return false;
    }
  }

  private async readOwnerId(lockPath: string): Promise<string | undefined> {
    try {
      const marker = JSON.parse(
        await readFile(join(lockPath, LOCK_MARKER_NAME), "utf8"),
      ) as LockOwnerMarker;
      return typeof marker.ownerId === "string" ? marker.ownerId : undefined;
    } catch {
      return undefined;
    }
  }

  private async releaseLock(lockPath: string, ownerId: string): Promise<void> {
    // Only destroy the lock while it still carries our marker (or none at all —
    // e.g. an aborted acquisition whose marker never published). A successor
    // that reclaimed the directory and published its own marker must survive.
    const owner = await this.readOwnerId(lockPath);
    if (owner !== undefined && owner !== ownerId) return;
    await this.removeLockDirectory(lockPath);
  }

  private async removeLockDirectory(lockPath: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await rm(lockPath, { recursive: true, force: true });
        return;
      } catch {
        if (attempt < 4) await delay(this.retryIntervalMs);
      }
    }
  }

  private async writeAtomically(records: readonly CredentialRecord[]): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(
      temporaryPath,
      `${JSON.stringify({ version: 1, records }, null, 2)}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await rename(temporaryPath, this.filePath);
  }
}

export class MemoryCredentialMetadataRepository implements CredentialMetadataRepository {
  private readonly records = new Map<string, CredentialRecord>();
  private transactionTail: Promise<void> = Promise.resolve();

  withTransaction<T>(work: () => Promise<T>): Promise<T> {
    const result = this.transactionTail.then(work);
    this.transactionTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async list(): Promise<readonly CredentialRecord[]> {
    return [...this.records.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<CredentialRecord | undefined> {
    return this.records.get(id);
  }

  async upsert(recordInput: CredentialRecord): Promise<CredentialRecord> {
    const record = credentialRecordSchema.parse(recordInput);
    this.records.set(record.id, record);
    return record;
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
