import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import {
  compileOmpConfig,
  type OmpProtocol,
  type OmpProtocolMapping,
  type OmpSelectedRoute,
} from "../clients/omp/omp-config-compiler.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import {
  providerConfigurationFingerprint,
  type ModelCapabilitySnapshot,
} from "../core/health/provider-health-repository.js";
import {
  fingerprintOmpProviderProfile,
} from "./omp-provider-mapping.js";
import {
  parseOmpProviderLocalSmokeEvidence,
  type OmpProviderLocalSmokeEvidence,
} from "./omp-provider-evidence.js";

export { fingerprintOmpProviderProfile };

export interface OmpRouteDecision {
  readonly providerId: string;
  readonly profileSha256: string;
  readonly accountId: string;
  readonly baseUrl: string;
  readonly origin: string;
  readonly modelId: string;
  readonly protocol: OmpProtocol;
  readonly capabilities: {
    readonly text: "supported";
    readonly streaming: "supported";
    readonly tools: "supported";
  };
  readonly realPilot: {
    readonly status: "passed";
    readonly doctorLevel: 3;
    readonly protocol: OmpProtocol;
    readonly checkedAt: string;
    readonly doctorSnapshotSha256: string;
  };
  readonly status: "accepted-for-pilot";
  readonly localSmoke: {
    readonly status: "passed";
    readonly inventorySha256: string;
    readonly smokeReportSha256: string;
    readonly executableSha256: string;
    readonly sourceCommit: string;
  };
}

export interface OmpRouteDecisionDocument {
  readonly version: 2;
  readonly decisions: readonly OmpRouteDecision[];
}

export interface OmpRouteDecisionSource {
  list(): Promise<readonly OmpRouteDecision[]>;
  get(
    providerId: string,
    accountId: string,
    modelId: string,
  ): Promise<OmpRouteDecision | undefined>;
}

export interface EvaluateOmpRouteDecisionForPilotInput {
  readonly profile: ProviderProfile;
  readonly decision: unknown;
  readonly evidence: OmpProviderLocalSmokeEvidence | undefined;
  readonly doctorSnapshot: ModelCapabilitySnapshot | undefined;
  readonly currentCredentialFingerprint?: string | undefined;
  readonly selection: {
    readonly providerId: string;
    readonly accountId: string;
    readonly modelId: string;
  };
  readonly artifact: {
    readonly sha256: string;
    readonly sourceCommit: string;
  };
}

export type EvaluateOmpRouteDecisionForPilotResult =
  | {
    readonly accepted: true;
    readonly route: OmpSelectedRoute;
    readonly protocolMappings: readonly OmpProtocolMapping[];
  }
  | { readonly accepted: false };

export class OmpRouteDecisionError extends Error {
  constructor(readonly code = "INVALID_OMP_ROUTE_DECISIONS") {
    super(code);
    this.name = "OmpRouteDecisionError";
  }
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const providerIdSchema = z.string()
  .min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const accountIdSchema = z.string()
  .min(1).max(256)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/)
  .refine((value) => value !== "." && value !== "..");
const modelIdSchema = z.string()
  .min(1).max(256)
  .regex(/^[^\x00-\x1f\x7f-\x9f]+$/)
  .refine((value) => value.trim() === value && !/[*?,\[]/.test(value));
const protocolSchema = z.enum([
  "openai-chat-completions",
  "openai-responses",
  "anthropic-messages",
]);

const localSmokeSchema = z.object({
  status: z.literal("passed"),
  inventorySha256: sha256Schema,
  smokeReportSha256: sha256Schema,
  executableSha256: sha256Schema,
  sourceCommit: sourceCommitSchema,
}).strict();

const requiredCapabilitiesSchema = z.object({
  text: z.literal("supported"),
  streaming: z.literal("supported"),
  tools: z.literal("supported"),
}).strict();

const realPilotSchema = z.object({
  status: z.literal("passed"),
  doctorLevel: z.literal(3),
  protocol: protocolSchema,
  checkedAt: z.string().datetime(),
  doctorSnapshotSha256: sha256Schema,
}).strict();

const routeDecisionSchema = z.object({
  providerId: providerIdSchema,
  profileSha256: sha256Schema,
  accountId: accountIdSchema,
  baseUrl: z.string().min(1).max(2_048),
  origin: z.string().min(1).max(2_048),
  modelId: modelIdSchema,
  protocol: protocolSchema,
  capabilities: requiredCapabilitiesSchema,
  realPilot: realPilotSchema,
  status: z.literal("accepted-for-pilot"),
  localSmoke: localSmokeSchema,
}).strict().superRefine((decision, context) => {
  const baseUrl = safeAcceptedBaseUrl(decision.baseUrl);
  if (baseUrl === undefined || decision.origin !== baseUrl.origin ||
      decision.realPilot.protocol !== decision.protocol) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Invalid accepted endpoint.",
    });
  }
});

const routeDecisionDocumentSchema = z.object({
  version: z.literal(2),
  decisions: z.array(routeDecisionSchema).max(10_000),
}).strict();

/**
 * Strictly validates an explicit, non-secret acceptance document. It does not
 * create decisions from provider metadata or infer account/origin/protocol.
 */
export function parseOmpRouteDecisionDocument(
  input: unknown,
): OmpRouteDecisionDocument {
  try {
    if (input !== null && typeof input === "object" && !Array.isArray(input) &&
        "version" in input && input.version === 1) {
      throw new OmpRouteDecisionError("LEGACY_OMP_ROUTE_DECISIONS");
    }
    const parsed = routeDecisionDocumentSchema.parse(input);
    const keys = new Set<string>();
    for (const decision of parsed.decisions) {
      const key = routeKey(
        decision.providerId,
        decision.accountId,
        decision.modelId,
      );
      if (keys.has(key)) throw new Error();
      keys.add(key);
    }
    return parsed;
  } catch (error) {
    if (error instanceof OmpRouteDecisionError) throw error;
    throw new OmpRouteDecisionError();
  }
}

/**
 * Pure, non-secret dry-run gate shared by assessment tooling and the public
 * launch seam. It never resolves credentials, writes files, or contacts an
 * upstream. Every malformed, stale, mismatched, or unrepresentable route is
 * intentionally collapsed to the same fail-closed result.
 */
export function evaluateOmpRouteDecisionForPilot(
  input: EvaluateOmpRouteDecisionForPilotInput,
): EvaluateOmpRouteDecisionForPilotResult {
  try {
    const decision = parseOmpRouteDecisionDocument({
      version: 2,
      decisions: [input.decision],
    }).decisions[0]!;
    const evidence = input.evidence === undefined
      ? undefined
      : parseOmpProviderLocalSmokeEvidence(input.evidence);
    if (evidence === undefined || !matchesLocalSmokeEvidence(decision, evidence)) {
      return { accepted: false };
    }

    const profile = input.profile;
    const doctor = input.doctorSnapshot;
    if (doctor === undefined ||
        doctor.providerId !== decision.providerId ||
        doctor.modelId !== decision.modelId ||
        doctor.protocol !== decision.protocol ||
        doctor.doctorLevel !== 3 ||
        doctor.verdict !== "PASS" ||
        doctor.checkedAt !== decision.realPilot.checkedAt ||
        doctor.configurationFingerprint !== providerConfigurationFingerprint(profile) ||
        doctor.credentialFingerprint === undefined ||
        doctor.credentialFingerprint !== input.currentCredentialFingerprint ||
        doctor.capabilities.text !== "SUPPORTED" ||
        doctor.capabilities.streaming !== "SUPPORTED" ||
        doctor.capabilities.tools !== "SUPPORTED" ||
        fingerprintOmpDoctorSnapshot(doctor) !== decision.realPilot.doctorSnapshotSha256) {
      return { accepted: false };
    }
    const knownModels = [...profile.manualModelIds, ...Object.keys(profile.modelPricing)];
    const origin = new URL(profile.baseUrl).origin;
    if (
      decision.providerId !== input.selection.providerId ||
      decision.accountId !== input.selection.accountId ||
      decision.modelId !== input.selection.modelId ||
      decision.profileSha256 !== fingerprintOmpProviderProfile(profile) ||
      decision.baseUrl !== profile.baseUrl ||
      decision.origin !== origin ||
      !knownModels.includes(decision.modelId) ||
      profile.disabledModelIds.some((id) =>
        id.toLowerCase() === decision.modelId.toLowerCase()) ||
      (profile.apiType !== "auto" && profile.apiType !== decision.protocol) ||
      decision.localSmoke.executableSha256 !== input.artifact.sha256 ||
      decision.localSmoke.sourceCommit !== input.artifact.sourceCommit
    ) return { accepted: false };

    const route: OmpSelectedRoute = {
      profile,
      accountId: decision.accountId,
      allowedOrigins: [decision.origin],
      models: [{ id: decision.modelId }],
    };
    const protocolMappings: readonly OmpProtocolMapping[] = [{
      providerId: decision.providerId,
      accountId: decision.accountId,
      modelId: decision.modelId,
      origin: decision.origin,
      apiType: decision.protocol,
    }];
    compileOmpConfig({ routes: [route], protocolMappings });
    return { accepted: true, route, protocolMappings };
  } catch {
    return { accepted: false };
  }
}

export class MemoryOmpRouteDecisionSource implements OmpRouteDecisionSource {
  readonly #decisions: readonly OmpRouteDecision[];

  constructor(decisions: readonly OmpRouteDecision[]) {
    this.#decisions = structuredClone(
      parseOmpRouteDecisionDocument({ version: 2, decisions }).decisions,
    );
  }

  async list(): Promise<readonly OmpRouteDecision[]> {
    return structuredClone(this.#decisions);
  }

  async get(
    providerId: string,
    accountId: string,
    modelId: string,
  ): Promise<OmpRouteDecision | undefined> {
    const decision = this.#decisions.find((candidate) =>
      candidate.providerId === providerId &&
      candidate.accountId === accountId &&
      candidate.modelId === modelId);
    return decision === undefined ? undefined : structuredClone(decision);
  }
}

/**
 * Read-only source. A missing file means no accepted routes; malformed content
 * fails closed and is never repaired, rewritten, or replaced.
 */
export class FileOmpRouteDecisionSource implements OmpRouteDecisionSource {
  constructor(private readonly filePath: string) {}

  async list(): Promise<readonly OmpRouteDecision[]> {
    try {
      const before = await lstat(this.filePath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() ||
          before.nlink !== 1n ||
          before.size > BigInt(maximumDocumentBytes)) throw new Error();
      const handle = await open(
        this.filePath,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        if (!sameIdentity(before, await handle.stat({ bigint: true }))) {
          throw new Error();
        }
        const bytes = await handle.readFile();
        if (
          bytes.length !== Number(before.size) ||
          !sameIdentity(before, await handle.stat({ bigint: true })) ||
          !sameIdentity(before, await lstat(this.filePath, { bigint: true }))
        ) throw new Error();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return structuredClone(
          parseOmpRouteDecisionDocument(JSON.parse(text)).decisions,
        );
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return [];
      if (error instanceof OmpRouteDecisionError) throw error;
      throw new OmpRouteDecisionError();
    }
  }

  async get(
    providerId: string,
    accountId: string,
    modelId: string,
  ): Promise<OmpRouteDecision | undefined> {
    const decision = (await this.list()).find((candidate) =>
      candidate.providerId === providerId &&
      candidate.accountId === accountId &&
      candidate.modelId === modelId);
    return decision === undefined ? undefined : structuredClone(decision);
  }
}

const maximumDocumentBytes = 4 * 1024 * 1024;
const reportablePaths = new Set(["/", "/v1", "/api/v1", "/api/chat"]);

function safeAcceptedBaseUrl(value: string): URL | undefined {
  try {
    if (/[\s\x00-\x1f\x7f%\\?#]/.test(value) ||
        /\/\.{1,2}(?:\/|$)/.test(value)) return undefined;
    const url = new URL(value);
    if (
      url.username || url.password || url.search || url.hash ||
      !["https:", "http:"].includes(url.protocol) ||
      (url.protocol === "http:" &&
        !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      !reportablePaths.has(url.pathname)
    ) return undefined;
    const normalized = url.href.replace(/\/+$/, "");
    if (normalized !== value) return undefined;
    return url;
  } catch {
    return undefined;
  }
}

function routeKey(
  providerId: string,
  accountId: string,
  modelId: string,
): string {
  return JSON.stringify([providerId, accountId, modelId]);
}

export function matchesLocalSmokeEvidence(
  decision: OmpRouteDecision,
  evidence: OmpProviderLocalSmokeEvidence,
): boolean {
  if (
    decision.localSmoke.inventorySha256 !== evidence.inventorySha256 ||
    decision.localSmoke.smokeReportSha256 !== evidence.smokeReportSha256 ||
    decision.localSmoke.executableSha256 !== evidence.executableSha256 ||
    decision.localSmoke.sourceCommit !== evidence.sourceCommit
  ) return false;
  const provider = evidence.providers.find((candidate) =>
    candidate.providerId === decision.providerId &&
    candidate.profileSha256 === decision.profileSha256);
  return provider?.models.some((candidate) =>
    candidate.modelId === decision.modelId &&
    candidate.protocols.some((item) =>
      item.protocol === decision.protocol && item.localSmoke === "passed")) === true;
}

/** Stable digest of the fields that authorize an exact Doctor-tested route. */
export function fingerprintOmpDoctorSnapshot(snapshot: ModelCapabilitySnapshot): string {
  return createHash("sha256").update(JSON.stringify({
    providerId: snapshot.providerId,
    modelId: snapshot.modelId,
    protocol: snapshot.protocol,
    checkedAt: snapshot.checkedAt,
    doctorLevel: snapshot.doctorLevel,
    verdict: snapshot.verdict,
    configurationFingerprint: snapshot.configurationFingerprint,
    credentialFingerprint: snapshot.credentialFingerprint,
    capabilities: {
      text: snapshot.capabilities.text,
      streaming: snapshot.capabilities.streaming,
      tools: snapshot.capabilities.tools,
    },
  })).digest("hex");
}

function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" &&
    "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.nlink === 1n;
}
