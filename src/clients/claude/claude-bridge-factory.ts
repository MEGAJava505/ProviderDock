import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { AnthropicBridgeAddress } from "../../bridge/anthropic/anthropic-bridge-server.js";
import { AnthropicBridgeServer } from "../../bridge/anthropic/anthropic-bridge-server.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { FileTurnLedgerStore } from "../../core/state-machine/persistent-turn-ledger.js";

export interface CreateClaudeBridgeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly clientToken: string;
  readonly sessionId: string;
}

export interface ManagedClaudeBridge {
  start(): Promise<AnthropicBridgeAddress>;
  stop(): Promise<void>;
  /** Ends the runtime session and removes its persisted non-secret ledger. */
  dispose?(): Promise<void>;
}

export interface ClaudeBridgeFactory {
  create(input: CreateClaudeBridgeInput): ManagedClaudeBridge;
}

export interface AnthropicClaudeBridgeFactoryOptions {
  readonly secretStore: SecretStore;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly runtimeRoot?: string;
}

/** Creates one loopback Anthropic Messages bridge for one Claude Code session. */
export class AnthropicClaudeBridgeFactory implements ClaudeBridgeFactory {
  constructor(private readonly options: AnthropicClaudeBridgeFactoryOptions) {}

  create(input: CreateClaudeBridgeInput): ManagedClaudeBridge {
    if (!/^[a-f0-9]{32}$/.test(input.sessionId)) {
      throw new TypeError("Claude bridge sessionId must contain 32 lowercase hexadecimal characters.");
    }
    const sessionDirectory =
      this.options.runtimeRoot === undefined
        ? undefined
        : join(this.options.runtimeRoot, input.sessionId);
    const turnLedgerStore =
      sessionDirectory === undefined
        ? undefined
        : new FileTurnLedgerStore({
            filePath: join(sessionDirectory, "turn-ledger.json"),
          });
    const server = new AnthropicBridgeServer({
      profile: input.profile,
      clientToken: input.clientToken,
      secretStore: this.options.secretStore,
      ...(this.options.adapterRegistry === undefined
        ? {}
        : { adapterRegistry: this.options.adapterRegistry }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      ...(turnLedgerStore === undefined ? {} : { turnLedgerStore }),
    });
    if (sessionDirectory === undefined) return server;
    return {
      start: () => server.start(),
      stop: () => server.stop(),
      dispose: async () => {
        await server.stop();
        await rm(sessionDirectory, { recursive: true, force: true });
      },
    };
  }
}
