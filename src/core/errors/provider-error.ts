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

export interface ProviderRequestErrorOptions {
  readonly cause?: unknown;
  readonly httpStatus?: number;
}

/**
 * A provider failure safe to expose to health and diagnostics layers.
 * Upstream response bodies are deliberately not retained here until the
 * central redaction layer exists.
 */
export class ProviderRequestError extends Error {
  readonly type: NormalizedErrorType;
  readonly httpStatus: number | undefined;

  constructor(
    type: NormalizedErrorType,
    message: string,
    options: ProviderRequestErrorOptions = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "ProviderRequestError";
    this.type = type;
    this.httpStatus = options.httpStatus;
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

