import type { FallbackFailurePhase } from "./fallback-session-router.js";

/**
 * Only explicit request rejections prove that an HTTP response is safe to
 * route elsewhere. Gateway/server errors other than 501/503 may arrive after
 * ambiguous upstream execution and therefore fail closed.
 */
export function fallbackFailurePhaseForHttpStatus(
  status: number,
): FallbackFailurePhase {
  if ((status >= 400 && status < 500) || status === 501 || status === 503) {
    return "request-rejected";
  }
  return "unknown";
}

/** Detects transport errors that prove no upstream connection was established. */
export function isConnectionEstablishmentFailure(error: unknown): boolean {
  const safeCodes = new Set([
    "ECONNREFUSED",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT",
  ]);
  let current: unknown = error;
  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    const record = current as { readonly code?: unknown; readonly cause?: unknown };
    if (typeof record.code === "string" && safeCodes.has(record.code)) return true;
    current = record.cause;
  }
  return false;
}
