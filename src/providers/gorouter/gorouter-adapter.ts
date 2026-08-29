import type { DiscoveredProviderModel } from "../../core/providers/model-catalog.js";
import type { ProviderAdapter } from "../../core/providers/provider-adapter.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { GenericOpenAiAdapterOptions } from "../generic-openai/generic-openai-adapter.js";
import { GenericOpenAiAdapter } from "../generic-openai/generic-openai-adapter.js";

/**
 * GoRouter intentionally starts without guessed compatibility fixes. Probe evidence can
 * add scoped rules later without changing the generic OpenAI adapter.
 */
export class GoRouterAdapter implements ProviderAdapter {
  readonly id = "gorouter";
  private readonly delegate: GenericOpenAiAdapter;

  constructor(options: GenericOpenAiAdapterOptions) {
    this.delegate = new GenericOpenAiAdapter(options);
  }

  supports(profile: ProviderProfile): boolean {
    return profile.adapterId === "gorouter";
  }

  compatibilityFixes(): readonly string[] {
    return [];
  }

  discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredProviderModel[]> {
    return this.delegate.discoverModels(profile);
  }
}
