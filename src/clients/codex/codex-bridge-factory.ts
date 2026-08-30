import { join } from "node:path";
import type { ResponsesBridgeAddress } from "../../bridge/responses/responses-bridge-server.js";
import { ResponsesBridgeServer } from "../../bridge/responses/responses-bridge-server.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { FileTurnLedgerStore } from "../../core/state-machine/persistent-turn-ledger.js";

export interface CreateCodexBridgeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly sessionId: string;
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
  readonly runtimeRoot?: string;
}

/** Creates one loopback Responses bridge for one Codex runtime session. */
export class ResponsesCodexBridgeFactory implements CodexBridgeFactory {
  constructor(private readonly options: ResponsesCodexBridgeFactoryOptions) {}

  create(input: CreateCodexBridgeInput): ManagedCodexBridge {
    if (!/^[a-f0-9]{32}$/.test(input.sessionId)) {
      throw new TypeError("Codex bridge sessionId must contain 32 lowercase hexadecimal characters.");
    }
    const turnLedgerStore =
      this.options.runtimeRoot === undefined
        ? undefined
        : new FileTurnLedgerStore({
            filePath: join(this.options.runtimeRoot, input.sessionId, "turn-ledger.json"),
          });
    return new ResponsesBridgeServer({
      profile: input.profile,
      secretStore: this.options.secretStore,
      ...(this.options.adapterRegistry === undefined
        ? {}
        : { adapterRegistry: this.options.adapterRegistry }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      models: [{ modelId: input.modelId }],
      ...(turnLedgerStore === undefined ? {} : { turnLedgerStore }),
    });
  }
}
