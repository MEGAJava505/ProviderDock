import type { DiscoveredProviderModel } from "./model-catalog.js";
import type { ProviderProfile } from "./provider-profile.js";

export interface ProviderAdapter {
  readonly id: string;
  supports(profile: ProviderProfile): boolean;
  prepareProfile?(profile: ProviderProfile): ProviderProfile;
  compatibilityFixes?(profile: ProviderProfile): readonly string[];
  discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredProviderModel[]>;
}
