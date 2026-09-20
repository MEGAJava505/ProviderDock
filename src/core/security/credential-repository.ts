import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
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
}

export class FileCredentialMetadataRepository implements CredentialMetadataRepository {
  constructor(private readonly filePath: string) {}

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
    const records = [...(await this.list())];
    const index = records.findIndex((candidate) => candidate.id === record.id);
    if (index >= 0) records[index] = record;
    else records.push(record);
    records.sort((left, right) => left.id.localeCompare(right.id));
    await this.writeAtomically(records);
    return record;
  }

  async delete(id: string): Promise<boolean> {
    const records = [...(await this.list())];
    const remaining = records.filter((record) => record.id !== id);
    if (remaining.length === records.length) return false;
    await this.writeAtomically(remaining);
    return true;
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
