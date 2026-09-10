import type { NormalizedErrorType } from "../errors/provider-error.js";
import type { FallbackFailurePhase } from "../fallback/fallback-session-router.js";
import type { ModelHealthStatus } from "../providers/model-catalog.js";
import type { UsageClient, UsageProtocol } from "../usage/usage-event.js";

export const providerRuntimeOutcomes = [
  "completed",
  "incomplete",
  "failed",
] as const;
export type ProviderRuntimeOutcome = (typeof providerRuntimeOutcomes)[number];

/** A content-free health observation emitted by a real managed-bridge request. */
export interface ProviderRuntimeHealthSignal {
  readonly providerId: string;
  readonly modelId: string;
  readonly observedAt: string;
  readonly client: UsageClient;
  readonly protocol: UsageProtocol;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly logicalModelId?: string;
  readonly outcome: ProviderRuntimeOutcome;
  readonly healthStatus: ModelHealthStatus;
  readonly errorType?: NormalizedErrorType;
  readonly httpStatus?: number;
  readonly executionPhase?: FallbackFailurePhase;
  readonly errorMessage?: string;
}

export type ProviderRuntimeHealthSignalSink = (
  signal: ProviderRuntimeHealthSignal,
) => void | Promise<void>;

export interface CreateProviderRuntimeHealthSignalInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly client: UsageClient;
  readonly protocol: UsageProtocol;
  readonly sessionId?: string;
  readonly requestId?: string;
  readonly logicalModelId?: string;
  readonly outcome: ProviderRuntimeOutcome;
  readonly errorType?: NormalizedErrorType;
  readonly httpStatus?: number;
  readonly executionPhase?: FallbackFailurePhase;
  readonly errorMessage?: string;
  readonly observedAt?: Date;
}

export function createProviderRuntimeHealthSignal(
  input: CreateProviderRuntimeHealthSignalInput,
): ProviderRuntimeHealthSignal {
  return {
    providerId: input.providerId,
    modelId: input.modelId,
    observedAt: (input.observedAt ?? new Date()).toISOString(),
    client: input.client,
    protocol: input.protocol,
    ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
    ...(input.logicalModelId === undefined
      ? {}
      : { logicalModelId: input.logicalModelId }),
    outcome: input.outcome,
    healthStatus: runtimeHealthStatus(input.outcome, input.errorType),
    ...(input.errorType === undefined ? {} : { errorType: input.errorType }),
    ...(input.httpStatus === undefined ? {} : { httpStatus: input.httpStatus }),
    ...(input.executionPhase === undefined
      ? {}
      : { executionPhase: input.executionPhase }),
    ...(input.errorMessage === undefined
      ? {}
      : { errorMessage: input.errorMessage }),
  };
}

export function runtimeHealthStatus(
  outcome: ProviderRuntimeOutcome,
  errorType?: NormalizedErrorType,
): ModelHealthStatus {
  if (outcome === "completed") return "ONLINE";
  if (outcome === "incomplete" && errorType === undefined) return "DEGRADED";
  switch (errorType) {
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
    case undefined:
      return outcome === "incomplete" ? "DEGRADED" : "OFFLINE";
  }
}
