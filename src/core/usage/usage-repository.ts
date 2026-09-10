import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  usageTelemetryEventSchema,
  type UsageClient,
  type UsageTelemetryEvent,
} from "./usage-event.js";

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 32 * 1024 * 1024;
const defaultMaximumEvents = 10_000;

const storedUsageSchema = z
  .object({
    version: z.literal(storageVersion),
    events: z.array(usageTelemetryEventSchema),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [index, event] of document.events.entries()) {
      if (ids.has(event.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate usage event '${event.id}'.`,
          path: ["events", index, "id"],
        });
      }
      ids.add(event.id);
    }
  });

export interface UsageFilter {
  readonly providerId?: string;
  readonly modelId?: string;
  readonly client?: UsageClient;
  readonly since?: string;
  readonly until?: string;
}

export interface UsageRecordResult {
  readonly event: UsageTelemetryEvent;
  readonly inserted: boolean;
}

export interface UsageSummaryRow {
  readonly providerId: string;
  readonly modelId: string;
  readonly client: UsageClient;
  readonly requestCount: number;
  readonly completedCount: number;
  readonly incompleteCount: number;
  readonly uncachedInputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
  readonly webSearchRequests: number;
  readonly totalTokens: number;
  readonly costs: Readonly<Record<string, number>>;
  readonly firstRecordedAt: string;
  readonly lastRecordedAt: string;
}

export interface UsageRepository {
  record(event: UsageTelemetryEvent): Promise<UsageRecordResult>;
  list(filter?: UsageFilter): Promise<readonly UsageTelemetryEvent[]>;
  summarize(filter?: UsageFilter): Promise<readonly UsageSummaryRow[]>;
}

export interface FileUsageRepositoryOptions {
  readonly maximumFileBytes?: number;
  readonly maximumEvents?: number;
}

/** Bounded, deduplicated and crash-safe request usage telemetry. */
export class FileUsageRepository implements UsageRepository {
  private readonly maximumFileBytes: number;
  private readonly maximumEvents: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FileUsageRepositoryOptions = {},
  ) {
    this.maximumFileBytes =
      options.maximumFileBytes ?? defaultMaximumFileBytes;
    this.maximumEvents = options.maximumEvents ?? defaultMaximumEvents;
    if (
      !Number.isSafeInteger(this.maximumFileBytes) ||
      this.maximumFileBytes <= 0
    ) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
    if (!Number.isSafeInteger(this.maximumEvents) || this.maximumEvents <= 0) {
      throw new TypeError("maximumEvents must be a positive safe integer.");
    }
  }

  record(event: UsageTelemetryEvent): Promise<UsageRecordResult> {
    const parsed = normalizeUsageEvent(usageTelemetryEventSchema.parse(event));
    return this.serializeMutation(async () => {
      const events = [...(await this.load())];
      const existing = events.find((candidate) => candidate.id === parsed.id);
      if (existing !== undefined) return { event: existing, inserted: false };
      events.push(parsed);
      events.sort(compareUsageEvents);
      const bounded = events.slice(-this.maximumEvents);
      await this.writeAtomically(bounded);
      return { event: parsed, inserted: true };
    });
  }

  async list(
    filter: UsageFilter = {},
  ): Promise<readonly UsageTelemetryEvent[]> {
    validateFilter(filter);
    return (await this.load())
      .filter((event) => matchesUsageFilter(event, filter))
      .sort((left, right) => compareUsageEvents(right, left));
  }

  async summarize(
    filter: UsageFilter = {},
  ): Promise<readonly UsageSummaryRow[]> {
    return summarizeUsage(await this.list(filter));
  }

  private async load(): Promise<readonly UsageTelemetryEvent[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Usage telemetry exceeds ${this.maximumFileBytes} bytes.`,
        );
      }
      const document = storedUsageSchema.parse(JSON.parse(contents));
      if (document.events.length > this.maximumEvents) {
        throw new RangeError(
          `Usage telemetry exceeds ${this.maximumEvents} events.`,
        );
      }
      return document.events.map(normalizeUsageEvent);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAtomically(
    events: readonly UsageTelemetryEvent[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, events },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(
        `Usage telemetry exceeds ${this.maximumFileBytes} bytes.`,
      );
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, {
        encoding: "utf8",
        flag: "wx",
      });
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

export class MemoryUsageRepository implements UsageRepository {
  private readonly events = new Map<string, UsageTelemetryEvent>();

  constructor(private readonly maximumEvents: number = defaultMaximumEvents) {
    if (!Number.isSafeInteger(maximumEvents) || maximumEvents <= 0) {
      throw new TypeError("maximumEvents must be a positive safe integer.");
    }
  }

  async record(event: UsageTelemetryEvent): Promise<UsageRecordResult> {
    const parsed = normalizeUsageEvent(usageTelemetryEventSchema.parse(event));
    const existing = this.events.get(parsed.id);
    if (existing !== undefined) return { event: existing, inserted: false };
    this.events.set(parsed.id, parsed);
    const ordered = [...this.events.values()].sort(compareUsageEvents);
    for (const expired of ordered.slice(
      0,
      Math.max(0, ordered.length - this.maximumEvents),
    )) {
      this.events.delete(expired.id);
    }
    return { event: parsed, inserted: true };
  }

  async list(
    filter: UsageFilter = {},
  ): Promise<readonly UsageTelemetryEvent[]> {
    validateFilter(filter);
    return [...this.events.values()]
      .filter((event) => matchesUsageFilter(event, filter))
      .sort((left, right) => compareUsageEvents(right, left));
  }

  async summarize(
    filter: UsageFilter = {},
  ): Promise<readonly UsageSummaryRow[]> {
    return summarizeUsage(await this.list(filter));
  }
}

export function summarizeUsage(
  events: readonly UsageTelemetryEvent[],
): readonly UsageSummaryRow[] {
  const rows = new Map<string, MutableUsageSummary>();
  for (const event of events) {
    const key = `${event.providerId}\u0000${event.modelId}\u0000${event.client}`;
    const row = rows.get(key) ?? {
      providerId: event.providerId,
      modelId: event.modelId,
      client: event.client,
      requestCount: 0,
      completedCount: 0,
      incompleteCount: 0,
      uncachedInputTokens: 0,
      cacheReadInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 0,
      costs: {},
      firstRecordedAt: event.recordedAt,
      lastRecordedAt: event.recordedAt,
    };
    row.requestCount += 1;
    if (event.outcome === "completed") row.completedCount += 1;
    else row.incompleteCount += 1;
    row.uncachedInputTokens += event.usage.uncachedInputTokens;
    row.cacheReadInputTokens += event.usage.cacheReadInputTokens;
    row.cacheWriteInputTokens += event.usage.cacheWriteInputTokens;
    row.outputTokens += event.usage.outputTokens;
    row.reasoningOutputTokens += event.usage.reasoningOutputTokens;
    row.webSearchRequests += event.usage.webSearchRequests;
    row.totalTokens += event.usage.totalTokens;
    if (event.cost !== undefined) {
      row.costs[event.cost.currency] =
        (row.costs[event.cost.currency] ?? 0) + event.cost.microunits;
    }
    if (event.recordedAt < row.firstRecordedAt) {
      row.firstRecordedAt = event.recordedAt;
    }
    if (event.recordedAt > row.lastRecordedAt) {
      row.lastRecordedAt = event.recordedAt;
    }
    rows.set(key, row);
  }
  return [...rows.values()].sort(
    (left, right) =>
      left.providerId.localeCompare(right.providerId) ||
      left.modelId.localeCompare(right.modelId) ||
      left.client.localeCompare(right.client),
  );
}

interface MutableUsageSummary {
  providerId: string;
  modelId: string;
  client: UsageClient;
  requestCount: number;
  completedCount: number;
  incompleteCount: number;
  uncachedInputTokens: number;
  cacheReadInputTokens: number;
  cacheWriteInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  webSearchRequests: number;
  totalTokens: number;
  costs: Record<string, number>;
  firstRecordedAt: string;
  lastRecordedAt: string;
}

function matchesUsageFilter(
  event: UsageTelemetryEvent,
  filter: UsageFilter,
): boolean {
  return (
    (filter.providerId === undefined ||
      event.providerId === filter.providerId) &&
    (filter.modelId === undefined || event.modelId === filter.modelId) &&
    (filter.client === undefined || event.client === filter.client) &&
    (filter.since === undefined || event.recordedAt >= filter.since) &&
    (filter.until === undefined || event.recordedAt <= filter.until)
  );
}

function validateFilter(filter: UsageFilter): void {
  for (const [name, value] of [
    ["since", filter.since],
    ["until", filter.until],
  ] as const) {
    if (value !== undefined && Number.isNaN(Date.parse(value))) {
      throw new TypeError(`${name} must be an ISO date/time.`);
    }
  }
}

function compareUsageEvents(
  left: UsageTelemetryEvent,
  right: UsageTelemetryEvent,
): number {
  return (
    left.recordedAt.localeCompare(right.recordedAt) ||
    left.id.localeCompare(right.id)
  );
}

function normalizeUsageEvent(
  event: z.infer<typeof usageTelemetryEventSchema>,
): UsageTelemetryEvent {
  return {
    id: event.id,
    recordedAt: event.recordedAt,
    providerId: event.providerId,
    modelId: event.modelId,
    ...(event.logicalModelId === undefined
      ? {}
      : { logicalModelId: event.logicalModelId }),
    client: event.client,
    protocol: event.protocol,
    sessionId: event.sessionId,
    requestId: event.requestId,
    outcome: event.outcome,
    usage: event.usage,
    ...(event.cost === undefined ? {} : { cost: event.cost }),
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
