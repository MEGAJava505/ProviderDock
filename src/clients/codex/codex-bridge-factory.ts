import type { ModelProtocolResolver } from "../../core/providers/model-protocol.js";
import type { ModelAccessCheck } from "../../core/providers/model-access.js";
import { join } from "node:path";
import type {
  ResponsesBridgeAddress,
  ResponsesBridgeFallbackConfiguration,
} from "../../bridge/responses/responses-bridge-server.js";
import { ResponsesBridgeServer } from "../../bridge/responses/responses-bridge-server.js";
import type { FallbackNotification } from "../../core/fallback/fallback-session-router.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { FileTurnLedgerStore } from "../../core/state-machine/persistent-turn-ledger.js";
import type { UsageEventSink } from "../../core/usage/usage-event.js";
import type { ProviderRuntimeHealthSignalSink } from "../../core/health/provider-runtime-health.js";

export interface CreateCodexBridgeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly sessionId: string;
  readonly fallback?: ResponsesBridgeFallbackConfiguration;
  readonly onFallback?: (notification: FallbackNotification) => void;
  readonly sessionInstructions?: string;
  readonly defaultReasoningLevel?: string;
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
  readonly modelAccessCheck?: ModelAccessCheck;
  readonly protocolResolver?: ModelProtocolResolver;
  readonly adapterRegistry?: ProviderAdapterRegistry;
  readonly fetchImpl?: typeof fetch;
  readonly runtimeRoot?: string;
  readonly usageSink?: UsageEventSink;
  readonly healthSignalSink?: ProviderRuntimeHealthSignalSink;
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
      ...(this.options.protocolResolver ? { protocolResolver: this.options.protocolResolver } : {}),
      ...(this.options.modelAccessCheck ? { modelAccessCheck: this.options.modelAccessCheck } : {}),
      secretStore: this.options.secretStore,
      ...(this.options.adapterRegistry === undefined
        ? {}
        : { adapterRegistry: this.options.adapterRegistry }),
      ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
      models: [
        {
          modelId: input.modelId,
          ...(input.defaultReasoningLevel === undefined
            ? {}
            : {
                defaultReasoningLevel: input.defaultReasoningLevel,
                supportedReasoningLevels: [input.defaultReasoningLevel],
              }),
        },
      ],
      ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
      ...(input.onFallback === undefined ? {} : { onFallback: input.onFallback }),
      ...(input.sessionInstructions === undefined
        ? {}
        : { sessionInstructions: input.sessionInstructions }),
      sessionId: input.sessionId,
      ...(this.options.usageSink === undefined
        ? {}
        : { usageSink: this.options.usageSink }),
      ...(this.options.healthSignalSink === undefined
        ? {}
        : { healthSignalSink: this.options.healthSignalSink }),
      ...(turnLedgerStore === undefined ? {} : { turnLedgerStore }),
    });
  }
}
