import { updateModelRemovals } from "./model-presence.js";
import { randomUUID } from "node:crypto";
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
} from "../providers/model-catalog.js";
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

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 16 * 1024 * 1024;
const defaultMaximumHistoryEntries = 256;

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

type StoredProviderHealthSnapshot = z.infer<typeof providerHealthSnapshotSchema>;
type StoredProviderProbeResult = z.infer<typeof providerProbeResultSchema>;
type StoredModelCapabilitySnapshot = z.infer<
  typeof modelCapabilitySnapshotSchema
>;
type StoredProviderRuntimeHealthSignal = z.infer<
  typeof providerRuntimeHealthSignalSchema
>;
type StoredProviderHealthRecord = z.infer<typeof providerHealthRecordSchema>;

export interface ProviderHealthRecord {
  readonly providerId: string;
  readonly latest?: ProviderProbeResult;
  readonly history: readonly ProviderHealthSnapshot[];
  readonly modelRemovals?: Readonly<Record<string, string>>;
  readonly knownModelIds?: readonly string[];
  readonly diagnostics: readonly ModelCapabilitySnapshot[];
  readonly runtimeSignals: readonly ProviderRuntimeHealthSignal[];
}

export interface ModelCapabilitySnapshot {
  readonly providerId: string;
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
  recordRuntimeSignal(
    signal: ProviderRuntimeHealthSignal,
  ): Promise<ProviderHealthRecord>;
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
      knownModelIds: [...new Set([...(previous?.knownModelIds ?? []), ...(previous?.latest?.models ?? []).filter(model => model.source === "discovered").map(model => model.modelId), ...parsed.models.filter(model => model.source === "discovered").map(model => model.modelId)])].slice(-5000),
        history: [
          ...(previous?.history ?? []),
          parsed.health,
        ].slice(-this.maximumHistoryEntries),
        diagnostics: previous?.diagnostics ?? [],
        runtimeSignals: previous?.runtimeSignals ?? [],
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
      };
      if (index < 0) records.push(record);
      else records[index] = record;
      records.sort((left, right) => left.providerId.localeCompare(right.providerId));
      await this.writeAtomically(records);
      return record;
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
      const document = storedHealthSchema.parse(JSON.parse(contents));
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
      return document.providers.map(normalizeHealthRecord);
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
      knownModelIds: [...new Set([...(previous?.knownModelIds ?? []), ...(previous?.latest?.models ?? []).filter(model => model.source === "discovered").map(model => model.modelId), ...parsed.models.filter(model => model.source === "discovered").map(model => model.modelId)])].slice(-5000),
      history: [
        ...(previous?.history ?? []),
        parsed.health,
      ].slice(-this.maximumHistoryEntries),
      diagnostics: previous?.diagnostics ?? [],
      runtimeSignals: previous?.runtimeSignals ?? [],
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
    };
    this.records.set(record.providerId, record);
    return record;
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
    models: result.models,
  };
}

function normalizeCapabilitySnapshot(
  snapshot: StoredModelCapabilitySnapshot,
): ModelCapabilitySnapshot {
  return {
    providerId: snapshot.providerId,
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
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
