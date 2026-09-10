import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileUsageRepository,
  createUsageTelemetryEvent,
  extractAnthropicTokenUsage,
  extractOpenAiTokenUsage,
  parseProviderProfile,
} from "../src/index.js";

describe("usage telemetry", () => {
  it("normalizes OpenAI and Anthropic usage classes", () => {
    expect(
      extractOpenAiTokenUsage({
        usage: {
          input_tokens: 100,
          input_tokens_details: { cached_tokens: 20 },
          output_tokens: 10,
          output_tokens_details: { reasoning_tokens: 3 },
          server_tool_use: { web_search_requests: 2 },
        },
      }),
    ).toEqual({
      uncachedInputTokens: 80,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 3,
      webSearchRequests: 2,
      totalTokens: 110,
    });
    expect(
      extractAnthropicTokenUsage({
        usage: {
          input_tokens: 50,
          cache_read_input_tokens: 20,
          cache_creation_input_tokens: 10,
          output_tokens: 5,
        },
      }),
    ).toEqual({
      uncachedInputTokens: 50,
      cacheReadInputTokens: 20,
      cacheWriteInputTokens: 10,
      outputTokens: 5,
      reasoningOutputTokens: 0,
      webSearchRequests: 0,
      totalTokens: 85,
    });
  });

  it("deduplicates, bounds, filters, summarizes, and calculates configured cost", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-usage-"));
    const repository = new FileUsageRepository(join(directory, "usage.json"), {
      maximumEvents: 2,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://router.example.test/v1",
      modelPricing: {
        "gpt-x": {
          currency: "USD",
          inputPerMillion: 2,
          outputPerMillion: 10,
          cacheReadInputPerMillion: 1,
          webSearchPerThousand: 5,
        },
      },
    });
    const usage = extractOpenAiTokenUsage({
      usage: {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 20 },
        output_tokens: 10,
        server_tool_use: { web_search_requests: 2 },
      },
    });
    expect(usage).toBeDefined();
    const first = createUsageTelemetryEvent({
      profile,
      modelId: "gpt-x",
      client: "codex",
      protocol: "openai-responses",
      sessionId: "session",
      requestId: "request-1",
      outcome: "completed",
      usage: usage!,
      recordedAt: new Date("2026-08-30T10:00:00.000Z"),
    });
    expect(first.cost).toEqual({ currency: "USD", microunits: 10_280 });
    expect(await repository.record(first)).toMatchObject({ inserted: true });
    expect(await repository.record(first)).toMatchObject({ inserted: false });

    for (const [requestId, recordedAt, outcome] of [
      ["request-2", "2026-08-30T10:01:00.000Z", "incomplete"],
      ["request-3", "2026-08-30T10:02:00.000Z", "completed"],
    ] as const) {
      await repository.record(
        createUsageTelemetryEvent({
          profile,
          modelId: "gpt-x",
          client: "codex",
          protocol: "openai-responses",
          sessionId: "session",
          requestId,
          outcome,
          usage: usage!,
          recordedAt: new Date(recordedAt),
        }),
      );
    }

    expect((await repository.list()).map((event) => event.requestId)).toEqual([
      "request-3",
      "request-2",
    ]);
    const summary = await repository.summarize({
      since: "2026-08-30T10:01:00.000Z",
    });
    expect(summary).toEqual([
      expect.objectContaining({
        providerId: "router",
        modelId: "gpt-x",
        requestCount: 2,
        completedCount: 1,
        incompleteCount: 1,
        totalTokens: 220,
        webSearchRequests: 4,
        costs: { USD: 20_560 },
      }),
    ]);
  });
});
