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

  resolve(profile: ProviderProfile): ProviderAdapter {
    const adapter = this.adapters.find((candidate) => candidate.supports(profile));
    if (!adapter) throw new UnsupportedProviderError(profile.id, profile.apiType);
    return adapter;
  }
}

