import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderHealthRepository,
  createProviderRuntimeHealthSignal,
  type ModelCapabilitySnapshot,
  type ProviderProbeResult,
} from "../src/index.js";

describe("FileProviderHealthRepository", () => {
  it("persists latest model state and bounded provider history", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-"));
    const filePath = join(directory, "health", "history.json");
    const repository = new FileProviderHealthRepository(filePath, {
      maximumHistoryEntries: 2,
    });

    await repository.record(probeResult("2026-08-30T10:00:00.000Z", "ONLINE", 12));
    await repository.record(probeResult("2026-08-30T10:01:00.000Z", "DEGRADED", 20));
    await repository.record(probeResult("2026-08-30T10:02:00.000Z", "ONLINE", 8));

    const record = await repository.get("router");
    expect(record).toMatchObject({
      providerId: "router",
      latest: {
        health: {
          checkedAt: "2026-08-30T10:02:00.000Z",
          status: "ONLINE",
        },
        models: [{ internalId: "router:gpt-x" }],
      },
    });
    expect(record?.history.map((snapshot) => snapshot.checkedAt)).toEqual([
      "2026-08-30T10:01:00.000Z",
      "2026-08-30T10:02:00.000Z",
    ]);

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    expect(stored).toMatchObject({
      version: 1,
      providers: [{ providerId: "router" }],
    });
    expect(await repository.delete("router")).toBe(true);
    expect(await repository.delete("router")).toBe(false);
  });

  it("persists diagnostics without a probe and replaces the latest snapshot per model", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-"));
    const filePath = join(directory, "health", "history.json");
    const repository = new FileProviderHealthRepository(filePath);

    await repository.recordDiagnostics(
      capabilitySnapshot("gpt-x", "2026-08-30T10:00:00.000Z", "DEGRADED"),
    );
    await repository.recordDiagnostics(
      capabilitySnapshot("gpt-y", "2026-08-30T10:01:00.000Z", "PASS"),
    );
    await repository.recordDiagnostics(
      capabilitySnapshot("gpt-x", "2026-08-30T10:02:00.000Z", "PASS"),
    );

    expect(await repository.get("router")).toMatchObject({
      providerId: "router",
      history: [],
      diagnostics: [
        {
          modelId: "gpt-x",
          checkedAt: "2026-08-30T10:02:00.000Z",
          verdict: "PASS",
        },
        {
          modelId: "gpt-y",
          checkedAt: "2026-08-30T10:01:00.000Z",
        },
      ],
    });
    expect((await repository.get("router"))?.latest).toBeUndefined();

    await repository.record(probeResult("2026-08-30T10:03:00.000Z", "ONLINE", 9));
    const reloaded = new FileProviderHealthRepository(filePath);
    expect((await reloaded.get("router"))?.diagnostics).toHaveLength(2);
    expect((await reloaded.get("router"))?.latest?.health.status).toBe("ONLINE");
    expect(await reloaded.delete("router")).toBe(true);
    expect(await reloaded.get("router")).toBeUndefined();
  });

  it("persists bounded real-traffic health signals independently of token usage", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-"));
    const filePath = join(directory, "health", "history.json");
    const repository = new FileProviderHealthRepository(filePath, {
      maximumHistoryEntries: 2,
    });

    for (const [observedAt, outcome, errorType] of [
      ["2026-08-30T10:00:00.000Z", "completed", undefined],
      ["2026-08-30T10:01:00.000Z", "failed", "AUTH_ERROR"],
      ["2026-08-30T10:02:00.000Z", "incomplete", "STREAM_ERROR"],
    ] as const) {
      await repository.recordRuntimeSignal(
        createProviderRuntimeHealthSignal({
          providerId: "router",
          modelId: "gpt-x",
          client: "codex",
          protocol: "openai-responses",
          sessionId: "session-health",
          requestId: observedAt,
          logicalModelId: "logical-x",
          outcome,
          observedAt: new Date(observedAt),
          ...(errorType === undefined ? {} : { errorType }),
        }),
      );
    }

    const reloaded = new FileProviderHealthRepository(filePath, {
      maximumHistoryEntries: 2,
    });
    expect((await reloaded.get("router"))?.runtimeSignals).toEqual([
      expect.objectContaining({
        observedAt: "2026-08-30T10:01:00.000Z",
        sessionId: "session-health",
        logicalModelId: "logical-x",
        outcome: "failed",
        healthStatus: "AUTH_ERROR",
      }),
      expect.objectContaining({
        observedAt: "2026-08-30T10:02:00.000Z",
        requestId: "2026-08-30T10:02:00.000Z",
        outcome: "incomplete",
        healthStatus: "DEGRADED",
      }),
    ]);
  });

  it("fails closed for inconsistent, duplicate, and oversized persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-"));
    const filePath = join(directory, "history.json");
    const repository = new FileProviderHealthRepository(filePath, {
      maximumFileBytes: 4_096,
    });
    const result = probeResult("2026-08-30T10:00:00.000Z", "ONLINE", 12);
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        providers: [
          { providerId: "router", latest: result, history: [result.health] },
          { providerId: "router", latest: result, history: [result.health] },
        ],
      }),
      "utf8",
    );
    await expect(repository.list()).rejects.toThrow(/duplicate provider health/i);

    await writeFile(filePath, "x".repeat(4_097), "utf8");
    await expect(repository.list()).rejects.toThrow(/exceeds 4096 bytes/i);
  });
});

function probeResult(
  checkedAt: string,
  status: ProviderProbeResult["health"]["status"],
  latencyMs: number,
): ProviderProbeResult {
  return {
    health: {
      providerId: "router",
      status,
      checkedAt,
      latencyMs,
      discoveredModelCount: 1,
      appliedFixes: [],
    },
    models: [
      {
        internalId: "router:gpt-x",
        providerId: "router",
        modelId: "gpt-x",
        displayName: "GPT X",
        source: "discovered",
        healthStatus: status,
        codexCompatibility: "UNKNOWN",
        claudeCompatibility: "UNKNOWN",
      },
    ],
  };
}

function capabilitySnapshot(
  modelId: string,
  checkedAt: string,
  verdict: ModelCapabilitySnapshot["verdict"],
): ModelCapabilitySnapshot {
  return {
    providerId: "router",
    modelId,
    checkedAt,
    doctorLevel: 3,
    verdict,
    protocol: "openai-chat-completions",
    capabilities: {
      text: "SUPPORTED",
      streaming: "SUPPORTED",
      tools: verdict === "PASS" ? "SUPPORTED" : "DEGRADED",
      parallel_tools: "UNKNOWN",
      reasoning: "UNKNOWN",
      images: "UNKNOWN",
      web_search: "UNKNOWN",
      long_context: "UNKNOWN",
      usage: "UNKNOWN",
      cancellation: "UNKNOWN",
      model_discovery: "SUPPORTED",
    },
    codexCompatibility: "ADAPTER",
    claudeCompatibility: "ADAPTER",
  };
}
