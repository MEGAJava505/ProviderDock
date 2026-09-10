import { UnsupportedProviderError } from "../errors/provider-error.js";
import type { ProviderAdapter } from "./provider-adapter.js";
import type { ProviderProfile } from "./provider-profile.js";

export class ProviderAdapterRegistry {
  private readonly adapters: ProviderAdapter[] = [];

  register(adapter: ProviderAdapter): this {
    if (this.adapters.some((candidate) => candidate.id === adapter.id)) {
      throw new Error(`Provider adapter '${adapter.id}' is already registered.`);
    }
    this.adapters.push(adapter);
    return this;
  }

  listAdapterIds(): readonly string[] {
    return this.adapters.map((adapter) => adapter.id);
  }

  resolve(profile: ProviderProfile): ProviderAdapter {
    const adapter = this.find(profile);
    if (!adapter) throw new UnsupportedProviderError(profile.id, profile.apiType);
    return adapter;
  }

  prepareProfile(profile: ProviderProfile): ProviderProfile {
    const adapter = this.find(profile);
    return adapter?.prepareProfile?.(profile) ?? profile;
  }

  private find(profile: ProviderProfile): ProviderAdapter | undefined {
    const explicit = this.adapters.find(
      (candidate) => candidate.id === profile.adapterId,
    );
    if (explicit !== undefined) {
      return explicit.supports(profile) ? explicit : undefined;
    }
    if (profile.adapterId.startsWith("plugin:")) return undefined;
    return this.adapters.find((candidate) => candidate.supports(profile));
  }
}
