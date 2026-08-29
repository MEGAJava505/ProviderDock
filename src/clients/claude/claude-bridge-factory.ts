import type { AnthropicBridgeAddress } from "../../bridge/anthropic/anthropic-bridge-server.js";
import { AnthropicBridgeServer } from "../../bridge/anthropic/anthropic-bridge-server.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";

export interface CreateClaudeBridgeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly clientToken: string;
}

export interface ManagedClaudeBridge {
  start(): Promise<AnthropicBridgeAddress>;
  stop(): Promise<void>;
}

export interface ClaudeBridgeFactory {
  create(input: CreateClaudeBridgeInput): ManagedClaudeBridge;
}

export interface AnthropicClaudeBridgeFactoryOptions {
  readonly secretStore: SecretStore;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fetchImpl?: typeof fetch;
}

/** Creates one loopback Anthropic Messages bridge for one Claude Code session. */
export class AnthropicClaudeBridgeFactory implements ClaudeBridgeFactory {
  constructor(private readonly options: AnthropicClaudeBridgeFactoryOptions) {}

  create(input: CreateClaudeBridgeInput): ManagedClaudeBridge {
    return new AnthropicBridgeServer({
      profile: input.profile,
      clientToken: input.clientToken,
      secretStore: this.options.secretStore,
      ...(this.options.adapterRegistry === undefined
        ? {}
        : { adapterRegistry: this.options.adapterRegistry }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
    });
  }
}
