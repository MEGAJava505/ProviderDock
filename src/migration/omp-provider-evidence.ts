import { constants, type BigIntStats } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { z } from "zod";
import type {
  OmpProviderMappingAssessment,
  OmpProviderMappingReport,
} from "./omp-provider-mapping.js";
import type { OmpProtocol } from "../clients/omp/omp-config-compiler.js";

export class OmpProviderEvidenceError extends Error {
  constructor(readonly code = "INVALID_LOCAL_SMOKE_EVIDENCE") {
    super(code);
    this.name = "OmpProviderEvidenceError";
  }
}

export interface OmpProviderLocalSmokeEvidence {
  readonly version: 2;
  readonly purpose: "verified-loopback-wire-shape-not-real-provider-acceptance";
  readonly inventorySha256: string;
  readonly smokeReportSha256: string;
  readonly executableSha256: string;
  readonly sourceCommit: string;
  readonly launchAuthorized: false;
  readonly providers: readonly {
    readonly providerId: string;
    readonly profileSha256: string;
    readonly status: "pending";
    readonly models: readonly {
      readonly modelId: string;
      readonly protocols: readonly {
        readonly protocol: OmpProtocol;
        readonly localSmoke: "passed" | "missing" | "not-eligible";
      }[];
    }[];
    readonly remainingUnresolved: readonly string[];
  }[];
}

export interface OmpProviderLocalSmokeEvidenceSource {
  get(): Promise<OmpProviderLocalSmokeEvidence | undefined>;
}

export interface ReconcileOmpProviderLocalSmokeEvidenceInput {
  readonly assessment: OmpProviderMappingReport;
  readonly inventorySha256: string;
  readonly smokeReportText: string;
  readonly expectedExecutableSha256: string;
}

export interface ReconcileSerializedOmpProviderLocalSmokeEvidenceInput {
  /**
   * Exact UTF-8 text read from the sanitized inventory artifact. The bytes
   * themselves are hashed; callers must not pass a hash copied from metadata.
   */
  readonly inventoryText: string;
  readonly smokeReportText: string;
  readonly executableSha256: string;
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceCommitSchema = z.string().regex(/^[a-f0-9]{40}$/);
const providerIdSchema = z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
const modelIdSchema = z.string().min(1).max(256).regex(/^[^\x00-\x1f\x7f-\x9f]+$/);
const unresolvedCodeSchema = z.string().min(1).max(128).regex(/^[A-Z0-9_:-]+$/);

const resultSchema = z.object({
  providerId: providerIdSchema,
  profileSha256: sha256Schema,
  modelId: modelIdSchema,
  protocol: z.enum([
    "openai-chat-completions",
    "openai-responses",
    "anthropic-messages",
  ]),
  useTool: z.boolean(),
  requests: z.number().int().min(1).max(2),
  exitCode: z.literal(0),
  timedOut: z.literal(false),
  tooMuchOutput: z.literal(false),
  wireAssertionFailed: z.literal(false),
  keyInOutput: z.literal(false),
  keyOnDisk: z.literal(false),
  passed: z.literal(true),
}).strict();

const skippedSchema = z.object({
  providerId: providerIdSchema,
  profileSha256: sha256Schema,
  reason: z.literal("no-supported-explicit-model-route"),
  unresolved: z.array(z.string().min(1).max(128)).max(64),
}).strict();

const smokeReportSchema = z.object({
  purpose: z.literal("loopback-wire-shape-only-not-real-provider-acceptance"),
  inventorySha256: sha256Schema,
  executableSha256: sha256Schema,
  sourceCommit: sourceCommitSchema,
  // Parsed only to validate the bounded report shape. Never returned.
  root: z.string().min(1).max(4_096),
  results: z.array(resultSchema).max(12_000),
  skipped: z.array(skippedSchema).max(1_000),
  allProfilesAccountedFor: z.literal(true),
}).strict();

const localSmokeEvidenceSchema = z.object({
  version: z.literal(2),
  purpose: z.literal("verified-loopback-wire-shape-not-real-provider-acceptance"),
  inventorySha256: sha256Schema,
  smokeReportSha256: sha256Schema,
  executableSha256: sha256Schema,
  sourceCommit: sourceCommitSchema,
  launchAuthorized: z.literal(false),
  providers: z.array(z.object({
    providerId: providerIdSchema,
    profileSha256: sha256Schema,
    status: z.literal("pending"),
    models: z.array(z.object({
      modelId: modelIdSchema,
      protocols: z.array(z.object({
        protocol: resultSchema.shape.protocol,
        localSmoke: z.enum(["passed", "missing", "not-eligible"]),
      }).strict()).max(3),
    }).strict()).max(12_000),
    remainingUnresolved: z.array(unresolvedCodeSchema).max(128),
  }).strict()).max(12_000),
}).strict();

/**
 * Verifies the saved loopback report against an already verified assessment.
 * It can remove only the local fixture-smoke gate. It never authorizes launch,
 * supplies identity/origin/protocol decisions, or upgrades migration status.
 */
export function reconcileOmpProviderLocalSmokeEvidence(
  input: ReconcileOmpProviderLocalSmokeEvidenceInput,
): OmpProviderLocalSmokeEvidence {
  try {
    const inventorySha256 = sha256Schema.parse(input.inventorySha256);
    const executableSha256 = sha256Schema.parse(input.expectedExecutableSha256);
    if (typeof input.smokeReportText !== "string" ||
        input.smokeReportText.length > 32 * 1024 * 1024) {
      throw new Error();
    }
    const report = smokeReportSchema.parse(JSON.parse(input.smokeReportText));
    const assessment = validateAssessment(input.assessment);
    if (
      report.inventorySha256 !== inventorySha256 ||
      report.executableSha256 !== executableSha256 ||
      report.sourceCommit !== assessment.compilerSourceCommit
    ) throw new Error();

    const rows = new Map(assessment.providers.map((row) => [row.providerId, row]));
    const passed = new Map<string, Set<boolean>>();
    const providersWithResults = new Set<string>();
    for (const result of report.results) {
      const row = rows.get(result.providerId);
      if (!row || row.profileSha256 !== result.profileSha256 ||
          result.requests !== (result.useTool ? 2 : 1)) throw new Error();
      const model = row.configuredModels.find((candidate) => candidate.id === result.modelId);
      if (!model || !isModelEligibleForExplicitProtocol(row, model)) throw new Error();
      const transport = row.transportTrials.find((candidate) =>
        candidate.protocol === result.protocol);
      if (!transport || transport.compiler !== "passed" ||
          (row.declared.apiType !== "auto" && row.declared.apiType !== result.protocol)) {
        throw new Error();
      }
      const key = modelProtocolKey(
        result.providerId,
        result.profileSha256,
        result.modelId,
        result.protocol,
      );
      const cases = passed.get(key) ?? new Set<boolean>();
      if (cases.has(result.useTool)) throw new Error();
      cases.add(result.useTool);
      passed.set(key, cases);
      providersWithResults.add(result.providerId);
    }
    for (const cases of passed.values()) {
      if (cases.size !== 2 || !cases.has(false) || !cases.has(true)) throw new Error();
    }

    const skippedProviders = new Set<string>();
    for (const skipped of report.skipped) {
      const row = rows.get(skipped.providerId);
      if (!row || row.profileSha256 !== skipped.profileSha256 ||
          skippedProviders.has(skipped.providerId) ||
          providersWithResults.has(skipped.providerId) ||
          !sameStrings(skipped.unresolved, row.unresolved)) throw new Error();
      skippedProviders.add(skipped.providerId);
    }
    if (new Set([...providersWithResults, ...skippedProviders]).size !== rows.size ||
        [...rows.keys()].some((providerId) =>
          !providersWithResults.has(providerId) && !skippedProviders.has(providerId))) {
      throw new Error();
    }

    return {
      version: 2,
      purpose: "verified-loopback-wire-shape-not-real-provider-acceptance",
      inventorySha256,
      smokeReportSha256: createHash("sha256").update(input.smokeReportText).digest("hex"),
      executableSha256,
      sourceCommit: assessment.compilerSourceCommit,
      launchAuthorized: false,
      providers: assessment.providers.map((row) => {
        const models = row.configuredModels.map((model) => {
          return {
            modelId: model.id,
            protocols: row.transportTrials.map((transport) => {
              const eligible = isModelEligibleForExplicitProtocol(row, model) &&
                transport.compiler === "passed" &&
                (row.declared.apiType === "auto" ||
                  row.declared.apiType === transport.protocol);
              const cases = passed.get(modelProtocolKey(
                row.providerId,
                row.profileSha256,
                model.id,
                transport.protocol,
              ));
              return {
                protocol: transport.protocol,
                localSmoke: !eligible ? "not-eligible" as const :
                  cases?.size === 2 ? "passed" as const : "missing" as const,
              };
            }),
          };
        });
        const eligible = models.flatMap((model) => model.protocols)
          .filter((item) => item.localSmoke !== "not-eligible");
        const allEligiblePassed = eligible.length > 0 &&
          eligible.every((item) => item.localSmoke === "passed");
        return {
          providerId: row.providerId,
          profileSha256: row.profileSha256,
          status: "pending" as const,
          models,
          remainingUnresolved: allEligiblePassed
            ? row.unresolved.filter((code) => code !== "LOCAL_PROFILE_SMOKE_REQUIRED")
            : [...row.unresolved],
        };
      }),
    };
  } catch {
    throw new OmpProviderEvidenceError();
  }
}

/**
 * Safe boundary for publishing an offline evidence snapshot from serialized
 * artifacts. It binds the smoke report to the exact inventory bytes before
 * delegating to the strict reconciler. It never authorizes a route.
 */
export function reconcileSerializedOmpProviderLocalSmokeEvidence(
  input: ReconcileSerializedOmpProviderLocalSmokeEvidenceInput,
): OmpProviderLocalSmokeEvidence {
  try {
    if (typeof input.inventoryText !== "string" ||
        input.inventoryText.length > 32 * 1024 * 1024) {
      throw new Error();
    }
    const parsed = JSON.parse(input.inventoryText) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) ||
        !Object.hasOwn(parsed, "assessment")) {
      throw new Error();
    }
    const assessment = validateAssessment(
      (parsed as { assessment: unknown }).assessment as OmpProviderMappingReport,
    );
    return reconcileOmpProviderLocalSmokeEvidence({
      assessment,
      inventorySha256: createHash("sha256").update(input.inventoryText).digest("hex"),
      smokeReportText: input.smokeReportText,
      expectedExecutableSha256: input.executableSha256,
    });
  } catch (error) {
    if (error instanceof OmpProviderEvidenceError) throw error;
    throw new OmpProviderEvidenceError();
  }
}

/**
 * Parses a persisted evidence snapshot without upgrading it to launch
 * authorization. Duplicate provider/model rows are rejected so a caller
 * cannot select an ambiguous local-smoke claim.
 */
export function parseOmpProviderLocalSmokeEvidence(
  input: unknown,
): OmpProviderLocalSmokeEvidence {
  try {
    if (input !== null && typeof input === "object" && !Array.isArray(input) &&
        "version" in input && input.version === 1) {
      throw new OmpProviderEvidenceError("LEGACY_LOCAL_SMOKE_EVIDENCE");
    }
    const evidence = localSmokeEvidenceSchema.parse(input);
    const providers = new Set<string>();
    for (const provider of evidence.providers) {
      if (providers.has(provider.providerId)) throw new Error();
      providers.add(provider.providerId);
      const models = new Set<string>();
      for (const model of provider.models) {
        if (models.has(model.modelId)) throw new Error();
        models.add(model.modelId);
        const protocols = new Set<OmpProtocol>();
        for (const item of model.protocols) {
          if (protocols.has(item.protocol)) throw new Error();
          protocols.add(item.protocol);
        }
      }
    }
    return structuredClone(evidence);
  } catch (error) {
    if (error instanceof OmpProviderEvidenceError) throw error;
    throw new OmpProviderEvidenceError();
  }
}

export class MemoryOmpProviderLocalSmokeEvidenceSource
  implements OmpProviderLocalSmokeEvidenceSource {
  readonly #evidence: OmpProviderLocalSmokeEvidence;

  constructor(evidence: OmpProviderLocalSmokeEvidence) {
    this.#evidence = parseOmpProviderLocalSmokeEvidence(evidence);
  }

  async get(): Promise<OmpProviderLocalSmokeEvidence> {
    return structuredClone(this.#evidence);
  }
}

/**
 * Read-only source. A missing file means that no local-smoke evidence has
 * been published; malformed or replaced files fail closed and are never
 * repaired, rewritten, or replaced.
 */
export class FileOmpProviderLocalSmokeEvidenceSource
  implements OmpProviderLocalSmokeEvidenceSource {
  constructor(private readonly filePath: string) {}

  async get(): Promise<OmpProviderLocalSmokeEvidence | undefined> {
    try {
      const before = await lstat(this.filePath, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() ||
          before.nlink !== 1n || before.size > BigInt(maximumEvidenceBytes)) {
        throw new Error();
      }
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
        return parseOmpProviderLocalSmokeEvidence(JSON.parse(text));
      } finally {
        await handle.close();
      }
    } catch (error) {
      if (nodeCode(error) === "ENOENT") return undefined;
      if (error instanceof OmpProviderEvidenceError) throw error;
      throw new OmpProviderEvidenceError();
    }
  }
}

const maximumEvidenceBytes = 4 * 1024 * 1024;

function validateAssessment(input: OmpProviderMappingReport): OmpProviderMappingReport {
  if (
    input?.version !== 1 ||
    input.purpose !== "offline-assessment-not-launch-authorization" ||
    !sourceCommitSchema.safeParse(input.compilerSourceCommit).success ||
    input.counts.total !== input.providers.length ||
    input.counts.enabled > input.counts.total ||
    new Set(input.providers.map((row) => row.providerId)).size !== input.providers.length ||
    input.providers.some((row) => !validAssessmentRow(row))
  ) throw new Error();
  return input;
}

function validAssessmentRow(row: OmpProviderMappingAssessment): boolean {
  return row.status === "pending" &&
    providerIdSchema.safeParse(row.providerId).success &&
    sha256Schema.safeParse(row.profileSha256).success &&
    new Set(row.configuredModels.map((model) => model.id)).size === row.configuredModels.length &&
    new Set(row.transportTrials.map((trial) => trial.protocol)).size === row.transportTrials.length &&
    row.configuredModels.every((model) => modelIdSchema.safeParse(model.id).success);
}

function modelProtocolKey(
  providerId: string,
  profileSha256: string,
  modelId: string,
  protocol: OmpProtocol,
): string {
  return JSON.stringify([providerId, profileSha256, modelId, protocol]);
}

function isModelEligibleForExplicitProtocol(
  row: OmpProviderMappingAssessment,
  model: OmpProviderMappingAssessment["configuredModels"][number],
): boolean {
  return !model.disabled && (
    model.compiler === "passed" ||
    (row.declared.apiType === "auto" && model.compiler === "PROTOCOL_UNRESOLVED")
  );
}

function sameStrings(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
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
