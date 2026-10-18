import {
  normalizeHttpStatus,
  ProviderRequestError,
  type NormalizedErrorType,
} from "../core/errors/provider-error.js";
import { ProviderHttpRequestBuilder } from "../core/providers/provider-http-request.js";
import type { ProviderAuth, ProviderProfile } from "../core/providers/provider-profile.js";
import type { SecretStore } from "../core/security/secret-store.js";
import { classifyResponsesStructure, type ResponsesStructureSummary } from "./provider-doctor.js";

/**
 * M7 — a single, opt-in, secret-free path from a live API profile to ONE safe
 * structural summary of an OpenAI Responses reply.
 *
 * It is NEVER called by ProviderDoctor.run(), the dashboard, preflight, or an
 * OMP launch: it is a standalone function reached only when a caller decides to
 * run it. By construction it makes AT MOST ONE outgoing request (no retry, no
 * streaming, no tools), forbids HTTP redirects off the configured origin, caps
 * how long it waits and how many bytes it reads, and reduces the reply to the
 * allowlisted `classifyResponsesStructure` summary. On any failure it returns
 * only a normalized error code — never the response body, headers, request id,
 * secret, prompt, or a path. It persists nothing, so it cannot change the
 * fail-closed Doctor gate or the stored health snapshot, and a structural
 * result never opens the OMP pilot gate on its own.
 */

/** The endpoint (relative to the profile base URL) the probe always targets. */
export const RESPONSES_STRUCTURE_PROBE_ENDPOINT = "responses";
/** Output-token ceiling for the single request (above Doctor's 16 so reasoning tokens need not consume the whole budget). */
export const RESPONSES_STRUCTURE_PROBE_MAX_OUTPUT_TOKENS = 128;
/** The constant, minimal, side-effect-free input string sent to the model. */
export const RESPONSES_STRUCTURE_PROBE_INPUT = "Reply exactly: OK";
/** The exact structural fields the probe preserves — the whole allowlisted output surface. */
export const RESPONSES_STRUCTURE_PROBE_PRESERVED_FIELDS = [
  "classification",
  "statusCode",
  "incompleteReason",
  "textOutputPresent",
  "outputElementTypes",
  "usage",
] as const;

const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_MAX_TIMEOUT_MS = 30_000;

// The single target this probe is allowed to reach. It is intentionally NOT a
// general-purpose provider tool: only the canonical VSLLM Responses route and
// model may be probed, so a foreign origin/model can never be sent even through
// a mocked fetch. A non-canonical target is refused before any secret or I/O.
const CANONICAL_PROVIDER_ID = "vsllm";
const CANONICAL_BASE_URL = "https://vsllm.cc/v1";
const CANONICAL_API_TYPE = "openai-responses";
const CANONICAL_MODEL_ID = "gpt-5.4-mini";

function isProbeTargetAllowed(profile: ProviderProfile, modelId: string): boolean {
  return (
    profile.id === CANONICAL_PROVIDER_ID &&
    profile.baseUrl.replace(/\/+$/, "") === CANONICAL_BASE_URL &&
    profile.apiType === CANONICAL_API_TYPE &&
    modelId === CANONICAL_MODEL_ID
  );
}

// An optional numeric bound is valid only as a positive safe integer at or below
// its ceiling; undefined means "use the default". A NaN/Infinity/zero/negative/
// fractional/over-ceiling value is rejected rather than silently ignored — a bug
// that previously let `maxResponseBytes: NaN` disable the read cap entirely.
function isValidBound(value: number | undefined, ceiling: number): boolean {
  return value === undefined || (Number.isInteger(value) && value > 0 && value <= ceiling);
}

/** A network-free description of the exact action the probe would perform. */
export interface ResponsesStructureProbePlan {
  readonly origin: string;
  readonly endpoint: typeof RESPONSES_STRUCTURE_PROBE_ENDPOINT;
  readonly modelId: string;
  readonly maxOutputTokens: number;
  readonly stream: false;
  readonly toolsIncluded: false;
  readonly autoRetry: false;
  readonly maxRequests: 1;
  /** Masked auth metadata (the kind, never the secret value) taken from the supplied profile. */
  readonly authKind: ProviderAuth["kind"];
  readonly redirect: "error";
  readonly preservedFields: readonly string[];
  readonly opensPilotGate: false;
  readonly network: "not-sent-in-dry-run";
}

export interface ResponsesStructureProbeSuccess {
  readonly ok: true;
  readonly requestCount: 1;
  readonly summary: ResponsesStructureSummary;
}

export interface ResponsesStructureProbeFailure {
  readonly ok: false;
  /** 0 when the request was refused before any network I/O; 1 once a single attempt was made. */
  readonly requestCount: 0 | 1;
  readonly errorType: NormalizedErrorType;
}

export type ResponsesStructureProbeOutcome =
  | ResponsesStructureProbeSuccess
  | ResponsesStructureProbeFailure;

export interface ResponsesStructureProbeOptions {
  readonly secretStore: SecretStore;
  readonly modelId: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxResponseBytes?: number;
  readonly maxTimeoutMs?: number;
}

function originOf(profile: ProviderProfile): string {
  const base = profile.baseUrl.endsWith("/") ? profile.baseUrl : `${profile.baseUrl}/`;
  return new URL(base).origin;
}

/**
 * Describe the single request the probe would send, for a separate human
 * decision. Reads no secret value and performs no network I/O: it inspects only
 * masked profile metadata (base-URL origin and the auth KIND, not the value).
 */
export function describeResponsesStructureProbe(
  profile: ProviderProfile,
  modelId: string,
): ResponsesStructureProbePlan | null {
  // No allowed-looking dry-run for a non-canonical target; a simple null refusal.
  if (!isProbeTargetAllowed(profile, modelId)) return null;
  return {
    origin: originOf(profile),
    endpoint: RESPONSES_STRUCTURE_PROBE_ENDPOINT,
    modelId,
    maxOutputTokens: RESPONSES_STRUCTURE_PROBE_MAX_OUTPUT_TOKENS,
    stream: false,
    toolsIncluded: false,
    autoRetry: false,
    maxRequests: 1,
    authKind: profile.auth.kind,
    redirect: "error",
    preservedFields: [...RESPONSES_STRUCTURE_PROBE_PRESERVED_FIELDS],
    opensPilotGate: false,
    network: "not-sent-in-dry-run",
  };
}

/**
 * Perform the single structural probe. Returns the allowlisted summary on
 * success, or a normalized error code on any failure. Never retries, never
 * follows a redirect, and never surfaces the response body/headers/secret.
 */
export async function runResponsesStructureProbe(
  profile: ProviderProfile,
  options: ResponsesStructureProbeOptions,
): Promise<ResponsesStructureProbeOutcome> {
  const fetchImpl = options.fetchImpl ?? fetch;

  // Validate the target, model, and optional bounds BEFORE building the request
  // or reading any secret. Any failure is a normalized INVALID_REQUEST with a
  // zero request count, and neither the secret store nor fetch is touched.
  if (!isProbeTargetAllowed(profile, options.modelId)) {
    return { ok: false, requestCount: 0, errorType: "INVALID_REQUEST" };
  }
  if (
    !isValidBound(options.maxResponseBytes, DEFAULT_MAX_RESPONSE_BYTES) ||
    !isValidBound(options.maxTimeoutMs, DEFAULT_MAX_TIMEOUT_MS)
  ) {
    return { ok: false, requestCount: 0, errorType: "INVALID_REQUEST" };
  }
  const maxBytes = options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  // Clamp to the ceiling and revalidate — this also closes an unparsed
  // profile.timeoutMs (e.g. NaN) that would otherwise reach AbortSignal.timeout.
  const timeoutMs = Math.min(profile.timeoutMs, options.maxTimeoutMs ?? DEFAULT_MAX_TIMEOUT_MS);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > DEFAULT_MAX_TIMEOUT_MS) {
    return { ok: false, requestCount: 0, errorType: "INVALID_REQUEST" };
  }
  const builder = new ProviderHttpRequestBuilder(options.secretStore);

  // Build the request (attaches only the profile's own API auth). Building sends
  // nothing; a build failure is refused before any request is counted.
  let built;
  try {
    built = await builder.build(profile, RESPONSES_STRUCTURE_PROBE_ENDPOINT, {
      accept: "application/json",
      contentType: "application/json",
    });
  } catch (error) {
    return { ok: false, requestCount: 0, errorType: errorTypeOf(error) };
  }

  // Confirm the resolved endpoint is still on the configured origin before any
  // network I/O — a defense in depth over the builder's own origin check.
  if (built.url.origin !== originOf(profile)) {
    return { ok: false, requestCount: 0, errorType: "INVALID_REQUEST" };
  }

  const requestBody = JSON.stringify({
    model: options.modelId,
    input: RESPONSES_STRUCTURE_PROBE_INPUT,
    max_output_tokens: RESPONSES_STRUCTURE_PROBE_MAX_OUTPUT_TOKENS,
    stream: false,
  });

  let response: Response;
  try {
    response = await fetchImpl(built.url, {
      method: "POST",
      headers: built.headers,
      body: requestBody,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Exactly one attempt was made; no retry. A refused redirect lands here too.
    return { ok: false, requestCount: 1, errorType: fetchErrorTypeOf(error) };
  }

  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, requestCount: 1, errorType: normalizeHttpStatus(response.status) };
  }

  let text: string;
  try {
    text = await readBoundedText(response, maxBytes);
  } catch {
    return { ok: false, requestCount: 1, errorType: "PROTOCOL_ERROR" };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch {
    return { ok: false, requestCount: 1, errorType: "PROTOCOL_ERROR" };
  }

  return { ok: true, requestCount: 1, summary: classifyResponsesStructure(payload) };
}

async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (body === null) {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > maxBytes) {
      throw new ProviderRequestError("PROTOCOL_ERROR", "Response exceeded the probe read limit.");
    }
    return text;
  }
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new ProviderRequestError("PROTOCOL_ERROR", "Response exceeded the probe read limit.");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

function errorTypeOf(error: unknown): NormalizedErrorType {
  return error instanceof ProviderRequestError ? error.type : "UNKNOWN";
}

function fetchErrorTypeOf(error: unknown): NormalizedErrorType {
  if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
    return "TIMEOUT";
  }
  return "NETWORK_ERROR";
}
