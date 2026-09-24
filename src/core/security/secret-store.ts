import { SecretProtectionError } from "./dpapi-secret-vault.js";
import { randomUUID } from "node:crypto";

export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
  /** Opaque, non-secret generation identifier; unavailable stores fail pilot closed. */
  revision?(reference: string): Promise<string | undefined>;
}

export interface SecretVault extends SecretStore {
  set(reference: string, value: string): Promise<void>;
  delete(reference: string): Promise<boolean>;
  listReferences(): Promise<readonly string[]>;
}

export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async get(reference: string): Promise<string | undefined> {
    return this.environment[reference];
  }
}

/** Intended for tests and short-lived runtime sessions only. */
export class MemorySecretStore implements SecretVault {
  private readonly secrets: Map<string, string>;
  private readonly revisions: Map<string, string>;

  constructor(secrets: Readonly<Record<string, string>> = {}) {
    this.secrets = new Map(Object.entries(secrets));
    this.revisions = new Map(Object.keys(secrets).map((reference) => [reference, randomUUID()]));
  }

  async get(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }

  async set(reference: string, value: string): Promise<void> {
    this.secrets.set(reference, value);
    this.revisions.set(reference, randomUUID());
  }

  async delete(reference: string): Promise<boolean> {
    this.revisions.delete(reference);
    return this.secrets.delete(reference);
  }

  async revision(reference: string): Promise<string | undefined> {
    return this.revisions.get(reference);
  }

  async listReferences(): Promise<readonly string[]> {
    return [...this.secrets.keys()].sort((left, right) => left.localeCompare(right));
  }
}

export class ChainedSecretStore implements SecretStore {
  constructor(private readonly stores: readonly SecretStore[]) {}

  async get(reference: string): Promise<string | undefined> {
    for (const store of this.stores) {
      try {
        const secret = await store.get(reference);
        if (secret !== undefined) return secret;
      } catch (error) {
        if (error instanceof SecretProtectionError) continue;
        throw error;
      }
    }
    return undefined;
  }

  async revision(reference: string): Promise<string | undefined> {
    for (const source of this.stores) {
      try {
        if (await source.get(reference) !== undefined) return source.revision?.(reference);
      } catch (error) {
        if (error instanceof SecretProtectionError) continue;
        throw error;
      }
    }
    return undefined;
  }
}
