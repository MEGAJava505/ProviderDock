import {
  ProviderRequestError,
  type NormalizedErrorType,
} from "../errors/provider-error.js";
import {
  mergeModelCatalog,
  type ModelCatalogEntry,
  type ModelHealthStatus,
} from "../providers/model-catalog.js";
import type { ProviderAdapterRegistry } from "../providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../providers/provider-profile.js";

export interface ProviderHealthSnapshot {
  readonly providerId: string;
  readonly status: ModelHealthStatus;
  readonly checkedAt: string;
  readonly latencyMs: number;
  readonly discoveredModelCount: number;
  readonly errorType?: NormalizedErrorType;
  readonly errorMessage?: string;
  readonly httpStatus?: number;
}

export interface ProviderProbeResult {
  readonly health: ProviderHealthSnapshot;
  readonly models: readonly ModelCatalogEntry[];
}

export interface ProviderProbeServiceOptions {
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

export class ProviderProbeService {
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly registry: ProviderAdapterRegistry,
    options: ProviderProbeServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async probe(profile: ProviderProfile): Promise<ProviderProbeResult> {
    const startedAt = this.monotonicNow();

    if (!profile.enabled || !profile.healthCheck.enabled) {
      return {
        health: this.snapshot(profile.id, "DISABLED", startedAt, 0),
        models: mergeModelCatalog(profile, []),
      };
    }

    try {
      const adapter = this.registry.resolve(profile);
      const discoveredModels = await adapter.discoverModels(profile);
      const status: ModelHealthStatus = discoveredModels.length > 0 ? "ONLINE" : "DEGRADED";

      return {
        health: this.snapshot(profile.id, status, startedAt, discoveredModels.length),
        models: mergeModelCatalog(profile, discoveredModels),
      };
    } catch (error) {
      const normalized =
        error instanceof ProviderRequestError
          ? error
          : new ProviderRequestError("UNKNOWN", "Unexpected provider probe failure.", {
              cause: error,
            });

      return {
        health: {
          ...this.snapshot(profile.id, healthStatusForError(normalized.type), startedAt, 0),
          errorType: normalized.type,
          errorMessage: normalized.message,
          ...(normalized.httpStatus === undefined ? {} : { httpStatus: normalized.httpStatus }),
        },
        models: mergeModelCatalog(profile, []),
      };
    }
  }

  private snapshot(
    providerId: string,
    status: ModelHealthStatus,
    startedAt: number,
    discoveredModelCount: number,
  ): ProviderHealthSnapshot {
    return {
      providerId,
      status,
      checkedAt: this.now().toISOString(),
      latencyMs: Math.max(0, Math.round(this.monotonicNow() - startedAt)),
      discoveredModelCount,
    };
  }
}

function healthStatusForError(type: NormalizedErrorType): ModelHealthStatus {
  switch (type) {
    case "AUTH_ERROR":
    case "PERMISSION_ERROR":
      return "AUTH_ERROR";
    case "RATE_LIMIT":
    case "QUOTA_EXCEEDED":
      return "RATE_LIMITED";
    case "UNSUPPORTED_FEATURE":
      return "INCOMPATIBLE";
    case "INVALID_REQUEST":
    case "MODEL_NOT_FOUND":
    case "PROTOCOL_ERROR":
    case "STREAM_ERROR":
    case "INCOMPLETE_RESPONSE":
      return "DEGRADED";
    case "PROVIDER_UNAVAILABLE":
    case "TIMEOUT":
    case "NETWORK_ERROR":
    case "UNKNOWN":
      return "OFFLINE";
  }
}

