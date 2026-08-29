import type { ProviderProbeResult, ProviderProbeService } from "../core/health/provider-probe-service.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import { parseProviderProfile } from "../core/providers/provider-profile.js";
import type { ProviderProfileRepository } from "../core/providers/provider-profile-repository.js";

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Provider '${providerId}' is not configured.`);
    this.name = "ProviderNotFoundError";
  }
}

export class ProviderDockApplication {
  constructor(
    private readonly profiles: ProviderProfileRepository,
    private readonly probes: ProviderProbeService,
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
}
