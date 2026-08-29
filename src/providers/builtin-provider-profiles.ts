import {
  parseProviderProfile,
  type ProviderProfile,
  type ProviderProfileInput,
} from "../core/providers/provider-profile.js";
import { agentRouterIdentityDefaults } from "./agentrouter/agentrouter-adapter.js";

export interface AgentRouterProfileOptions {
  readonly id?: string;
  readonly displayName?: string;
  readonly baseUrl?: string;
  readonly secretRef?: string;
  readonly overrides?: Partial<ProviderProfileInput>;
}

export function createAgentRouterProfile(
  options: AgentRouterProfileOptions = {},
): ProviderProfile {
  return parseProviderProfile({
    id: options.id ?? "agentrouter",
    displayName: options.displayName ?? "AgentRouter",
    baseUrl: options.baseUrl ?? "https://agentrouter.org/v1",
    apiType: "auto",
    adapterId: "agentrouter",
    auth: { kind: "bearer", secretRef: options.secretRef ?? "AGENTROUTER_API_KEY" },
    staticHeaders: agentRouterIdentityDefaults,
    ...(options.overrides ?? {}),
  });
}

export interface GoRouterProfileOptions {
  readonly baseUrl: string;
  readonly secretRef: string;
  readonly id?: string;
  readonly displayName?: string;
  readonly overrides?: Partial<ProviderProfileInput>;
}

export function createGoRouterProfile(options: GoRouterProfileOptions): ProviderProfile {
  return parseProviderProfile({
    id: options.id ?? "gorouter",
    displayName: options.displayName ?? "GoRouter",
    baseUrl: options.baseUrl,
    apiType: "auto",
    adapterId: "gorouter",
    auth: { kind: "bearer", secretRef: options.secretRef },
    ...(options.overrides ?? {}),
  });
}
