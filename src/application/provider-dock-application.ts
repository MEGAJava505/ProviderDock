import type { ProviderProbeResult, ProviderProbeService } from "../core/health/provider-probe-service.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import { parseProviderProfile } from "../core/providers/provider-profile.js";
import type { ProviderProfileRepository } from "../core/providers/provider-profile-repository.js";
import type { SecretVault } from "../core/security/secret-store.js";

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Provider '${providerId}' is not configured.`);
    this.name = "ProviderNotFoundError";
  }
}

export class SecretVaultUnavailableError extends Error {
  constructor() {
    super("A writable OS secret vault is not available on this platform.");
    this.name = "SecretVaultUnavailableError";
  }
}

export class ProviderDockApplication {
  constructor(
    private readonly profiles: ProviderProfileRepository,
    private readonly probes: ProviderProbeService,
    private readonly secretVault?: SecretVault,
  ) {}

  listProviders(): Promise<readonly ProviderProfile[]> {
    return this.profiles.list();
  }

  async getProvider(id: string): Promise<ProviderProfile> {
    const profile = await this.profiles.get(id);
    if (!profile) throw new ProviderNotFoundError(id);
    return profile;
  }

  async setProvider(input: unknown): Promise<ProviderProfile> {
    return this.profiles.upsert(parseProviderProfile(input));
  }

  async removeProvider(id: string): Promise<void> {
    if (!(await this.profiles.delete(id))) throw new ProviderNotFoundError(id);
  }

  async probeProvider(id: string): Promise<ProviderProbeResult> {
    return this.probes.probe(await this.getProvider(id));
  }

  async setSecret(reference: string, value: string): Promise<void> {
    await this.requireSecretVault().set(reference, value);
  }

  listSecretReferences(): Promise<readonly string[]> {
    return this.requireSecretVault().listReferences();
  }

  async removeSecret(reference: string): Promise<boolean> {
    return this.requireSecretVault().delete(reference);
  }

  private requireSecretVault(): SecretVault {
    if (!this.secretVault) throw new SecretVaultUnavailableError();
    return this.secretVault;
  }
}
