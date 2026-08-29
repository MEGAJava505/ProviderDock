export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
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

  constructor(secrets: Readonly<Record<string, string>> = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  async get(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }

  async set(reference: string, value: string): Promise<void> {
    this.secrets.set(reference, value);
  }

  async delete(reference: string): Promise<boolean> {
    return this.secrets.delete(reference);
  }

  async listReferences(): Promise<readonly string[]> {
    return [...this.secrets.keys()].sort((left, right) => left.localeCompare(right));
  }
}

export class ChainedSecretStore implements SecretStore {
  constructor(private readonly stores: readonly SecretStore[]) {}

  async get(reference: string): Promise<string | undefined> {
    for (const store of this.stores) {
      const secret = await store.get(reference);
      if (secret !== undefined) return secret;
    }
    return undefined;
  }
}
