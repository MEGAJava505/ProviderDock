import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { secretReferenceSchema } from "../providers/provider-profile.js";
import {
  credentialPurposeSchema,
  credentialRecordSchema,
  credentialStateSchema,
  type CredentialMetadataRepository,
  type CredentialPurpose,
  type CredentialRecord,
  type CredentialState,
} from "./credential-repository.js";
import { SecretProtectionError } from "./dpapi-secret-vault.js";
import {
  decryptPortableSecretPayload,
  encryptPortableSecretPayload,
} from "./portable-secret-vault.js";
import type { SecretVault } from "./secret-store.js";

const credentialValueLimit = 65_536;
const backupDocumentSchema = z
  .object({
    version: z.literal(1),
    records: z
      .array(
        z
          .object({ record: credentialRecordSchema, value: z.string().min(1).max(credentialValueLimit) })
          .strict(),
      )
      .max(10_000),
  })
  .strict();

export interface CredentialBinding {
  readonly providerId: string;
  readonly purpose: CredentialPurpose;
  readonly secretRef: string;
}

export interface CredentialBindingAdapter {
  list(): Promise<readonly CredentialBinding[]>;
  activate(binding: CredentialBinding): Promise<void>;
  isReferenced(secretRef: string): Promise<boolean>;
}

export interface CredentialSummary {
  readonly id: string;
  readonly providerId: string;
  readonly purpose: CredentialPurpose;
  readonly label?: string;
  readonly maskedValue: string;
  readonly state: CredentialState;
  readonly createdAt: string;
  readonly lastUsedAt?: string;
}

export interface AddCredentialInput {
  readonly providerId: string;
  readonly purpose: CredentialPurpose;
  readonly value: string;
  readonly label?: string;
  readonly activate?: boolean;
}

export interface CredentialManagerOptions {
  readonly secrets: SecretVault;
  readonly metadata: CredentialMetadataRepository;
  readonly bindings?: CredentialBindingAdapter;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export interface CredentialRestoreReport {
  readonly restored: number;
  readonly skipped: number;
  readonly credentialIds: readonly string[];
}

export class CredentialManagerError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "NOT_FOUND"
      | "UNAVAILABLE"
      | "ACTIVE_REFERENCE"
      | "CONFLICT"
      | "BACKUP_ERROR",
    message: string,
  ) {
    super(message);
    this.name = "CredentialManagerError";
  }
}

export class CredentialManager {
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(private readonly options: CredentialManagerOptions) {
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async list(providerId?: string, purpose?: CredentialPurpose): Promise<readonly CredentialSummary[]> {
    if (purpose !== undefined) credentialPurposeSchema.parse(purpose);
    const bindings = await this.options.bindings?.list() ?? [];
    const activeRefs = new Set(
      bindings
        .filter((binding) => providerId === undefined || binding.providerId === providerId)
        .filter((binding) => purpose === undefined || binding.purpose === purpose)
        .map((binding) => binding.secretRef),
    );
    const records = (await this.options.metadata.list())
      .filter((record) => providerId === undefined || record.providerId === providerId)
      .filter((record) => purpose === undefined || record.purpose === purpose);
    return Promise.all(records.map(async (record) => this.toSummary(record, activeRefs.has(record.secretRef))));
  }

  async resolveActive(providerId: string, purpose: CredentialPurpose): Promise<string> {
    credentialPurposeSchema.parse(purpose);
    const bindings = await this.options.bindings?.list() ?? [];
    const binding = bindings.find(
      (candidate) => candidate.providerId === providerId && candidate.purpose === purpose,
    );
    const record = binding === undefined
      ? (await this.options.metadata.list()).find(
          (candidate) =>
            candidate.providerId === providerId &&
            candidate.purpose === purpose &&
            candidate.state === "active",
        )
      : (await this.options.metadata.list()).find(
          (candidate) =>
            candidate.providerId === providerId &&
            candidate.purpose === purpose &&
            candidate.secretRef === binding.secretRef,
        );
    if (record === undefined) {
      throw new CredentialManagerError("NOT_FOUND", "No active credential is configured.");
    }
    return this.requireValue(record);
  }

  async add(input: AddCredentialInput): Promise<CredentialSummary> {
    this.assertProviderId(input.providerId);
    credentialPurposeSchema.parse(input.purpose);
    this.assertValue(input.value);
    const id = this.idFactory();
    const secretRef = secretReferenceSchema.parse(`credential-${id}`);
    const record: CredentialRecord = {
      id,
      providerId: input.providerId,
      purpose: input.purpose,
      secretRef,
      ...(input.label === undefined ? {} : { label: input.label }),
      maskedValue: maskCredentialValue(input.value),
      state: "available",
      createdAt: this.now().toISOString(),
    };
    await this.options.secrets.set(secretRef, input.value);
    try {
      await this.options.metadata.upsert(record);
    } catch (error) {
      await this.options.secrets.delete(secretRef).catch(() => undefined);
      throw error;
    }
    if (input.activate === true) {
      return this.activate(input.providerId, input.purpose, id);
    }
    return this.toSummary(record, false);
  }

  async activate(
    providerId: string,
    purpose: CredentialPurpose,
    credentialId: string,
  ): Promise<CredentialSummary> {
    credentialPurposeSchema.parse(purpose);
    const selected = await this.options.metadata.get(credentialId);
    if (
      selected === undefined ||
      selected.providerId !== providerId ||
      selected.purpose !== purpose
    ) {
      throw new CredentialManagerError("NOT_FOUND", "Credential was not found for this binding.");
    }
    await this.requireValue(selected);
    if (this.options.bindings === undefined) {
      throw new CredentialManagerError("CONFLICT", "Credential bindings are not configured.");
    }
    await this.options.bindings.activate({ providerId, purpose, secretRef: selected.secretRef });
    for (const record of await this.options.metadata.list()) {
      if (record.providerId !== providerId || record.purpose !== purpose) continue;
      const state: CredentialState = record.id === credentialId
        ? "active"
        : record.state === "revoked"
          ? "revoked"
          : "available";
      await this.options.metadata.upsert({
        ...record,
        state,
        ...(record.id === credentialId ? { lastUsedAt: this.now().toISOString() } : {}),
      });
    }
    const updated = await this.options.metadata.get(credentialId);
    if (updated === undefined) throw new CredentialManagerError("NOT_FOUND", "Credential was removed during activation.");
    return this.toSummary(updated, true);
  }

  async remove(providerId: string, credentialId: string): Promise<void> {
    const record = await this.options.metadata.get(credentialId);
    if (record === undefined || record.providerId !== providerId) {
      throw new CredentialManagerError("NOT_FOUND", "Credential was not found.");
    }
    if (record.state === "active" || await this.options.bindings?.isReferenced(record.secretRef)) {
      throw new CredentialManagerError(
        "ACTIVE_REFERENCE",
        "Credential is still referenced by an active binding.",
      );
    }
    await this.options.secrets.delete(record.secretRef);
    await this.options.metadata.delete(record.id);
  }

  async createBackup(destination: string, passphrase: string): Promise<void> {
    const records: Array<{ readonly record: CredentialRecord; readonly value: string }> = [];
    for (const record of await this.options.metadata.list()) {
      try {
        const value = await this.options.secrets.get(record.secretRef);
        if (!value) continue;
        records.push({ record: { ...record, state: "available" }, value });
      } catch (error) {
        if (error instanceof SecretProtectionError) continue;
        throw error;
      }
    }
    const envelope = await encryptPortableSecretPayload({ version: 1, records }, passphrase);
    await mkdir(dirname(destination), { recursive: true });
    const temporaryPath = `${destination}.${this.idFactory()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(envelope, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryPath, destination);
  }

  async restoreBackup(source: string, passphrase: string): Promise<CredentialRestoreReport> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(await readFile(source, "utf8"));
    } catch (error) {
      throw new CredentialManagerError("BACKUP_ERROR", "Credential backup could not be read.");
    }
    let payload: z.infer<typeof backupDocumentSchema>;
    try {
      payload = backupDocumentSchema.parse(
        await decryptPortableSecretPayload<unknown>(envelope, passphrase),
      );
    } catch (error) {
      if (error instanceof CredentialManagerError) throw error;
      throw new CredentialManagerError("BACKUP_ERROR", "Credential backup could not be opened.");
    }

    const restored: string[] = [];
    let skipped = 0;
    for (const item of payload.records) {
      const secretRef = secretReferenceSchema.parse(`credential-${this.idFactory()}`);
      const id = this.idFactory();
      const record: CredentialRecord = {
        ...item.record,
        id,
        secretRef,
        state: "available",
        maskedValue: maskCredentialValue(item.value),
        createdAt: this.now().toISOString(),
        lastUsedAt: undefined,
      };
      try {
        await this.options.secrets.set(secretRef, item.value);
        await this.options.metadata.upsert(record);
        restored.push(id);
      } catch (error) {
        skipped += 1;
        await this.options.secrets.delete(secretRef).catch(() => undefined);
      }
    }
    return { restored: restored.length, skipped, credentialIds: restored };
  }

  async get(reference: string): Promise<string | undefined> {
    try {
      return await this.options.secrets.get(secretReferenceSchema.parse(reference));
    } catch (error) {
      if (error instanceof SecretProtectionError) return undefined;
      throw error;
    }
  }

  private async requireValue(record: CredentialRecord): Promise<string> {
    try {
      const value = await this.options.secrets.get(record.secretRef);
      if (!value) throw new Error("Missing value");
      return value;
    } catch (error) {
      if (error instanceof SecretProtectionError || error instanceof Error) {
        throw new CredentialManagerError("UNAVAILABLE", "Credential is unavailable in the local vault.");
      }
      throw error;
    }
  }

  private async toSummary(record: CredentialRecord, activeBinding: boolean): Promise<CredentialSummary> {
    let state = record.state;
    if (state !== "revoked") {
      try {
        const value = await this.options.secrets.get(record.secretRef);
        state = value ? (activeBinding ? "active" : "available") : "unavailable";
      } catch (error) {
        if (error instanceof SecretProtectionError) state = "unavailable";
        else throw error;
      }
    }
    return {
      id: record.id,
      providerId: record.providerId,
      purpose: record.purpose,
      ...(record.label === undefined ? {} : { label: record.label }),
      maskedValue: record.maskedValue,
      state,
      createdAt: record.createdAt,
      ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
    };
  }

  private assertProviderId(value: string): void {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)) {
      throw new CredentialManagerError("INVALID_INPUT", "Provider ID is invalid.");
    }
  }

  private assertValue(value: string): void {
    if (typeof value !== "string" || value.length === 0 || value.length > credentialValueLimit) {
      throw new CredentialManagerError("INVALID_INPUT", "Credential value is invalid.");
    }
  }
}

export function maskCredentialValue(value: string): string {
  if (value.length >= 8) return `${value.slice(0, 3)}…${value.slice(-4)}`;
  if (value.length <= 2) return "••••";
  return `${value.slice(0, 1)}…${value.slice(-1)}`;
}
