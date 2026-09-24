import { createHash } from "node:crypto";
import {
  compileOmpConfig,
  OmpConfigError,
  ompConfigSchemaCommit,
  type OmpConfigErrorCode,
  type OmpProtocol,
} from "../clients/omp/omp-config-compiler.js";
import { providerProfileSchema, type ProviderProfile } from "../core/providers/provider-profile.js";
import { MigrationSafetyError } from "./migration-manifest.js";

type CompilerResult = "passed" | OmpConfigErrorCode;

export interface OmpProviderMappingAssessment {
  readonly providerId: string;
  readonly profileSha256: string;
  readonly status: "pending";
  readonly declared: {
    readonly baseUrl: string | null;
    readonly apiType: ProviderProfile["apiType"];
    readonly authKind: ProviderProfile["auth"]["kind"];
    readonly authHeaderName?: string;
    readonly staticHeaderNames: readonly string[];
    readonly secretHeaderNames: readonly string[];
    readonly queryParameterNames: readonly string[];
  };
  readonly accountId: null;
  readonly approvedOrigins: readonly string[];
  readonly portalAssociation: "unknown-not-inferred";
  readonly configuredModels: readonly {
    readonly id: string;
    readonly sources: readonly ("manual" | "pricing")[];
    readonly disabled: boolean;
    readonly compiler: CompilerResult;
  }[];
  readonly transportTrials: readonly { readonly protocol: OmpProtocol; readonly compiler: CompilerResult }[];
  readonly unresolved: readonly string[];
  readonly featurePolicy: "no-feature-downgrade; responses-namespace-not-chat-compatible";
}

export interface OmpProviderMappingReport {
  readonly version: 1;
  readonly purpose: "offline-assessment-not-launch-authorization";
  readonly compilerSourceCommit: string;
  readonly counts: {
    readonly total: number;
    readonly enabled: number;
    readonly expected: number | null;
    readonly drift: boolean;
  };
  readonly providers: readonly OmpProviderMappingAssessment[];
}

/** Stable fingerprint used by assessment evidence and accepted-route decisions. */
export function fingerprintOmpProviderProfile(profileEvidence: object): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(profileEvidence)))
    .digest("hex");
}

/**
 * No credentials, discovery, account inference, approval, or launch capability.
 * A passing compiler trial describes representability, not remote compatibility.
 */
export function assessOmpProviderMappings(
  profiles: unknown,
  options: { readonly expectedProviderCount?: number } = {},
): OmpProviderMappingReport {
  const expected = options.expectedProviderCount ?? null;
  if (expected !== null && (!Number.isSafeInteger(expected) || expected < 0)) {
    throw new MigrationSafetyError("INVALID_EXPECTED_PROVIDER_COUNT");
  }
  if (!Array.isArray(profiles)) throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
  const seen = new Set<string>();
  const parsed = profiles.map((raw: unknown) => {
    // In particular do not let the schema's defaults turn absent auth into
    // keyless, or absent apiType into auto. Evidence must actually contain them.
    if (raw === null || typeof raw !== "object") {
      throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
    }
    const evidence = raw as Record<string, unknown>;
    if (criticalFields.some((key) => !Object.hasOwn(evidence, key) || evidence[key] === undefined)) {
      throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
    }
    const result = providerProfileSchema.safeParse(raw);
    if (!result.success) throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
    if (criticalFields.some((field) =>
      JSON.stringify(canonical(evidence[field])) !== JSON.stringify(canonical(result.data[field])))) {
      throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
    }
    const profile = result.data;
    const headerNames = [
      ...Object.keys(profile.staticHeaders), ...Object.keys(profile.secretHeaders),
      ...(profile.auth.kind === "header" ? [profile.auth.headerName] : []),
    ];
    const queryNames = [
      ...Object.keys(profile.queryParameters),
      ...(profile.auth.kind === "query" ? [profile.auth.parameterName] : []),
    ];
    // A generic schema string is not a safe diagnostic identifier. In
    // particular never echo a complete header line or query assignment.
    if (headerNames.some((name) => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) ||
        queryNames.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]*$/.test(name))) {
      throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
    }
    if (seen.has(result.data.id)) throw new MigrationSafetyError("DUPLICATE_PROVIDER_ID");
    seen.add(result.data.id);
    return { profile: result.data, raw };
  });
  return {
    version: 1,
    purpose: "offline-assessment-not-launch-authorization",
    compilerSourceCommit: ompConfigSchemaCommit,
    counts: {
      total: parsed.length, enabled: parsed.filter(({ profile }) => profile.enabled).length,
      expected, drift: expected !== null && expected !== parsed.length,
    },
    providers: parsed.map(({ profile, raw }) => assessProfile(profile, raw)),
  };
}

const criticalFields = [
  "id", "baseUrl", "apiType", "auth", "enabled", "staticHeaders", "secretHeaders",
  "queryParameters", "manualModelIds", "disabledModelIds", "modelPricing",
] as const;

const protocols: readonly OmpProtocol[] = [
  "openai-chat-completions", "openai-responses", "anthropic-messages",
];

function assessProfile(profile: ProviderProfile, raw: object): OmpProviderMappingAssessment {
  const modelSources = new Map<string, ("manual" | "pricing")[]>();
  for (const id of profile.manualModelIds) {
    if (!modelSources.has(id)) modelSources.set(id, ["manual"]);
  }
  for (const id of Object.keys(profile.modelPricing)) {
    modelSources.set(id, [...(modelSources.get(id) ?? []), "pricing"]);
  }
  const disabled = new Set(profile.disabledModelIds.map((id) => id.toLowerCase()));
  const configuredModels = [...modelSources].map(([id, sources]) => ({
    id, sources, disabled: disabled.has(id.toLowerCase()), compiler: trial(profile, id),
  }));
  const candidates = protocols.filter((protocol) => profile.apiType === "auto" || profile.apiType === protocol);
  // These are counterfactual shape trials, NOT mappings. Even for auto, no
  // protocol is selected and no compiled route/secret requirement is returned.
  // Provider/model availability is tested above, separately from transport.
  const transportTrials = candidates.map((protocol) => ({
    protocol, compiler: trial({
      ...profile, apiType: protocol, enabled: true, disabledModelIds: [],
    }, "offline-shape-trial"),
  }));
  const unresolved = new Set([
    "ACCOUNT_IDENTITY_REQUIRED", "ORIGIN_CONFIRMATION_REQUIRED", "MODEL_CAPABILITIES_UNVERIFIED",
    "CREDENTIAL_AVAILABILITY_UNVERIFIED", "LOCAL_PROFILE_SMOKE_REQUIRED", "REAL_PILOT_NOT_APPROVED",
  ]);
  const baseUrl = safeBaseUrl(profile.baseUrl);
  if (baseUrl === null) unresolved.add("ENDPOINT_REVIEW_REQUIRED");
  if (!modelSources.size) unresolved.add("MODEL_SELECTION_REQUIRED");
  if (!profile.enabled) unresolved.add("PROVIDER_DISABLED");
  if (profile.apiType === "auto" || !candidates.length) unresolved.add("PROTOCOL_UNRESOLVED");
  for (const { compiler } of [...configuredModels, ...transportTrials]) {
    if (compiler !== "passed") unresolved.add(compiler);
  }
  return {
    providerId: profile.id,
    profileSha256: fingerprintOmpProviderProfile(raw),
    status: "pending",
    declared: {
      baseUrl,
      apiType: profile.apiType,
      authKind: profile.auth.kind,
      ...(profile.auth.kind === "header" ? { authHeaderName: profile.auth.headerName } : {}),
      staticHeaderNames: Object.keys(profile.staticHeaders).sort(),
      secretHeaderNames: Object.keys(profile.secretHeaders).sort(),
      queryParameterNames: Object.keys(profile.queryParameters).sort(),
    },
    accountId: null,
    approvedOrigins: [],
    portalAssociation: "unknown-not-inferred",
    configuredModels,
    transportTrials,
    unresolved: [...unresolved],
    featurePolicy: "no-feature-downgrade; responses-namespace-not-chat-compatible",
  };
}

function trial(profile: ProviderProfile, modelId: string): CompilerResult {
  try {
    compileOmpConfig({ routes: [{
      profile, accountId: "offline-shape-trial-not-an-account",
      // Synthetic input to a PURE compiler only. This is not an approval, is
      // never passed to runtime, and must never become the report's allowlist.
      allowedOrigins: [new URL(profile.baseUrl).origin],
      models: [{ id: modelId }],
    }] });
    return "passed";
  } catch (error) {
    if (error instanceof OmpConfigError) return error.code;
    // Never surface parser errors or profile values.
    throw new MigrationSafetyError("INVALID_PROVIDER_EVIDENCE");
  }
}

function safeBaseUrl(value: string): string | null {
  const url = new URL(value);
  // Unreviewed paths can themselves carry credentials. Only publish known
  // non-secret base-path shapes; withhold other URLs, never rewrite them. The
  // original bytes remain in the read-only source and its profile fingerprint.
  const reportablePaths = new Set(["/", "/v1", "/api/v1", "/api/chat"]);
  return url.username || url.password || url.search || url.hash ||
    /[\s\x00-\x1f\x7f%\\?#]/.test(value) || /\/\.{1,2}(?:\/|$)/.test(value) ||
    !reportablePaths.has(url.pathname) ? null : value;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, canonical(item)]));
  }
  return value;
}
