export const normalizedErrorTypes = [
  "AUTH_ERROR",
  "PERMISSION_ERROR",
  "MODEL_NOT_FOUND",
  "RATE_LIMIT",
  "QUOTA_EXCEEDED",
  "PROVIDER_UNAVAILABLE",
  "TIMEOUT",
  "NETWORK_ERROR",
  "INVALID_REQUEST",
  "UNSUPPORTED_FEATURE",
  "PROTOCOL_ERROR",
  "STREAM_ERROR",
  "INCOMPLETE_RESPONSE",
  "UNKNOWN",
] as const;

export type NormalizedErrorType = (typeof normalizedErrorTypes)[number];

export interface ProviderErrorGuidance {
  readonly explanation: string;
  readonly suggestedAction: string;
}

/** Stable, non-secret operator guidance shared by bridges, CLI, and UI. */
export function providerErrorGuidance(
  type: NormalizedErrorType,
): ProviderErrorGuidance {
  switch (type) {
    case "AUTH_ERROR":
      return {
        explanation: "The provider endpoint is reachable, but authentication was rejected.",
        suggestedAction: "Verify the secret reference and identity headers, then run Provider Doctor level 1.",
      };
    case "PERMISSION_ERROR":
      return {
        explanation: "Authentication succeeded, but the credential is not allowed to perform this operation.",
        suggestedAction: "Check provider account permissions and model access for this credential.",
      };
    case "MODEL_NOT_FOUND":
      return {
        explanation: "The configured model or endpoint was not found by the provider.",
        suggestedAction: "Refresh model discovery and verify the physical model ID and base URL.",
      };
    case "RATE_LIMIT":
      return {
        explanation: "The provider is reachable but is currently rate limiting requests.",
        suggestedAction: "Wait for the provider retry window or select a healthy fallback route.",
      };
    case "QUOTA_EXCEEDED":
      return {
        explanation: "The provider rejected the request because the account quota is exhausted.",
        suggestedAction: "Check account quota or billing, or select another provider route.",
      };
    case "PROVIDER_UNAVAILABLE":
      return {
        explanation: "The provider or its upstream gateway is temporarily unavailable.",
        suggestedAction: "Check provider status and retry only if the previous request was safely rejected, or use fallback.",
      };
    case "TIMEOUT":
      return {
        explanation: "The provider did not respond before the configured timeout.",
        suggestedAction: "Check provider latency and network reachability; increase timeout only when appropriate.",
      };
    case "NETWORK_ERROR":
      return {
        explanation: "ProviderDock could not establish or maintain the provider connection.",
        suggestedAction: "Verify the base URL, DNS, proxy, TLS, and local network connectivity.",
      };
    case "INVALID_REQUEST":
      return {
        explanation: "The request or provider configuration was rejected as invalid.",
        suggestedAction: "Review the provider API type and request settings, then run Provider Doctor.",
      };
    case "UNSUPPORTED_FEATURE":
      return {
        explanation: "The selected provider protocol cannot safely represent a requested feature.",
        suggestedAction: "Choose a compatible client/provider route or disable the unsupported feature.",
      };
    case "PROTOCOL_ERROR":
      return {
        explanation: "The provider response did not match the selected protocol.",
        suggestedAction: "Verify the provider API type and run Provider Doctor level 1 or higher.",
      };
    case "STREAM_ERROR":
      return {
        explanation: "The provider stream was malformed or ended inconsistently.",
        suggestedAction: "Run Provider Doctor level 2 and inspect provider compatibility before retrying.",
      };
    case "INCOMPLETE_RESPONSE":
      return {
        explanation: "The provider response ended without a valid terminal result.",
        suggestedAction: "Treat the turn as incomplete; do not replay after possible output or tool side effects.",
      };
    case "UNKNOWN":
      return {
        explanation: "ProviderDock could not classify the provider failure safely.",
        suggestedAction: "Run Provider Doctor and review the latest content-free health diagnostics.",
      };
  }
}

export interface ProviderRequestErrorOptions {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly sanitizedDetail?: string;
}

/**
 * A provider failure safe to expose to health and diagnostics layers.
 * Only bounded details produced by the central redaction layer may be retained.
 */
export class ProviderRequestError extends Error {
  readonly type: NormalizedErrorType;
  readonly httpStatus: number | undefined;
  readonly sanitizedDetail: string | undefined;

  constructor(
    type: NormalizedErrorType,
    message: string,
    options: ProviderRequestErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.type = type;
    this.httpStatus = options.httpStatus;
    this.sanitizedDetail = options.sanitizedDetail;
  }
}

export class UnsupportedProviderError extends ProviderRequestError {
  constructor(providerId: string, apiType: string) {
    super(
      "UNSUPPORTED_FEATURE",
      `No adapter is registered for provider '${providerId}' with API type '${apiType}'.`,
    );
    this.name = "UnsupportedProviderError";
  }
}

export function normalizeHttpStatus(status: number): NormalizedErrorType {
  if (status === 401) return "AUTH_ERROR";
  if (status === 403) return "PERMISSION_ERROR";
  if (status === 404) return "MODEL_NOT_FOUND";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "PROVIDER_UNAVAILABLE";
  return "INVALID_REQUEST";
}
