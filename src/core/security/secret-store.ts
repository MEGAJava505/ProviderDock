export interface SecretStore {
  get(reference: string): Promise<string | undefined>;
}

export class EnvironmentSecretStore implements SecretStore {
  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async get(reference: string): Promise<string | undefined> {
    return this.environment[reference];
  }
}

/** Intended for tests and short-lived runtime sessions only. */
export class MemorySecretStore implements SecretStore {
  private readonly secrets: Map<string, string>;

  constructor(secrets: Readonly<Record<string, string>> = {}) {
    this.secrets = new Map(Object.entries(secrets));
  }

  async get(reference: string): Promise<string | undefined> {
    return this.secrets.get(reference);
  }

  set(reference: string, value: string): void {
    this.secrets.set(reference, value);
  }
}

