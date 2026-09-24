import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { join, win32 } from "node:path";
import { z } from "zod";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const protocol = z.enum(["openai-chat-completions", "openai-responses", "anthropic-messages"]);
const compilerCodes = [
  "PROTOCOL_UNRESOLVED", "INVALID_SELECTION", "INVALID_PROFILE", "INVALID_MODEL",
  "PROVIDER_DISABLED", "MODEL_DISABLED", "INVALID_URL", "ORIGIN_NOT_ALLOWED",
  "UNSUPPORTED_AUTH", "UNSUPPORTED_HEADERS", "UNSUPPORTED_QUERY",
  "UNSUPPORTED_MODEL_SELECTOR", "UNSUPPORTED_ENDPOINT",
];
const diagnostic = z.enum([...compilerCodes,
  "ACCOUNT_IDENTITY_REQUIRED", "ORIGIN_CONFIRMATION_REQUIRED", "MODEL_CAPABILITIES_UNVERIFIED",
  "CREDENTIAL_AVAILABILITY_UNVERIFIED", "LOCAL_PROFILE_SMOKE_REQUIRED", "REAL_PILOT_NOT_APPROVED",
  "MODEL_SELECTION_REQUIRED", "ENDPOINT_REVIEW_REQUIRED",
]);
const compiler = z.enum(["passed", ...compilerCodes]);
const header = z.string().max(256).regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/);
const safeUrl = z.string().max(2048).refine(value => {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password &&
      !url.search && !url.hash && !/[\s\\%?#]/.test(value) && !/\/\.{1,2}(?:\/|$)/.test(value) &&
      ["/", "/v1", "/api/v1", "/api/chat"].includes(url.pathname);
  } catch { return false; }
});
const row = z.object({
  providerId: z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*$/),
  profileSha256: hash,
  status: z.literal("pending"),
  declared: z.object({
    baseUrl: safeUrl.nullable(),
    apiType: z.enum(["auto", "custom", ...protocol.options]),
    authKind: z.enum(["none", "bearer", "header", "query"]),
    authHeaderName: header.optional(),
    staticHeaderNames: z.array(header).max(256),
    secretHeaderNames: z.array(header).max(256),
    queryParameterNames: z.array(z.string().max(256).regex(/^[A-Za-z][A-Za-z0-9_.-]*$/)).max(256),
  }).strict(),
  accountId: z.null(), approvedOrigins: z.array(z.never()).max(0),
  portalAssociation: z.literal("unknown-not-inferred"),
  configuredModels: z.array(z.object({
    id: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/),
    sources: z.array(z.enum(["manual", "pricing"])).min(1).max(2),
    disabled: z.boolean(), compiler,
  }).strict()).max(6000),
  transportTrials: z.array(z.object({ protocol, compiler }).strict()).max(3),
  unresolved: z.array(diagnostic).max(64),
  featurePolicy: z.literal("no-feature-downgrade; responses-namespace-not-chat-compatible"),
}).strict();
const count = z.number().int().nonnegative().safe();
const schema = z.object({
  version: z.literal(1), purpose: z.literal("offline-assessment-not-launch-authorization"),
  compilerSourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  counts: z.object({ total: count, enabled: count, expected: count.nullable(), drift: z.boolean() }).strict(),
  providers: z.array(row).max(1000),
}).strict();

/** Strip unconsumed root metadata; never serialize input/parser exceptions. */
export function parseSmokeInventory(text) {
  try {
    if (typeof text !== "string" || text.length > 32 * 1024 * 1024) throw new Error();
    const assessment = schema.parse(JSON.parse(text).assessment);
    const counts = assessment.counts;
    if (assessment.providers.length !== counts.total || counts.enabled > counts.total ||
        new Set(assessment.providers.map(p => p.providerId)).size !== counts.total ||
        counts.drift !== (counts.expected !== null && counts.expected !== counts.total)) throw new Error();
    return assessment;
  } catch { throw new Error("INVALID_SMOKE_INVENTORY"); }
}

export function assertFDriveOutput(path) {
  if (typeof path !== "string" || !win32.isAbsolute(path) ||
      win32.parse(win32.normalize(path)).root.toLowerCase() !== "f:\\" ||
      win32.resolve(path).toLowerCase() === "f:\\" ||
      /[\x00-\x1f]/.test(path) || path.split(/[\\/]/).some(part => part === "." || part === "..")) {
    throw new Error("UNSAFE_SMOKE_OUTPUT_ROOT");
  }
}

export function hasReadToolResult(body, selectedProtocol) {
  if (selectedProtocol === "openai-responses") {
    return Array.isArray(body?.input) && body.input.some(item =>
      item?.type === "function_call_output" &&
      item.call_id === "call-local-fixture" &&
      typeof item.output === "string" &&
      item.output.includes("OMP_MAPPING_READ_RESULT"));
  }
  if (selectedProtocol !== "openai-chat-completions") return false;
  return Array.isArray(body?.messages) && body.messages.some(message => {
    if (message.role !== "tool" || message.tool_call_id !== "call-local-fixture") return false;
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content
        .filter(part => part?.type === "text" && typeof part.text === "string").map(part => part.text).join("\n") : "";
    return text.includes("OMP_MAPPING_READ_RESULT");
  });
}

/** Validate the request sent to the selected wire protocol, including the
 * second request's structured tool result. Model and auth are checked by the
 * fixture server separately. */
export function hasExpectedRequestShape(body, selectedProtocol, useTool, continuation) {
  if (body === null || typeof body !== "object" || Array.isArray(body) ||
      body.stream !== true || Boolean(body.tools?.length) !== useTool ||
      (body.tools !== undefined && !Array.isArray(body.tools))) return false;
  if (useTool && (body.tools.length !== 1 || body.tools[0]?.type !== "function")) return false;
  if (selectedProtocol === "openai-responses") {
    if ("messages" in body || !(typeof body.input === "string" && body.input.length > 0 ||
        Array.isArray(body.input) && body.input.length > 0)) return false;
    if (useTool && (body.tools[0]?.name !== "read" || "function" in body.tools[0])) return false;
    if (!continuation) {
      if (body.previous_response_id !== undefined) return false;
      return !Array.isArray(body.input) || body.input.every(item =>
        item?.type !== "function_call" && item?.type !== "function_call_output");
    }
    if (!hasReadToolResult(body, selectedProtocol)) return false;
    const outputIndex = body.input.findIndex(item => item?.type === "function_call_output" &&
      item.call_id === "call-local-fixture" && typeof item.output === "string" &&
      item.output.includes("OMP_MAPPING_READ_RESULT"));
    const hasPriorCall = body.input.slice(0, outputIndex).some(item =>
      item?.type === "function_call" && item.call_id === "call-local-fixture" && item.name === "read");
    return hasPriorCall || body.previous_response_id === "resp-local-fixture";
  }
  if (selectedProtocol === "openai-chat-completions") {
    if ("input" in body || !Array.isArray(body.messages) || body.messages.length === 0) return false;
    if (useTool && (body.tools[0]?.function?.name !== "read" || "name" in body.tools[0])) return false;
    return !continuation || hasReadToolResult(body, selectedProtocol);
  }
  return false;
}

/** Scan all harness-owned artifacts, not only the per-run managed home. */
export async function containsKey(directory, needle) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("UNSAFE_SMOKE_ARTIFACT");
    const path = join(directory, entry.name);
    if (entry.isDirectory()) { if (await containsKey(path, needle)) return true; continue; }
    if (!entry.isFile()) throw new Error("UNSAFE_SMOKE_ARTIFACT");
    let tail = Buffer.alloc(0);
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.concat([tail, chunk]);
      if (bytes.includes(needle)) return true;
      tail = bytes.subarray(Math.max(0, bytes.length - needle.length + 1));
    }
  }
  return false;
}
