import type { ResponsesBridgeAddress } from "../../bridge/responses/responses-bridge-server.js";
import { ResponsesBridgeServer } from "../../bridge/responses/responses-bridge-server.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";

export interface CreateCodexBridgeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
}

export interface ManagedCodexBridge {
  start(): Promise<ResponsesBridgeAddress>;
  stop(): Promise<void>;
}

export interface CodexBridgeFactory {
  create(input: CreateCodexBridgeInput): ManagedCodexBridge;
}

export interface ResponsesCodexBridgeFactoryOptions {
  readonly secretStore: SecretStore;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fetchImpl?: typeof fetch;
}

/** Creates one loopback Responses bridge for one Codex runtime session. */
export class ResponsesCodexBridgeFactory implements CodexBridgeFactory {
  constructor(private readonly options: ResponsesCodexBridgeFactoryOptions) {}

  create(input: CreateCodexBridgeInput): ManagedCodexBridge {
    return new ResponsesBridgeServer({
      profile: input.profile,
      secretStore: this.options.secretStore,
      ...(this.options.adapterRegistry === undefined
        ? {}
        : { adapterRegistry: this.options.adapterRegistry }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      models: [{ modelId: input.modelId }],
    });
  }
}
