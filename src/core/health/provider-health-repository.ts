import { updateModelRemovals } from "./model-presence.js";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { normalizedErrorTypes } from "../errors/provider-error.js";
import { fallbackFailurePhases } from "../fallback/fallback-session-router.js";
import {
  capabilityStatuses,
  clientCompatibilityStatuses,
  modelHealthStatuses,
  type CapabilityStatus,
  type ClientCompatibilityStatus,
  type ModelCatalogEntry,
} from "../providers/model-catalog.js";
import { sanitizeProviderErrorBody } from "../security/provider-error-redaction.js";
import { usageClients, usageProtocols } from "../usage/usage-event.js";
import {
  providerRuntimeOutcomes,
  runtimeHealthStatus,
  type ProviderRuntimeHealthSignal,
} from "./provider-runtime-health.js";
import type {
  ProviderHealthSnapshot,
  ProviderProbeResult,
} from "./provider-probe-service.js";
import type { ProviderProfile } from "../providers/provider-profile.js";

const storageVersion = 2 as const;
const defaultMaximumFileBytes = 16 * 1024 * 1024;
const defaultMaximumHistoryEntries = 256;
export const providerSurfaceNames = [
  "openai-api",
  "anthropic-api",
  "codex-cli",
  "claude-code",
] as const;
export type ProviderSurfaceName = (typeof providerSurfaceNames)[number];
export const providerSurfaceClients = [
  "providerdock",
  "codex",
  "claude-code",
] as const;
export type ProviderSurfaceClient = (typeof providerSurfaceClients)[number];
export const providerSurfaceCheckOutcomes = [
  "passed",
  "failed",
  "unsupported",
  "unavailable",
] as const;

/**
 * Identifies the non-secret provider connection/routing configuration used by
 * compatibility checks. Secret values are deliberately excluded; changing a
 * secret reference still invalidates measurements without persisting its
 * value.
 */
export function providerConfigurationFingerprint(
  profile: Pick<
    ProviderProfile,
    | "baseUrl"
    | "apiType"
    | "adapterId"
    | "auth"
    | "staticHeaders"
    | "secretHeaders"
    | "queryParameters"
    | "modelsEndpoint"
  >,
): string {
  const auth =
    profile.auth.kind === "none"
      ? { kind: profile.auth.kind }
      : profile.auth.kind === "bearer"
        ? { kind: profile.auth.kind, secretRef: profile.auth.secretRef }
        : profile.auth.kind === "header"
          ? {
              kind: profile.auth.kind,
              headerName: profile.auth.headerName,
              secretRef: profile.auth.secretRef,
            }
          : {
              kind: profile.auth.kind,
              parameterName: profile.auth.parameterName,
              secretRef: profile.auth.secretRef,
            };
  const payload = JSON.stringify({
    baseUrl: profile.baseUrl,
    apiType: profile.apiType,
    adapterId: profile.adapterId,
    auth,
    staticHeaders: sortedRecord(profile.staticHeaders),
    secretHeaders: sortedRecord(profile.secretHeaders),
    queryParameters: sortedRecord(profile.queryParameters),
    modelsEndpoint: profile.modelsEndpoint,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

const providerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

const providerHealthSnapshotSchema = z
  .object({
    providerId: providerIdSchema,
    status: z.enum(modelHealthStatuses),
    checkedAt: z.string().datetime(),
    latencyMs: z.number().int().nonnegative(),
    discoveredModelCount: z.number().int().nonnegative(),
    appliedFixes: z.array(z.string().min(1).max(256)).max(256),
    errorType: z.enum(normalizedErrorTypes).optional(),
    errorMessage: z.string().max(8_192).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
  })
  .strict();

const reasoningCapabilitySchema = z.union([
  z.object({ kind: z.literal("unknown") }).strict(),
  z.object({ kind: z.literal("unsupported") }).strict(),
  z
    .object({
      kind: z.literal("effort"),
      values: z.array(z.string().min(1).max(64)).max(64),
      default: z.string().min(1).max(64).optional(),
      source: z.enum([
        "official-model-catalog",
        "provider-metadata",
        "probe",
        "user-override",
      ]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("thinking-mode"),
      mode: z.enum(["forced", "toggle", "adaptive", "unknown"]),
      source: z.enum([
        "official-model-catalog",
        "provider-metadata",
        "probe",
        "user-override",
      ]),
    })
    .strict(),
]);
const modelCatalogEntrySchema = z
  .object({
    internalId: z.string().min(1).max(512),
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(256),
    displayName: z.string().min(1).max(512),
    source: z.enum(["discovered", "manual"]),
    healthStatus: z.enum(modelHealthStatuses),
    codexCompatibility: z.enum(clientCompatibilityStatuses),
    claudeCompatibility: z.enum(clientCompatibilityStatuses),
    reasoning: reasoningCapabilitySchema.optional(),
    supportedReasoningLevels: z
      .array(z.string().min(1).max(64))
      .max(64)
      .optional(),
  })
  .strict();

export const modelCapabilityNames = [
  "text",
  "streaming",
  "tools",
  "parallel_tools",
  "reasoning",
  "images",
  "web_search",
  "long_context",
  "usage",
  "cancellation",
  "model_discovery",
] as const;
export type ModelCapabilityName = (typeof modelCapabilityNames)[number];

const modelCapabilitiesSchema = z
  .object({
    text: z.enum(capabilityStatuses),
    streaming: z.enum(capabilityStatuses),
    tools: z.enum(capabilityStatuses),
    parallel_tools: z.enum(capabilityStatuses),
    reasoning: z.enum(capabilityStatuses),
    images: z.enum(capabilityStatuses),
    web_search: z.enum(capabilityStatuses),
    long_context: z.enum(capabilityStatuses),
    usage: z.enum(capabilityStatuses),
    cancellation: z.enum(capabilityStatuses),
    model_discovery: z.enum(capabilityStatuses),
  })
  .strict();

const diagnosticVerdicts = ["PASS", "DEGRADED", "FAIL", "SKIPPED"] as const;
const diagnosticProtocols = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
] as const;

const modelCapabilitySnapshotSchema = z
  .object({
    providerId: providerIdSchema,
    configurationFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    credentialFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    modelId: z.string().min(1).max(256),
    checkedAt: z.string().datetime(),
    doctorLevel: z.number().int().min(0).max(3),
    verdict: z.enum(diagnosticVerdicts),
    protocol: z.enum(diagnosticProtocols).optional(),
    capabilities: modelCapabilitiesSchema,
    codexCompatibility: z.enum(clientCompatibilityStatuses),
    claudeCompatibility: z.enum(clientCompatibilityStatuses),
    lastErrorType: z.enum(normalizedErrorTypes).optional(),
    lastErrorMessage: z.string().max(8_192).optional(),
  })
  .strict();

const providerRuntimeHealthSignalSchema = z
  .object({
    providerId: providerIdSchema,
    modelId: z.string().min(1).max(256),
    observedAt: z.string().datetime(),
    durationMs: z.number().int().nonnegative().optional(),
    client: z.enum(usageClients),
    protocol: z.enum(usageProtocols),
    sessionId: z.string().min(1).max(128).optional(),
    requestId: z.string().min(1).max(128).optional(),
    logicalModelId: providerIdSchema.optional(),
    outcome: z.enum(providerRuntimeOutcomes),
    healthStatus: z.enum(modelHealthStatuses),
    errorType: z.enum(normalizedErrorTypes).optional(),
    httpStatus: z.number().int().min(100).max(599).optional(),
    executionPhase: z.enum(fallbackFailurePhases).optional(),
    errorMessage: z.string().max(8_192).optional(),
  })
  .strict()
  .superRefine((signal, context) => {
    if (signal.healthStatus !== runtimeHealthStatus(signal.outcome, signal.errorType)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Runtime healthStatus does not match outcome/errorType.",
        path: ["healthStatus"],
      });
    }
  });

const providerSurfaceCheckSchema = z.object({
  providerId: providerIdSchema,
  modelId: z.string().min(1).max(256),
  surface: z.enum(providerSurfaceNames),
  configurationFingerprint: z.string().min(1).max(128),
  checkedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(providerSurfaceCheckOutcomes),
  client: z.enum(providerSurfaceClients),
  protocol: z.enum(usageProtocols).optional(),
  errorType: z.enum(normalizedErrorTypes).optional(),
  errorMessage: z.string().max(1_024).optional(),
}).strict();

const providerProbeResultSchema = z
  .object({
    health: providerHealthSnapshotSchema,
    models: z.array(modelCatalogEntrySchema).max(5_000),
  })
  .strict()
  .superRefine((result, context) => {
    const ids = new Set<string>();
    for (const [index, model] of result.models.entries()) {
      if (model.providerId !== result.health.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Model providerId must match the health snapshot providerId.",
          path: ["models", index, "providerId"],
        });
      }
      if (model.internalId !== `${model.providerId}:${model.modelId}`) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Model internalId must be providerId:modelId.",
          path: ["models", index, "internalId"],
        });
      }
      if (ids.has(model.internalId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate model '${model.internalId}'.`,
          path: ["models", index, "internalId"],
        });
      }
      ids.add(model.internalId);
    }
  });

const providerHealthRecordSchema = z
  .object({
    providerId: providerIdSchema,
    latest: providerProbeResultSchema.optional(),
    history: z.array(providerHealthSnapshotSchema),
    modelRemovals: z.record(z.string().min(1).max(256), z.string().datetime()).optional(),
    knownModelIds: z.array(z.string().min(1).max(256)).max(5000).optional(),
    diagnostics: z.array(modelCapabilitySnapshotSchema).max(5_000).default([]),
    runtimeSignals: z
      .array(providerRuntimeHealthSignalSchema)
      .max(10_000)
      .default([]),
    surfaceChecks: z.array(providerSurfaceCheckSchema).max(10_000).default([]),
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.latest !== undefined &&
      record.latest.health.providerId !== record.providerId
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Latest health providerId must match the record providerId.",
        path: ["latest", "health", "providerId"],
      });
    }
    for (const [index, snapshot] of record.history.entries()) {
      if (snapshot.providerId !== record.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "History providerId must match the record providerId.",
          path: ["history", index, "providerId"],
        });
      }
    }
    for (const [index, signal] of record.runtimeSignals.entries()) {
      if (signal.providerId !== record.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Runtime signal providerId must match the record providerId.",
          path: ["runtimeSignals", index, "providerId"],
        });
      }
    }
    for (const [index, check] of record.surfaceChecks.entries()) {
      if (check.providerId !== record.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Surface check providerId must match the record providerId.",
          path: ["surfaceChecks", index, "providerId"],
        });
      }
    }
    const models = new Set<string>();
    for (const [index, diagnostic] of record.diagnostics.entries()) {
      if (diagnostic.providerId !== record.providerId) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Diagnostic providerId must match the record providerId.",
          path: ["diagnostics", index, "providerId"],
        });
      }
      if (models.has(diagnostic.modelId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate diagnostic model '${diagnostic.modelId}'.`,
          path: ["diagnostics", index, "modelId"],
        });
      }
      models.add(diagnostic.modelId);
    }
  });

const storedHealthSchema = z
  .object({
    version: z.literal(storageVersion),
    providers: z.array(providerHealthRecordSchema).max(512),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [index, record] of document.providers.entries()) {
      if (ids.has(record.providerId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate provider health record '${record.providerId}'.`,
          path: ["providers", index, "providerId"],
        });
      }
      ids.add(record.providerId);
    }
  });

const legacyStoredHealthSchema = z.object({
  version: z.literal(1),
  providers: z.array(z.unknown()).max(512),
}).strict();

type StoredProviderHealthSnapshot = z.infer<
  typeof providerHealthSnapshotSchema
>;
type StoredProviderProbeResult = z.infer<typeof providerProbeResultSchema>;
type StoredModelCapabilitySnapshot = z.infer<
  typeof modelCapabilitySnapshotSchema
>;
type StoredProviderRuntimeHealthSignal = z.infer<
  typeof providerRuntimeHealthSignalSchema
>;
type StoredProviderSurfaceCheck = z.infer<typeof providerSurfaceCheckSchema>;
type StoredProviderHealthRecord = z.infer<typeof providerHealthRecordSchema>;

export interface ProviderHealthRecord {
  readonly providerId: string;
  readonly latest?: ProviderProbeResult;
  readonly history: readonly ProviderHealthSnapshot[];
  readonly modelRemovals?: Readonly<Record<string, string>>;
  readonly knownModelIds?: readonly string[];
  readonly diagnostics: readonly ModelCapabilitySnapshot[];
  readonly runtimeSignals: readonly ProviderRuntimeHealthSignal[];
  readonly surfaceChecks: readonly ProviderSurfaceCheck[];
}

export interface ProviderSurfaceCheck {
  readonly providerId: string;
  readonly modelId: string;
  readonly surface: ProviderSurfaceName;
  readonly configurationFingerprint: string;
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly outcome: (typeof providerSurfaceCheckOutcomes)[number];
  readonly client: ProviderSurfaceClient;
  readonly protocol?: (typeof usageProtocols)[number];
  readonly errorType?: (typeof normalizedErrorTypes)[number];
  readonly errorMessage?: string;
}

export interface ProviderSurfaceSummary {
  readonly surface: ProviderSurfaceName;
  readonly modelId: string;
  readonly client: ProviderSurfaceClient;
  readonly protocol?: (typeof usageProtocols)[number];
  readonly checkedAt: string;
  readonly durationMs: number;
  readonly measurements: number;
  readonly successes: number;
  readonly successRate: number;
  readonly outcome: (typeof providerSurfaceCheckOutcomes)[number];
  readonly errorType?: (typeof normalizedErrorTypes)[number];
  readonly errorMessage?: string;
}

export interface ProviderSurfaceOverview {
  readonly surfaces: readonly ProviderSurfaceSummary[];
  readonly recommendedSurface?: ProviderSurfaceName;
}

export function summarizeProviderSurfaces(
  record: Pick<ProviderHealthRecord, "surfaceChecks"> | undefined,
  configurationFingerprint: string,
  now: Date = new Date(),
  maximumAgeMs = 24 * 60 * 60 * 1_000,
): ProviderSurfaceOverview {
  const minimumTime = now.valueOf() - maximumAgeMs;
  const matching = (record?.surfaceChecks ?? []).filter((check) =>
    check.configurationFingerprint === configurationFingerprint &&
    Date.parse(check.checkedAt) >= minimumTime &&
    Date.parse(check.checkedAt) <= now.valueOf()
  );
  const surfaces: ProviderSurfaceSummary[] = [];
  for (const surface of providerSurfaceNames) {
    const samples = matching
      .filter((check) => check.surface === surface)
      .sort((left, right) =>
        left.checkedAt.localeCompare(right.checkedAt)
      );
    const latest = samples.at(-1);
    if (latest === undefined) continue;
    const successes = samples.filter((check) => check.outcome === "passed").length;
    surfaces.push({
      surface,
      modelId: latest.modelId,
      client: latest.client,
      ...(latest.protocol === undefined ? {} : { protocol: latest.protocol }),
      checkedAt: latest.checkedAt,
      durationMs: latest.durationMs,
      measurements: samples.length,
      successes,
      successRate: successes / samples.length,
      outcome: latest.outcome,
      ...(latest.errorType === undefined ? {} : { errorType: latest.errorType }),
      ...(latest.errorMessage === undefined
        ? {}
        : { errorMessage: latest.errorMessage }),
    });
  }
  const recommended = surfaces
    .filter((summary) => summary.outcome === "passed")
    .sort((left, right) =>
      right.successRate - left.successRate ||
      right.measurements - left.measurements ||
      left.durationMs - right.durationMs ||
      providerSurfaceNames.indexOf(left.surface) -
        providerSurfaceNames.indexOf(right.surface)
    )[0];
  return {
    surfaces,
    ...(recommended === undefined
      ? {}
      : { recommendedSurface: recommended.surface }),
  };
}

export interface ModelCapabilitySnapshot {
  readonly providerId: string;
  readonly configurationFingerprint?: string;
  readonly credentialFingerprint?: string;
  readonly modelId: string;
  readonly checkedAt: string;
  readonly doctorLevel: number;
  readonly verdict: (typeof diagnosticVerdicts)[number];
  readonly protocol?: (typeof diagnosticProtocols)[number];
  readonly capabilities: Readonly<Record<ModelCapabilityName, CapabilityStatus>>;
  readonly codexCompatibility: ClientCompatibilityStatus;
  readonly claudeCompatibility: ClientCompatibilityStatus;
  readonly lastErrorType?: (typeof normalizedErrorTypes)[number];
  readonly lastErrorMessage?: string;
}

export interface ProviderHealthRepository {
  list(): Promise<readonly ProviderHealthRecord[]>;
  get(providerId: string): Promise<ProviderHealthRecord | undefined>;
  record(result: ProviderProbeResult): Promise<ProviderHealthRecord>;
  recordDiagnostics(snapshot: ModelCapabilitySnapshot): Promise<ProviderHealthRecord>;
  /** Fail closed after a referenced secret is replaced or removed. */
  invalidateDiagnostics(providerId: string): Promise<void>;
  recordRuntimeSignal(
    signal: ProviderRuntimeHealthSignal,
  ): Promise<ProviderHealthRecord>;
  recordSurfaceCheck(check: ProviderSurfaceCheck): Promise<ProviderHealthRecord>;
  delete(providerId: string): Promise<boolean>;
}

export interface FileProviderHealthRepositoryOptions {
  readonly maximumFileBytes?: number;
  readonly maximumHistoryEntries?: number;
}

/** Bounded, non-secret health/model snapshots for dashboard and history views. */
export class FileProviderHealthRepository implements ProviderHealthRepository {
  private readonly maximumFileBytes: number;
  private readonly maximumHistoryEntries: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FileProviderHealthRepositoryOptions = {},
  ) {
    this.maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    this.maximumHistoryEntries =
      options.maximumHistoryEntries ?? defaultMaximumHistoryEntries;
    if (!Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes <= 0) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
    if (
      !Number.isSafeInteger(this.maximumHistoryEntries) ||
      this.maximumHistoryEntries <= 0
    ) {
      throw new TypeError("maximumHistoryEntries must be a positive safe integer.");
    }
  }

  list(): Promise<readonly ProviderHealthRecord[]> {
    return this.load();
  }

  async get(providerId: string): Promise<ProviderHealthRecord | undefined> {
    return (await this.load()).find((record) => record.providerId === providerId);
  }

  record(result: ProviderProbeResult): Promise<ProviderHealthRecord> {
    const parsed = normalizeProbeResult(providerProbeResultSchema.parse(result));
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const index = records.findIndex(
        (record) => record.providerId === parsed.health.providerId,
      );
      const previous = index < 0 ? undefined : records[index];
      const record: ProviderHealthRecord = {
        providerId: parsed.health.providerId,
        latest: parsed,
        modelRemovals: updateModelRemovals(previous, parsed),
        knownModelIds: [
          ...new Set([
            ...(previous?.knownModelIds ?? []),
            ...(previous?.latest?.models ?? [])
              .filter((model) => model.source === "discovered")
              .map((model) => model.modelId),
            ...parsed.models
              .filter((model) => model.source === "discovered")
              .map((model) => model.modelId),
          ]),
        ].slice(-5_000),
        history: [
          ...(previous?.history ?? []),
          parsed.health,
        ].slice(-this.maximumHistoryEntries),
        diagnostics: previous?.diagnostics ?? [],
        runtimeSignals: previous?.runtimeSignals ?? [],
        surfaceChecks: previous?.surfaceChecks ?? [],
      };
      if (index < 0) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.providerId.localeCompare(right.providerId));
      await this.writeAtomically(records);
      return record;
    });
  }

  recordDiagnostics(snapshot: ModelCapabilitySnapshot): Promise<ProviderHealthRecord> {
    const parsed = normalizeCapabilitySnapshot(
      modelCapabilitySnapshotSchema.parse(snapshot),
    );
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const index = records.findIndex(
        (record) => record.providerId === parsed.providerId,
      );
      const previous = index < 0 ? undefined : records[index];
      const diagnostics = [
        ...(previous?.diagnostics.filter(
          (existing) => existing.modelId !== parsed.modelId,
        ) ?? []),
        parsed,
      ].sort((left, right) => left.modelId.localeCompare(right.modelId));
      const record: ProviderHealthRecord = {
        providerId: parsed.providerId,
        ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
        history: previous?.history ?? [],
        ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
        ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
        diagnostics,
        runtimeSignals: previous?.runtimeSignals ?? [],
        surfaceChecks: previous?.surfaceChecks ?? [],
      };
      if (index < 0) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.providerId.localeCompare(right.providerId));
      await this.writeAtomically(records);
      return record;
    });
  }

  invalidateDiagnostics(providerId: string): Promise<void> {
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const index = records.findIndex((record) => record.providerId === providerId);
      if (index < 0 || records[index]!.diagnostics.length === 0) return;
      records[index] = { ...records[index]!, diagnostics: [] };
      await this.writeAtomically(records);
    });
  }

  recordRuntimeSignal(
    signal: ProviderRuntimeHealthSignal,
  ): Promise<ProviderHealthRecord> {
    const parsed = normalizeRuntimeHealthSignal(
      providerRuntimeHealthSignalSchema.parse(signal),
    );
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const index = records.findIndex(
        (record) => record.providerId === parsed.providerId,
      );
      const previous = index < 0 ? undefined : records[index];
      const record: ProviderHealthRecord = {
        providerId: parsed.providerId,
        ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
        history: previous?.history ?? [],
        ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
        ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
        diagnostics: previous?.diagnostics ?? [],
        runtimeSignals: [...(previous?.runtimeSignals ?? []), parsed].slice(
          -this.maximumHistoryEntries,
        ),
        surfaceChecks: previous?.surfaceChecks ?? [],
      };
      if (index < 0) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.providerId.localeCompare(right.providerId));
      await this.writeAtomically(records);
      return record;
    });
  }

  recordSurfaceCheck(check: ProviderSurfaceCheck): Promise<ProviderHealthRecord> {
    const parsed = normalizeSurfaceCheck(providerSurfaceCheckSchema.parse(check));
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const index = records.findIndex((record) => record.providerId === parsed.providerId);
      const previous = index < 0 ? undefined : records[index];
      const record: ProviderHealthRecord = {
        providerId: parsed.providerId,
        ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
        history: previous?.history ?? [],
        ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
        ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
        diagnostics: previous?.diagnostics ?? [],
        runtimeSignals: previous?.runtimeSignals ?? [],
        surfaceChecks: retainSurfaceChecks(
          [...(previous?.surfaceChecks ?? []), parsed],
          this.maximumHistoryEntries,
        ),
      };
      if (index < 0) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.providerId.localeCompare(right.providerId));
      await this.writeAtomically(records);
      return record;
    });
  }

  delete(providerId: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const records = [...(await this.load())];
      const remaining = records.filter((record) => record.providerId !== providerId);
      if (remaining.length === records.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async load(): Promise<readonly ProviderHealthRecord[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Health history exceeds ${this.maximumFileBytes} bytes.`,
        );
      }
      const input = JSON.parse(contents) as unknown;
      const current = storedHealthSchema.safeParse(input);
      const document = current.success ? current.data : migrateStoredHealth(input, current.error);
      for (const record of document.providers) {
        if (record.history.length > this.maximumHistoryEntries) {
          throw new RangeError(
            `Provider '${record.providerId}' health history exceeds ${this.maximumHistoryEntries} entries.`,
          );
        }
        if (record.runtimeSignals.length > this.maximumHistoryEntries) {
          throw new RangeError(
            `Provider '${record.providerId}' runtime signal history exceeds ${this.maximumHistoryEntries} entries.`,
          );
        }
      }
      return document.providers.map((record) =>
        normalizeHealthRecord({
          ...record,
          surfaceChecks: retainSurfaceChecks(
            record.surfaceChecks,
            this.maximumHistoryEntries,
          ),
        }),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAtomically(
    records: readonly ProviderHealthRecord[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, providers: records },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(`Health history exceeds ${this.maximumFileBytes} bytes.`);
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MemoryProviderHealthRepository implements ProviderHealthRepository {
  private readonly records = new Map<string, ProviderHealthRecord>();

  constructor(
    private readonly maximumHistoryEntries: number = defaultMaximumHistoryEntries,
  ) {}

  async list(): Promise<readonly ProviderHealthRecord[]> {
    return [...this.records.values()].sort((left, right) =>
      left.providerId.localeCompare(right.providerId),
    );
  }

  async get(providerId: string): Promise<ProviderHealthRecord | undefined> {
    return this.records.get(providerId);
  }

  async record(result: ProviderProbeResult): Promise<ProviderHealthRecord> {
    const parsed = normalizeProbeResult(providerProbeResultSchema.parse(result));
    const previous = this.records.get(parsed.health.providerId);
    const record: ProviderHealthRecord = {
      providerId: parsed.health.providerId,
      latest: parsed,
      modelRemovals: updateModelRemovals(previous, parsed),
      knownModelIds: [
        ...new Set([
          ...(previous?.knownModelIds ?? []),
          ...(previous?.latest?.models ?? [])
            .filter((model) => model.source === "discovered")
            .map((model) => model.modelId),
          ...parsed.models
            .filter((model) => model.source === "discovered")
            .map((model) => model.modelId),
        ]),
      ].slice(-5_000),
      history: [
        ...(previous?.history ?? []),
        parsed.health,
      ].slice(-this.maximumHistoryEntries),
      diagnostics: previous?.diagnostics ?? [],
      runtimeSignals: previous?.runtimeSignals ?? [],
      surfaceChecks: previous?.surfaceChecks ?? [],
    };
    this.records.set(record.providerId, record);
    return record;
  }

  async recordDiagnostics(
    snapshot: ModelCapabilitySnapshot,
  ): Promise<ProviderHealthRecord> {
    const parsed = normalizeCapabilitySnapshot(
      modelCapabilitySnapshotSchema.parse(snapshot),
    );
    const previous = this.records.get(parsed.providerId);
    const diagnostics = [
      ...(previous?.diagnostics.filter(
        (existing) => existing.modelId !== parsed.modelId,
      ) ?? []),
      parsed,
    ].sort((left, right) => left.modelId.localeCompare(right.modelId));
    const record: ProviderHealthRecord = {
      providerId: parsed.providerId,
      ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
      history: previous?.history ?? [],
      ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
      ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
      diagnostics,
      runtimeSignals: previous?.runtimeSignals ?? [],
      surfaceChecks: previous?.surfaceChecks ?? [],
    };
    this.records.set(record.providerId, record);
    return record;
  }

  async invalidateDiagnostics(providerId: string): Promise<void> {
    const record = this.records.get(providerId);
    if (record === undefined || record.diagnostics.length === 0) return;
    this.records.set(providerId, { ...record, diagnostics: [] });
  }

  async recordRuntimeSignal(
    signal: ProviderRuntimeHealthSignal,
  ): Promise<ProviderHealthRecord> {
    const parsed = normalizeRuntimeHealthSignal(
      providerRuntimeHealthSignalSchema.parse(signal),
    );
    const previous = this.records.get(parsed.providerId);
    const record: ProviderHealthRecord = {
      providerId: parsed.providerId,
      ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
      history: previous?.history ?? [],
      ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
      ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
      diagnostics: previous?.diagnostics ?? [],
      runtimeSignals: [...(previous?.runtimeSignals ?? []), parsed].slice(
        -this.maximumHistoryEntries,
      ),
      surfaceChecks: previous?.surfaceChecks ?? [],
    };
    this.records.set(record.providerId, record);
    return record;
  }

  async recordSurfaceCheck(check: ProviderSurfaceCheck): Promise<ProviderHealthRecord> {
    const parsed = normalizeSurfaceCheck(providerSurfaceCheckSchema.parse(check));
    const previous = this.records.get(parsed.providerId);
    const record: ProviderHealthRecord = {
      providerId: parsed.providerId,
      ...(previous?.latest === undefined ? {} : { latest: previous.latest }),
      history: previous?.history ?? [],
      ...(previous?.modelRemovals ? { modelRemovals: previous.modelRemovals } : {}),
      ...(previous?.knownModelIds ? { knownModelIds: previous.knownModelIds } : {}),
      diagnostics: previous?.diagnostics ?? [],
      runtimeSignals: previous?.runtimeSignals ?? [],
      surfaceChecks: retainSurfaceChecks(
        [...(previous?.surfaceChecks ?? []), parsed],
        this.maximumHistoryEntries,
      ),
    };
    this.records.set(record.providerId, record);
    return record;
  }

  async delete(providerId: string): Promise<boolean> {
    return this.records.delete(providerId);
  }
}

function normalizeHealthSnapshot(
  snapshot: StoredProviderHealthSnapshot,
): ProviderHealthSnapshot {
  return {
    providerId: snapshot.providerId,
    status: snapshot.status,
    checkedAt: snapshot.checkedAt,
    latencyMs: snapshot.latencyMs,
    discoveredModelCount: snapshot.discoveredModelCount,
    appliedFixes: snapshot.appliedFixes,
    ...(snapshot.errorType === undefined ? {} : { errorType: snapshot.errorType }),
    ...(snapshot.errorMessage === undefined
      ? {}
      : { errorMessage: snapshot.errorMessage }),
    ...(snapshot.httpStatus === undefined ? {} : { httpStatus: snapshot.httpStatus }),
  };
}

function normalizeProbeResult(
  result: StoredProviderProbeResult,
): ProviderProbeResult {
  return {
    health: normalizeHealthSnapshot(result.health),
    models: result.models.map(({ supportedReasoningLevels, ...model }) => ({
      ...model,
      reasoning: (model.reasoning ?? { kind: "unknown" }) as ModelCatalogEntry["reasoning"],
      ...(supportedReasoningLevels === undefined
        ? {}
        : { supportedReasoningLevels }),
    })),
  };
}

function normalizeCapabilitySnapshot(
  snapshot: StoredModelCapabilitySnapshot,
): ModelCapabilitySnapshot {
  return {
    providerId: snapshot.providerId,
    ...(snapshot.configurationFingerprint === undefined ? {} : {
      configurationFingerprint: snapshot.configurationFingerprint,
    }),
    ...(snapshot.credentialFingerprint === undefined ? {} : {
      credentialFingerprint: snapshot.credentialFingerprint,
    }),
    modelId: snapshot.modelId,
    checkedAt: snapshot.checkedAt,
    doctorLevel: snapshot.doctorLevel,
    verdict: snapshot.verdict,
    ...(snapshot.protocol === undefined ? {} : { protocol: snapshot.protocol }),
    capabilities: snapshot.capabilities,
    codexCompatibility: snapshot.codexCompatibility,
    claudeCompatibility: snapshot.claudeCompatibility,
    ...(snapshot.lastErrorType === undefined
      ? {}
      : { lastErrorType: snapshot.lastErrorType }),
    ...(snapshot.lastErrorMessage === undefined
      ? {}
      : { lastErrorMessage: snapshot.lastErrorMessage }),
  };
}

function normalizeRuntimeHealthSignal(
  signal: StoredProviderRuntimeHealthSignal,
): ProviderRuntimeHealthSignal {
  return {
    providerId: signal.providerId,
    modelId: signal.modelId,
    observedAt: signal.observedAt,
    ...(signal.durationMs === undefined ? {} : { durationMs: signal.durationMs }),
    client: signal.client,
    protocol: signal.protocol,
    ...(signal.sessionId === undefined ? {} : { sessionId: signal.sessionId }),
    ...(signal.requestId === undefined ? {} : { requestId: signal.requestId }),
    ...(signal.logicalModelId === undefined
      ? {}
      : { logicalModelId: signal.logicalModelId }),
    outcome: signal.outcome,
    healthStatus: signal.healthStatus,
    ...(signal.errorType === undefined ? {} : { errorType: signal.errorType }),
    ...(signal.httpStatus === undefined ? {} : { httpStatus: signal.httpStatus }),
    ...(signal.executionPhase === undefined
      ? {}
      : { executionPhase: signal.executionPhase }),
    ...(signal.errorMessage === undefined
      ? {}
      : { errorMessage: signal.errorMessage }),
  };
}

function retainSurfaceChecks<T extends Pick<
  ProviderSurfaceCheck,
  "surface" | "configurationFingerprint"
>>(
  checks: readonly T[],
  maximumEntriesPerSeries: number,
): T[] {
  const retainedIndexes = new Set<number>();
  const counts = new Map<string, number>();
  for (let index = checks.length - 1; index >= 0; index -= 1) {
    const check = checks[index];
    if (check === undefined) continue;
    const key = `${check.surface}\u0000${check.configurationFingerprint}`;
    const count = counts.get(key) ?? 0;
    if (count >= maximumEntriesPerSeries) continue;
    counts.set(key, count + 1);
    retainedIndexes.add(index);
  }
  return checks.filter((_check, index) => retainedIndexes.has(index));
}

function normalizeHealthRecord(
  record: StoredProviderHealthRecord,
): ProviderHealthRecord {
  return {
    providerId: record.providerId,
    ...(record.latest === undefined
      ? {}
      : { latest: normalizeProbeResult(record.latest) }),
    history: record.history.map(normalizeHealthSnapshot),
    ...(record.modelRemovals ? { modelRemovals: record.modelRemovals } : {}),
    ...(record.knownModelIds ? { knownModelIds: record.knownModelIds } : {}),
    diagnostics: record.diagnostics.map(normalizeCapabilitySnapshot),
    runtimeSignals: record.runtimeSignals.map(normalizeRuntimeHealthSignal),
    surfaceChecks: record.surfaceChecks.map(normalizeSurfaceCheck),
  };
}

function normalizeSurfaceCheck(check: StoredProviderSurfaceCheck): ProviderSurfaceCheck {
  const errorMessage = check.errorMessage === undefined
    ? undefined
    : sanitizeProviderErrorBody(check.errorMessage, {
        allowPlainText: true,
        maximumCharacters: 1_024,
      });
  return {
    providerId: check.providerId,
    modelId: check.modelId,
    surface: check.surface,
    configurationFingerprint: check.configurationFingerprint,
    checkedAt: check.checkedAt,
    durationMs: check.durationMs,
    outcome: check.outcome,
    client: check.client,
    ...(check.protocol === undefined ? {} : { protocol: check.protocol }),
    ...(check.errorType === undefined ? {} : { errorType: check.errorType }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
  };
}

function sortedRecord(
  values: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function migrateStoredHealth(input: unknown, cause: z.ZodError) {
  const legacy = legacyStoredHealthSchema.safeParse(input);
  if (!legacy.success) throw cause;
  return storedHealthSchema.parse({
    version: storageVersion,
    providers: legacy.data.providers.map((provider) => ({
      ...(provider as Record<string, unknown>),
      surfaceChecks: [],
    })),
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
