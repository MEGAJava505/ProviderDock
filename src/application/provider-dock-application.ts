import type { ProviderProbeResult, ProviderProbeService } from "../core/health/provider-probe-service.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import { parseProviderProfile } from "../core/providers/provider-profile.js";
import type { ProviderProfileRepository } from "../core/providers/provider-profile-repository.js";
import type { ProviderAdapterRegistry } from "../core/providers/provider-adapter-registry.js";
import type { SecretVault } from "../core/security/secret-store.js";
import { secretReferenceSchema } from "../core/providers/provider-profile.js";
import type {
  CodexLauncher,
  CodexProcessExit,
  LaunchCodexInput,
} from "../clients/codex/codex-launcher.js";
import type { CodexRecoveryOutcome } from "../clients/codex/codex-runtime-session.js";

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
    private readonly codexLauncher?: CodexLauncher,
    private readonly adapters?: ProviderAdapterRegistry,
  ) {}

  async listProviders(): Promise<readonly ProviderProfile[]> {
    return (await this.profiles.list()).map((profile) => this.prepareProfile(profile));
  }

  async getProvider(id: string): Promise<ProviderProfile> {
    const profile = await this.profiles.get(id);
    if (!profile) throw new ProviderNotFoundError(id);
    return this.prepareProfile(profile);
  }

  async setProvider(input: unknown): Promise<ProviderProfile> {
    return this.profiles.upsert(this.prepareProfile(parseProviderProfile(input)));
  }

  async removeProvider(id: string): Promise<void> {
    if (!(await this.profiles.delete(id))) throw new ProviderNotFoundError(id);
  }

  async probeProvider(id: string): Promise<ProviderProbeResult> {
    return this.probes.probe(await this.getProvider(id));
  }

  async setSecret(reference: string, value: string): Promise<void> {
    await this.requireSecretVault().set(secretReferenceSchema.parse(reference), value);
  }

  listSecretReferences(): Promise<readonly string[]> {
    return this.requireSecretVault().listReferences();
  }

  async removeSecret(reference: string): Promise<boolean> {
    return this.requireSecretVault().delete(secretReferenceSchema.parse(reference));
  }

  async launchCodex(
    input: Omit<LaunchCodexInput, "profile"> & { readonly providerId: string },
  ): Promise<CodexProcessExit> {
    const { providerId, ...launchInput } = input;
    return this.requireCodexLauncher().launch({
      ...launchInput,
      profile: await this.getProvider(providerId),
    });
  }

  recoverCodexSessions(): Promise<readonly CodexRecoveryOutcome[]> {
    return this.requireCodexLauncher().recover();
  }

  private requireSecretVault(): SecretVault {
    if (!this.secretVault) throw new SecretVaultUnavailableError();
    return this.secretVault;
  }

  private requireCodexLauncher(): CodexLauncher {
    if (!this.codexLauncher) {
      throw new Error("The Codex runtime launcher is not configured.");
    }
    return this.codexLauncher;
  }

  private prepareProfile(profile: ProviderProfile): ProviderProfile {
    return this.adapters?.prepareProfile(profile) ?? profile;
  }
}
