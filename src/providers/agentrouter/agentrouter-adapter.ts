import type { DiscoveredProviderModel } from "../../core/providers/model-catalog.js";
import type { ProviderAdapter } from "../../core/providers/provider-adapter.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { GenericOpenAiAdapterOptions } from "../generic-openai/generic-openai-adapter.js";
import { GenericOpenAiAdapter } from "../generic-openai/generic-openai-adapter.js";

export const agentRouterIdentityDefaults = {
  "User-Agent": "codex_cli_rs/0.144.1",
  Originator: "codex_cli_rs",
} as const;

export class AgentRouterAdapter implements ProviderAdapter {
  readonly id = "agentrouter";
  private readonly delegate: GenericOpenAiAdapter;

  constructor(options: GenericOpenAiAdapterOptions) {
    this.delegate = new GenericOpenAiAdapter(options);
  }

  supports(profile: ProviderProfile): boolean {
    return profile.adapterId === "agentrouter";
  }

  prepareProfile(profile: ProviderProfile): ProviderProfile {
    const staticHeaders = { ...profile.staticHeaders };
    setDefaultHeader(staticHeaders, "User-Agent", agentRouterIdentityDefaults["User-Agent"]);
    setDefaultHeader(staticHeaders, "Originator", agentRouterIdentityDefaults.Originator);
    return { ...profile, staticHeaders };
  }

  compatibilityFixes(): readonly string[] {
    return ["fix.auth.client-identity", "fix.models.openai-endpoint-filter"];
  }

  async discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredProviderModel[]> {
    const models = await this.delegate.discoverModels(this.prepareProfile(profile));
    return models.filter((model) => {
      const endpointTypes = model.raw.supported_endpoint_types;
      return !Array.isArray(endpointTypes) || endpointTypes.includes("openai");
    });
  }
}

function setDefaultHeader(headers: Record<string, string>, name: string, value: string): void {
  const existingName = Object.keys(headers).find(
    (candidate) => candidate.toLowerCase() === name.toLowerCase(),
  );
  if (!existingName) headers[name] = value;
}
