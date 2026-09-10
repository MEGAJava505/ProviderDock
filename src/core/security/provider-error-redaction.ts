const defaultMaximumCharacters = 1_024;

export interface SanitizeProviderErrorOptions {
  readonly maximumCharacters?: number;
  /** Exact in-memory values known to be credentials for this request. */
  readonly sensitiveValues?: readonly string[];
  /** Plain text cannot be structurally allowlisted and is hidden by default. */
  readonly allowPlainText?: boolean;
}

export interface ReadProviderErrorOptions extends SanitizeProviderErrorOptions {
  readonly maximumBytes?: number;
}

export async function readSanitizedProviderErrorBody(
  response: Response,
  options: ReadProviderErrorOptions = {},
): Promise<string | undefined> {
  const maximumBytes = options.maximumBytes ?? 64 * 1_024;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new TypeError("maximumBytes must be a positive safe integer.");
  }
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < maximumBytes) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const remaining = maximumBytes - size;
      chunks.push(chunk.value.subarray(0, remaining));
      size += Math.min(chunk.value.byteLength, remaining);
      if (chunk.value.byteLength > remaining) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
    if (size >= maximumBytes) await reader.cancel().catch(() => undefined);
  } finally {
    reader.releaseLock();
  }
  return sanitizeProviderErrorBody(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"),
    options,
  );
}

/**
 * Extracts a short diagnostic from an upstream error body without retaining
 * arbitrary JSON fields or obvious credential material.
 */
export function sanitizeProviderErrorBody(
  body: string,
  options: SanitizeProviderErrorOptions = {},
): string | undefined {
  const maximumCharacters =
    options.maximumCharacters ?? defaultMaximumCharacters;
  if (!Number.isSafeInteger(maximumCharacters) || maximumCharacters <= 0) {
    throw new TypeError("maximumCharacters must be a positive safe integer.");
  }
  const extracted = extractKnownErrorFields(body);
  if (extracted === undefined && options.allowPlainText !== true) return undefined;
  let sanitized = extracted
    ?? body;
  sanitized = sanitized
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const value of options.sensitiveValues ?? []) {
    if (value.length > 0) sanitized = sanitized.split(value).join("[REDACTED]");
  }
  sanitized = sanitized
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]")
    .replace(/\b(api[_-]?key|access[_-]?token|auth(?:orization)?|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/([?&](?:api[_-]?key|key|token|access_token|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[REDACTED]");
  if (sanitized.length === 0) return undefined;
  if (sanitized.length <= maximumCharacters) return sanitized;
  return `${sanitized.slice(0, Math.max(1, maximumCharacters - 1)).trimEnd()}…`;
}

function extractKnownErrorFields(body: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const source = isRecord(parsed.error) ? parsed.error : parsed;
  const values: string[] = [];
  for (const key of ["message", "detail", "error_description", "type", "code"]) {
    const value = source[key];
    if (typeof value === "string" && value.trim().length > 0) {
      values.push(`${key}: ${value.trim()}`);
    } else if (typeof value === "number" || typeof value === "boolean") {
      values.push(`${key}: ${String(value)}`);
    }
  }
  return values.length === 0 ? undefined : values.join("; ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
