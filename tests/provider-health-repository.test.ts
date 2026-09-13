import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProviderHealthRepository,
  MemoryProviderHealthRepository,
  createProviderRuntimeHealthSignal,
  summarizeProviderSurfaces,
  type ModelCapabilitySnapshot,
  type ProviderProbeResult,
  type ProviderSurfaceCheck,
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
      version: 2,
      providers: [{ providerId: "router" }],
    });
    expect(await repository.delete("router")).toBe(true);
    expect(await repository.delete("router")).toBe(false);
  });

  it("persists model reasoning levels with the latest probe", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-reasoning-"));
    const filePath = join(directory, "history.json");
    const repository = new FileProviderHealthRepository(filePath);
    const base = probeResult("2026-08-30T10:00:00.000Z", "ONLINE", 12);
    const result = {
      ...base,
      models: [
        {
          ...base.models[0]!,
          supportedReasoningLevels: ["low", "high", "max"],
        },
      ],
    } as ProviderProbeResult;

    await repository.record(result);
    const reloaded = new FileProviderHealthRepository(filePath);

    expect((await reloaded.get("router"))?.latest?.models[0]).toMatchObject({
      supportedReasoningLevels: ["low", "high", "max"],
    });
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

  it("migrates v1 health records without losing existing observations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-health-v1-"));
    const filePath = join(directory, "history.json");
    const result = probeResult("2026-08-30T10:00:00.000Z", "ONLINE", 12);
    await writeFile(filePath, JSON.stringify({
      version: 1,
      providers: [{
        providerId: "router",
        latest: result,
        history: [result.health],
        diagnostics: [capabilitySnapshot(
          "gpt-x",
          "2026-08-30T10:01:00.000Z",
          "PASS",
        )],
        runtimeSignals: [createProviderRuntimeHealthSignal({
          providerId: "router",
          modelId: "gpt-x",
          client: "codex",
          protocol: "openai-responses",
          outcome: "completed",
          observedAt: new Date("2026-08-30T10:02:00.000Z"),
          durationMs: 42,
        })],
      }],
    }), "utf8");

    const repository = new FileProviderHealthRepository(filePath);
    const migrated = await repository.get("router");
    expect(migrated).toMatchObject({
      providerId: "router",
      latest: { health: { checkedAt: "2026-08-30T10:00:00.000Z" } },
      diagnostics: [{ modelId: "gpt-x", verdict: "PASS" }],
      runtimeSignals: [{ durationMs: 42, outcome: "completed" }],
      surfaceChecks: [],
    });

    await repository.recordSurfaceCheck(surfaceCheck("openai-api", {
      checkedAt: "2026-08-30T10:03:00.000Z",
      protocol: "openai-responses",
    }));
    expect(JSON.parse(await readFile(filePath, "utf8"))).toMatchObject({
      version: 2,
      providers: [{ surfaceChecks: [{ surface: "openai-api" }] }],
    });
  });

  it("keeps independent bounded surface samples and sanitizes stored errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-surfaces-"));
    const filePath = join(directory, "history.json");
    const repository = new FileProviderHealthRepository(filePath, {
      maximumHistoryEntries: 4,
    });

    await repository.recordSurfaceCheck(surfaceCheck("openai-api", {
      checkedAt: "2026-08-30T10:00:00.000Z",
      protocol: "openai-responses",
    }));
    await repository.recordSurfaceCheck(surfaceCheck("anthropic-api", {
      checkedAt: "2026-08-30T10:01:00.000Z",
      protocol: "anthropic-messages",
    }));
    await repository.recordSurfaceCheck(surfaceCheck("codex-cli", {
      checkedAt: "2026-08-30T10:02:00.000Z",
      client: "codex",
      protocol: "openai-responses",
    }));
    await repository.recordSurfaceCheck(surfaceCheck("claude-code", {
      checkedAt: "2026-08-30T10:03:00.000Z",
      client: "claude-code",
      protocol: "anthropic-messages",
    }));
    await repository.recordSurfaceCheck(surfaceCheck("openai-api", {
      checkedAt: "2026-08-30T10:04:00.000Z",
      configurationFingerprint: "transport-b",
      outcome: "failed",
      errorType: "AUTH_ERROR",
      errorMessage: "Bearer top-secret api_key=another-secret",
    }));

    const checks = (await repository.get("router"))?.surfaceChecks ?? [];
    expect(checks).toHaveLength(5);
    expect(checks.map((check) => check.surface)).toEqual([
      "openai-api",
      "anthropic-api",
      "codex-cli",
      "claude-code",
      "openai-api",
    ]);
    expect(checks.at(-1)).toMatchObject({
      configurationFingerprint: "transport-b",
      outcome: "failed",
      errorMessage: "Bearer [REDACTED] api_key=[REDACTED]",
    });
    const input = JSON.parse(await readFile(filePath, "utf8")) as {
      providers: Array<{ surfaceChecks: Array<{ errorMessage?: string }> }>;
    };
    expect(input.providers[0]?.surfaceChecks.at(-1)?.errorMessage)
      .toBe("Bearer [REDACTED] api_key=[REDACTED]");
    expect((await new FileProviderHealthRepository(filePath, {
      maximumHistoryEntries: 4,
    }).get("router"))?.surfaceChecks).toEqual(checks);
  });

  it.each([
    ["file", (path: string) => new FileProviderHealthRepository(path, {
      maximumHistoryEntries: 2,
    })],
    ["memory", (_path: string) => new MemoryProviderHealthRepository(2)],
  ] as const)("retains a bounded history for every surface/fingerprint in %s storage", async (
    _kind,
    createRepository,
  ) => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-surfaces-"));
    const repository = createRepository(join(directory, "history.json"));
    const samples = [
      surfaceCheck("openai-api", { checkedAt: "2026-08-30T10:00:00.000Z" }),
      surfaceCheck("openai-api", { checkedAt: "2026-08-30T10:01:00.000Z" }),
      surfaceCheck("anthropic-api", {
        checkedAt: "2026-08-30T10:02:00.000Z",
        protocol: "anthropic-messages",
      }),
      surfaceCheck("openai-api", {
        checkedAt: "2026-08-30T10:03:00.000Z",
        configurationFingerprint: "transport-b",
      }),
      surfaceCheck("openai-api", { checkedAt: "2026-08-30T10:04:00.000Z" }),
    ];

    for (const sample of samples) await repository.recordSurfaceCheck(sample);

    expect((await repository.get("router"))?.surfaceChecks.map((sample) => [
      sample.surface,
      sample.configurationFingerprint,
      sample.checkedAt,
    ])).toEqual([
      ["openai-api", "transport-a", "2026-08-30T10:01:00.000Z"],
      ["anthropic-api", "transport-a", "2026-08-30T10:02:00.000Z"],
      ["openai-api", "transport-b", "2026-08-30T10:03:00.000Z"],
      ["openai-api", "transport-a", "2026-08-30T10:04:00.000Z"],
    ]);
  });

  it("summarizes only fresh matching fingerprints and recommends the stable surface", () => {
    const surfaceChecks = [
      surfaceCheck("openai-api", {
        checkedAt: "2026-08-30T10:00:00.000Z",
        durationMs: 90,
      }),
      surfaceCheck("openai-api", {
        checkedAt: "2026-08-30T10:01:00.000Z",
        durationMs: 100,
        outcome: "failed",
      }),
      surfaceCheck("openai-api", {
        checkedAt: "2026-08-30T09:59:00.000Z",
        durationMs: 80,
      }),
      surfaceCheck("anthropic-api", {
        checkedAt: "2026-08-30T10:02:00.000Z",
        durationMs: 120,
        protocol: "anthropic-messages",
      }),
      surfaceCheck("anthropic-api", {
        checkedAt: "2026-08-30T10:03:00.000Z",
        durationMs: 110,
        protocol: "anthropic-messages",
      }),
      surfaceCheck("codex-cli", {
        checkedAt: "2026-08-30T10:04:00.000Z",
        durationMs: 10,
        client: "codex",
        configurationFingerprint: "old-config",
      }),
    ];

    expect(summarizeProviderSurfaces(
      { surfaceChecks },
      "transport-a",
      new Date("2026-08-30T11:00:00.000Z"),
    )).toEqual({
      surfaces: [
        expect.objectContaining({
          surface: "openai-api",
          measurements: 3,
          successes: 2,
          successRate: 2 / 3,
          checkedAt: "2026-08-30T10:01:00.000Z",
          outcome: "failed",
        }),
        expect.objectContaining({
          surface: "anthropic-api",
          measurements: 2,
          successes: 2,
          successRate: 1,
          outcome: "passed",
        }),
      ],
      recommendedSurface: "anthropic-api",
    });
    expect(summarizeProviderSurfaces(
      { surfaceChecks },
      "transport-a",
      new Date("2026-09-01T11:00:00.000Z"),
    )).toEqual({ surfaces: [] });
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
        reasoning: { kind: "unknown" },
      },
    ],
  };
}

function surfaceCheck(
  surface: ProviderSurfaceCheck["surface"],
  overrides: Partial<ProviderSurfaceCheck> = {},
): ProviderSurfaceCheck {
  return {
    providerId: "router",
    modelId: "gpt-x",
    surface,
    configurationFingerprint: "transport-a",
    checkedAt: "2026-08-30T10:00:00.000Z",
    durationMs: 25,
    outcome: "passed",
    client: surface === "codex-cli"
      ? "codex"
      : surface === "claude-code"
        ? "claude-code"
        : "providerdock",
    ...overrides,
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
