import { createHash } from "node:crypto";
import { z } from "zod";
import { providerProfileSchema, type ProviderProfile } from "../../core/providers/provider-profile.js";

/**
 * Verified against models-config-schema-bundle.ts / models-config.ts,
 * model-config-values.ts, openai-shared.ts and anthropic.ts at this pin.
 * This is a bounded models.yml compiler, not OMP settings/discovery policy.
 */
export const ompConfigSchemaCommit = "0c6c981ee5838d97700180383077eb0a3790637c";
export type OmpApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export type OmpProtocol = "openai-chat-completions" | "openai-responses" | "anthropic-messages";

export interface OmpModelInput {
  /** Literal upstream ID. Unicode/colons are preserved; no glob/comma scope syntax. */
  readonly id: string;
  readonly name?: string;
  readonly reasoning?: boolean;
  readonly supportsTools?: boolean;
  readonly input?: readonly ("text" | "image")[];
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

export interface OmpSelectedRoute {
  readonly profile: ProviderProfile;
  /** Non-secret identity (1–256 chars, no controls/separators or "."/".."); never a key. */
  readonly accountId: string;
  /** Independently approved exact origins; do not derive this allowlist from an untrusted URL. */
  readonly allowedOrigins: readonly string[];
  /** Only models explicitly selected for this launch, not the whole catalog. */
  readonly models: readonly OmpModelInput[];
}

/** A caller-confirmed mapping, not an unverified catalog/name heuristic. */
export interface OmpProtocolMapping {
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly origin: string;
  readonly apiType: OmpProtocol;
}

export interface OmpCompileInput {
  readonly routes: readonly OmpSelectedRoute[];
  readonly protocolMappings?: readonly OmpProtocolMapping[];
}

export type OmpConfigErrorCode =
  | "PROTOCOL_UNRESOLVED" | "INVALID_SELECTION" | "INVALID_PROFILE" | "INVALID_MODEL"
  | "PROVIDER_DISABLED" | "MODEL_DISABLED" | "INVALID_URL" | "ORIGIN_NOT_ALLOWED"
  | "UNSUPPORTED_AUTH" | "UNSUPPORTED_HEADERS" | "UNSUPPORTED_QUERY" | "UNSUPPORTED_MODEL_SELECTOR"
  | "UNSUPPORTED_ENDPOINT";

export class OmpConfigError extends Error {
  constructor(readonly code: OmpConfigErrorCode) {
    // Intentionally no user input, validation issues, or nested cause in diagnostics.
    super(`OMP configuration rejected: ${code}.`);
    this.name = "OmpConfigError";
  }
}

export interface OmpSecretRequirement {
  readonly secretRef: string;
  readonly envName: string;
}

export interface OmpProviderIdentity {
  readonly providerId: string;
  readonly accountId: string;
  readonly ompProviderId: string;
}

export interface OmpModelSelection extends OmpProviderIdentity {
  readonly modelId: string;
  readonly api: OmpApi;
  readonly selector: string;
}

export interface OmpProviderConfig {
  readonly baseUrl: string;
  readonly api?: OmpApi;
  readonly auth: "apiKey" | "none";
  readonly apiKey?: string;
  readonly authHeader?: boolean;
  readonly headers?: Readonly<Record<string, string>>;
  readonly models: readonly (OmpModelInput & { readonly api?: OmpApi })[];
}

export interface CompiledOmpConfig {
  readonly modelsConfig: { readonly providers: Readonly<Record<string, OmpProviderConfig>> };
  /** JSON is valid YAML. This string contains names of env vars, never values. */
  readonly modelsYaml: string;
  readonly providerIds: readonly OmpProviderIdentity[];
  readonly requiredSecrets: readonly OmpSecretRequirement[];
  /** Same route/model order as the request. Runtime chooses a primary explicitly. */
  readonly selections: readonly OmpModelSelection[];
}

const apiMapping: Record<OmpProtocol, OmpApi> = {
  "openai-chat-completions": "openai-completions",
  "openai-responses": "openai-responses",
  "anthropic-messages": "anthropic-messages",
};

const modelSchema = z.object({
  id: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/),
  name: z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
  reasoning: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  input: z.array(z.enum(["text", "image"])).min(1).max(2).optional(),
  contextWindow: z.number().int().positive().safe().optional(),
  maxTokens: z.number().int().positive().safe().optional(),
}).strict();

function fingerprint(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function validateBaseUrl(raw: string, allowedOrigins: readonly string[]): string {
  let url: URL;
  try {
    if (typeof raw !== "string" || /[\s\\%?#]/.test(raw)) throw new Error();
    url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "");
    if (
      url.username || url.password || !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      /\/(?:chat\/completions|responses|messages|models)$/i.test(path) ||
      /\/v1\/v1(?:\/|$)/i.test(path) || /\/\.{1,2}(?:\/|$)/.test(raw)
    ) throw new Error();
  } catch {
    throw new OmpConfigError("INVALID_URL");
  }
  const origins = new Set<string>();
  try {
    for (const value of allowedOrigins) {
      const approved = new URL(value);
      if (value !== approved.origin && value !== `${approved.origin}/`) throw new Error();
      origins.add(approved.origin);
    }
  } catch {
    throw new OmpConfigError("ORIGIN_NOT_ALLOWED");
  }
  if (!origins.has(url.origin)) throw new OmpConfigError("ORIGIN_NOT_ALLOWED");
  return url.href.replace(/\/+$/, "");
}

function validateRoute(route: OmpSelectedRoute): OmpSelectedRoute {
  const baseUrl = validateBaseUrl(route.profile.baseUrl, route.allowedOrigins);
  const parsed = providerProfileSchema.safeParse({ ...route.profile, baseUrl });
  if (!parsed.success) throw new OmpConfigError("INVALID_PROFILE");
  const profile = parsed.data;
  if (!profile.enabled) throw new OmpConfigError("PROVIDER_DISABLED");
  if (
    typeof route.accountId !== "string" || !route.accountId.trim() ||
    route.accountId.length > 256 || /[\x00-\x1f\x7f\\/]/.test(route.accountId) ||
    route.accountId === "." || route.accountId === ".." ||
    !Array.isArray(route.models) || !route.models.length
  ) throw new OmpConfigError("INVALID_SELECTION");
  const ids = new Set<string>();
  const disabledIds = new Set(profile.disabledModelIds.map((id) => id.toLowerCase()));
  const models = route.models.map((model) => {
    const parsedModel = modelSchema.safeParse(model);
    if (!parsedModel.success) throw new OmpConfigError("INVALID_MODEL");
    // Exact provider/id lookup wins over colon suffixes in the pinned resolver.
    // --models/role scopes, however, split commas and interpret these glob chars
    // before exact lookup. Reject that ambiguity, not harmless Unicode/punctuation.
    if (model.id.trim() !== model.id || /[*?,\[]/.test(model.id)) {
      throw new OmpConfigError("UNSUPPORTED_MODEL_SELECTOR");
    }
    // OMP deduplicates/resolves selectors case-insensitively at this pin.
    if (ids.has(model.id.toLowerCase())) throw new OmpConfigError("INVALID_SELECTION");
    if (disabledIds.has(model.id.toLowerCase())) throw new OmpConfigError("MODEL_DISABLED");
    ids.add(model.id.toLowerCase());
    // Construct only supported fields. No caller-owned records reach the config.
    const data = parsedModel.data;
    return {
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.reasoning !== undefined ? { reasoning: data.reasoning } : {}),
      ...(data.supportsTools !== undefined ? { supportsTools: data.supportsTools } : {}),
      ...(data.input !== undefined ? { input: data.input } : {}),
      ...(data.contextWindow !== undefined ? { contextWindow: data.contextWindow } : {}),
      ...(data.maxTokens !== undefined ? { maxTokens: data.maxTokens } : {}),
    };
  });
  return { ...route, profile, models };
}

function resolveApi(route: OmpSelectedRoute, modelId: string, mappings: readonly OmpProtocolMapping[]): OmpApi {
  let protocol = route.profile.apiType;
  if (protocol === "auto") {
    const matches = new Set(mappings.filter((mapping) =>
      mapping.providerId === route.profile.id && mapping.accountId === route.accountId &&
      mapping.modelId === modelId && mapping.origin === new URL(route.profile.baseUrl).origin,
    ).map((mapping) => mapping.apiType));
    if (matches.size !== 1) throw new OmpConfigError("PROTOCOL_UNRESOLVED");
    protocol = [...matches][0]!;
  }
  if (!Object.hasOwn(apiMapping, protocol)) throw new OmpConfigError("PROTOCOL_UNRESOLVED");
  return apiMapping[protocol as OmpProtocol];
}

type CompiledAuth = Pick<OmpProviderConfig, "auth" | "apiKey" | "authHeader" | "headers">;

/**
 * Pin-specific wire policy:
 * - OpenAI respects N/A (auth:none) for genuinely keyless routes.
 * - Messages on third-party origins unconditionally defaults to bearer.
 * - Messages on the official origin always adds X-Api-Key.
 * - Raw config headers undergo two resolver passes; none are emitted here.
 * Never "approximate" header-only auth by transmitting the key in two headers.
 */
function compileAuth(profile: ProviderProfile, apis: readonly OmpApi[], envName?: string): CompiledAuth {
  // No arbitrary resolver-capable header strings or URL query interpolation in this slice.
  if (Object.keys(profile.staticHeaders).length || Object.keys(profile.secretHeaders).length) {
    throw new OmpConfigError("UNSUPPORTED_HEADERS");
  }
  if (Object.keys(profile.queryParameters).length || profile.auth.kind === "query") {
    throw new OmpConfigError("UNSUPPORTED_QUERY");
  }
  const messages = apis.includes("anthropic-messages");
  const officialAnthropic = new URL(profile.baseUrl).origin === "https://api.anthropic.com";
  const auth = profile.auth;
  if (auth.kind === "none") {
    if (messages) throw new OmpConfigError("UNSUPPORTED_AUTH");
    return { auth: "none" };
  }
  if (auth.kind === "bearer") {
    if (messages && officialAnthropic) throw new OmpConfigError("UNSUPPORTED_AUTH");
    return { auth: "apiKey", apiKey: envName!, authHeader: true };
  }
  const header = auth.headerName.toLowerCase();
  // Native Anthropic API-key auth does not put plaintext into the config header
  // resolver. Its X-Api-Key header is also covered by the HTTP inspector redactor.
  if (messages && officialAnthropic && header === "x-api-key" &&
    apis.every((api) => api === "anthropic-messages")) {
    return { auth: "apiKey", apiKey: envName!, authHeader: false };
  }
  // model-registry resolves provider headers before createLiveConfigHeaders
  // resolves their plaintext again. A key starting with "!" becomes a command,
  // and a key matching ANY final child-env name becomes another value. Reject
  // this transport entirely: a denylist cannot cover future runtime env names.
  // Arbitrary custom headers additionally escape OMP's HTTP 400/413 redaction.
  throw new OmpConfigError("UNSUPPORTED_AUTH");
}

/** Pure compiler: no discovery, files, process environment, or secret resolution. */
export function compileOmpConfig(input: OmpCompileInput): CompiledOmpConfig {
  if (!Array.isArray(input.routes) || !input.routes.length) throw new OmpConfigError("INVALID_SELECTION");
  const providers: Record<string, OmpProviderConfig> = {};
  const providerIds: OmpProviderIdentity[] = [];
  const requiredSecrets: OmpSecretRequirement[] = [];
  const selections: OmpModelSelection[] = [];
  for (const selected of input.routes) {
    const route = validateRoute(selected);
    const profile = route.profile;
    const ompProviderId = `dock-${profile.id}-${fingerprint([profile.id, route.accountId, profile.baseUrl, profile.auth])}`;
    if (Object.hasOwn(providers, ompProviderId)) throw new OmpConfigError("INVALID_SELECTION");
    const identity = { providerId: profile.id, accountId: route.accountId, ompProviderId };
    const apis = route.models.map((model) => resolveApi(route, model.id, input.protocolMappings ?? []));
    // The pinned Chat provider always supplies Azure options; openai-shared.ts
    // rewrites this substring ANYWHERE in baseUrl, even with our custom ID.
    // Deployment and api-version policy are not part of this bounded compiler.
    if (apis.includes("openai-completions") && profile.baseUrl.includes(".openai.azure.com")) {
      throw new OmpConfigError("UNSUPPORTED_ENDPOINT");
    }
    const providerApi = new Set(apis).size === 1 ? apis[0] : undefined;
    const auth = profile.auth;
    const envName = auth.kind === "none" ? undefined
      : `PROVIDERDOCK_OMP_${fingerprint([ompProviderId, auth.secretRef]).toUpperCase()}`;
    providers[ompProviderId] = {
      baseUrl: profile.baseUrl, ...(providerApi ? { api: providerApi } : {}),
      ...compileAuth(profile, apis, envName),
      models: route.models.map((model, index) => ({ ...model, ...(!providerApi ? { api: apis[index]! } : {}) })),
    };
    providerIds.push(identity);
    if (envName && auth.kind !== "none") requiredSecrets.push({ secretRef: auth.secretRef, envName });
    for (const [index, model] of route.models.entries()) {
      const api = apis[index]!;
      selections.push({ ...identity, modelId: model.id, api, selector: `${ompProviderId}/${model.id}` });
    }
  }
  const modelsConfig = { providers: Object.fromEntries(Object.keys(providers).sort().map((id) => [id, providers[id]!])) };
  return { modelsConfig, modelsYaml: `${JSON.stringify(modelsConfig, null, 2)}\n`, providerIds, requiredSecrets, selections };
}
