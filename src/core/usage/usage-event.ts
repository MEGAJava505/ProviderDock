import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  ModelTokenPricing,
  ProviderProfile,
} from "../providers/provider-profile.js";

export const usageClients = ["codex", "claude-code"] as const;
export type UsageClient = (typeof usageClients)[number];

export const usageProtocols = [
  "openai-responses",
  "openai-chat-completions",
  "anthropic-messages",
] as const;
export type UsageProtocol = (typeof usageProtocols)[number];

export const usageOutcomes = ["completed", "incomplete"] as const;
export type UsageOutcome = (typeof usageOutcomes)[number];

const tokenCountSchema = z.number().int().nonnegative().safe();

export const normalizedTokenUsageSchema = z
  .object({
    uncachedInputTokens: tokenCountSchema,
    cacheReadInputTokens: tokenCountSchema,
    cacheWriteInputTokens: tokenCountSchema,
    outputTokens: tokenCountSchema,
    reasoningOutputTokens: tokenCountSchema,
    webSearchRequests: tokenCountSchema,
    totalTokens: tokenCountSchema,
  })
  .strict()
  .superRefine((usage, context) => {
    const calculated =
      usage.uncachedInputTokens +
      usage.cacheReadInputTokens +
      usage.cacheWriteInputTokens +
      usage.outputTokens;
    if (usage.totalTokens !== calculated) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "totalTokens must equal all input token classes plus outputTokens.",
        path: ["totalTokens"],
      });
    }
    if (usage.reasoningOutputTokens > usage.outputTokens) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "reasoningOutputTokens cannot exceed outputTokens.",
        path: ["reasoningOutputTokens"],
      });
    }
  });

export type NormalizedTokenUsage = z.infer<typeof normalizedTokenUsageSchema>;

export interface UsageCost {
  readonly currency: string;
  /** Millionths of the configured currency, rounded to the nearest microunit. */
  readonly microunits: number;
}

export interface UsageTelemetryEvent {
  readonly id: string;
  readonly recordedAt: string;
  readonly providerId: string;
  readonly modelId: string;
  readonly logicalModelId?: string;
  readonly client: UsageClient;
  readonly protocol: UsageProtocol;
  readonly sessionId: string;
  readonly requestId: string;
  readonly outcome: UsageOutcome;
  readonly usage: NormalizedTokenUsage;
  readonly cost?: UsageCost;
}

export const usageTelemetryEventSchema = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    recordedAt: z.string().datetime(),
    providerId: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z0-9][a-z0-9_-]*$/),
    modelId: z.string().min(1).max(256),
    logicalModelId: z.string().min(1).max(64).optional(),
    client: z.enum(usageClients),
    protocol: z.enum(usageProtocols),
    sessionId: z.string().min(1).max(256),
    requestId: z.string().min(1).max(256),
    outcome: z.enum(usageOutcomes),
    usage: normalizedTokenUsageSchema,
    cost: z
      .object({
        currency: z.string().regex(/^(?:[A-Z]{3}|USDT)$/),
        microunits: tokenCountSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export interface CreateUsageTelemetryEventInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly logicalModelId?: string;
  readonly client: UsageClient;
  readonly protocol: UsageProtocol;
  readonly sessionId: string;
  readonly requestId?: string;
  readonly outcome: UsageOutcome;
  readonly usage: NormalizedTokenUsage;
  readonly recordedAt?: Date;
}

export type UsageEventSink = (
  event: UsageTelemetryEvent,
) => void | Promise<void>;

export function createUsageTelemetryEvent(
  input: CreateUsageTelemetryEventInput,
): UsageTelemetryEvent {
  const requestId = input.requestId ?? randomUUID();
  const usage = normalizedTokenUsageSchema.parse(input.usage);
  const cost = calculateUsageCost(
    usage,
    input.profile.modelPricing[input.modelId],
  );
  return {
    id: createHash("sha256")
      .update(
        [
          input.sessionId,
          requestId,
          input.profile.id,
          input.modelId,
          input.client,
        ].join("\u0000"),
      )
      .digest("hex"),
    recordedAt: (input.recordedAt ?? new Date()).toISOString(),
    providerId: input.profile.id,
    modelId: input.modelId,
    ...(input.logicalModelId === undefined
      ? {}
      : { logicalModelId: input.logicalModelId }),
    client: input.client,
    protocol: input.protocol,
    sessionId: input.sessionId,
    requestId,
    outcome: input.outcome,
    usage,
    ...(cost === undefined ? {} : { cost }),
  };
}

export function calculateUsageCost(
  usage: NormalizedTokenUsage,
  pricing: ModelTokenPricing | undefined,
): UsageCost | undefined {
  if (pricing === undefined) return undefined;
  if (usage.webSearchRequests > 0 && pricing.webSearchPerThousand === undefined) return undefined;
  const rawMicrounits =
    usage.uncachedInputTokens * pricing.inputPerMillion +
    usage.cacheReadInputTokens *
      (pricing.cacheReadInputPerMillion ?? pricing.inputPerMillion) +
    usage.cacheWriteInputTokens *
      (pricing.cacheWriteInputPerMillion ?? pricing.inputPerMillion) +
    usage.outputTokens * pricing.outputPerMillion +
    usage.webSearchRequests * (pricing.webSearchPerThousand ?? 0) * 1_000;
  if (!Number.isFinite(rawMicrounits) || rawMicrounits > Number.MAX_SAFE_INTEGER) {
    return undefined;
  }
  return {
    currency: pricing.currency,
    microunits: Math.max(0, Math.round(rawMicrounits)),
  };
}

export function extractOpenAiTokenUsage(
  value: unknown,
): NormalizedTokenUsage | undefined {
  const root = asRecord(value);
  const response = asRecord(root?.response);
  const usage = asRecord((response ?? root)?.usage);
  if (usage === undefined) return undefined;

  const inputDetails =
    asRecord(usage.input_tokens_details) ??
    asRecord(usage.prompt_tokens_details);
  const outputDetails =
    asRecord(usage.output_tokens_details) ??
    asRecord(usage.completion_tokens_details);
  const serverToolUse = asRecord(usage.server_tool_use);
  const inputTotal = firstTokenCount(usage.input_tokens, usage.prompt_tokens);
  const cacheRead = tokenCount(inputDetails?.cached_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const output = firstTokenCount(
    usage.output_tokens,
    usage.completion_tokens,
  );
  const reasoning = Math.min(
    output,
    tokenCount(outputDetails?.reasoning_tokens),
  );
  const webSearchRequests = tokenCount(serverToolUse?.web_search_requests);
  if (
    !hasTokenField(usage, [
      "input_tokens",
      "prompt_tokens",
      "output_tokens",
      "completion_tokens",
      "cache_creation_input_tokens",
    ]) &&
    webSearchRequests === 0
  ) {
    return undefined;
  }
  return tokenUsage({
    uncachedInputTokens: Math.max(0, inputTotal - cacheRead),
    cacheReadInputTokens: Math.min(inputTotal, cacheRead),
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: reasoning,
    webSearchRequests,
  });
}

export function extractAnthropicTokenUsage(
  value: unknown,
): NormalizedTokenUsage | undefined {
  const root = asRecord(value);
  const message = asRecord(root?.message);
  const usage = asRecord(root?.usage) ?? asRecord(message?.usage);
  if (usage === undefined) return undefined;

  const serverToolUse = asRecord(usage.server_tool_use);
  const uncachedInput = tokenCount(usage.input_tokens);
  const cacheRead = tokenCount(usage.cache_read_input_tokens);
  const cacheWrite = tokenCount(usage.cache_creation_input_tokens);
  const output = tokenCount(usage.output_tokens);
  const webSearchRequests = tokenCount(serverToolUse?.web_search_requests);
  if (
    !hasTokenField(usage, [
      "input_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
      "output_tokens",
    ]) &&
    webSearchRequests === 0
  ) {
    return undefined;
  }
  return tokenUsage({
    uncachedInputTokens: uncachedInput,
    cacheReadInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
    outputTokens: output,
    reasoningOutputTokens: 0,
    webSearchRequests,
  });
}

export class TokenUsageAccumulator {
  private usage: NormalizedTokenUsage | undefined;

  observe(next: NormalizedTokenUsage | undefined): void {
    if (next === undefined) return;
    if (this.usage === undefined) {
      this.usage = next;
      return;
    }
    this.usage = tokenUsage({
      uncachedInputTokens: Math.max(
        this.usage.uncachedInputTokens,
        next.uncachedInputTokens,
      ),
      cacheReadInputTokens: Math.max(
        this.usage.cacheReadInputTokens,
        next.cacheReadInputTokens,
      ),
      cacheWriteInputTokens: Math.max(
        this.usage.cacheWriteInputTokens,
        next.cacheWriteInputTokens,
      ),
      outputTokens: Math.max(this.usage.outputTokens, next.outputTokens),
      reasoningOutputTokens: Math.max(
        this.usage.reasoningOutputTokens,
        next.reasoningOutputTokens,
      ),
      webSearchRequests: Math.max(
        this.usage.webSearchRequests,
        next.webSearchRequests,
      ),
    });
  }

  snapshot(): NormalizedTokenUsage | undefined {
    return this.usage;
  }
}

function tokenUsage(
  input: Omit<NormalizedTokenUsage, "totalTokens">,
): NormalizedTokenUsage {
  return {
    ...input,
    totalTokens:
      input.uncachedInputTokens +
      input.cacheReadInputTokens +
      input.cacheWriteInputTokens +
      input.outputTokens,
  };
}

function tokenCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : 0;
}

function firstTokenCount(...values: readonly unknown[]): number {
  for (const value of values) {
    if (Number.isSafeInteger(value) && (value as number) >= 0) {
      return value as number;
    }
  }
  return 0;
}

function hasTokenField(
  usage: Readonly<Record<string, unknown>>,
  names: readonly string[],
): boolean {
  return names.some(
    (name) =>
      Number.isSafeInteger(usage[name]) && (usage[name] as number) >= 0,
  );
}

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
