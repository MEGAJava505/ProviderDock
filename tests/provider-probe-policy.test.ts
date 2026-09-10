import { describe, expect, it } from "vitest";
import {
  ProviderProbePolicy,
  createProviderRuntimeHealthSignal,
  parseProviderProfile,
  type ProviderHealthRecord,
  type ProviderProbeResult,
} from "../src/index.js";

const now = new Date("2026-08-30T12:10:00.000Z");

describe("ProviderProbePolicy", () => {
  it("probes providers without observations and skips disabled checks", () => {
    const policy = new ProviderProbePolicy();
    expect(policy.decide(profile(), undefined, now)).toEqual({ action: "probe" });
    expect(
      policy.decide(profile({ healthCheck: { enabled: false } }), undefined, now),
    ).toEqual({ action: "skip", reason: "disabled" });
  });

  it("uses metadata TTL after a successful metadata probe", () => {
    const policy = new ProviderProbePolicy();
    const latest = probeResult("2026-08-30T12:09:30.000Z", "ONLINE");
    expect(policy.decide(profile(), record({ latest }), now)).toEqual({
      action: "skip",
      reason: "metadata-ttl",
      nextProbeAt: "2026-08-30T12:10:30.000Z",
    });
  });

  it("lets the latest successful traffic observation suppress a redundant probe", () => {
    const policy = new ProviderProbePolicy();
    const runtimeSignals = [
      createProviderRuntimeHealthSignal({
        providerId: "router",
        modelId: "gpt-x",
        client: "codex",
        protocol: "openai-responses",
        outcome: "completed",
        observedAt: new Date("2026-08-30T12:09:30.000Z"),
      }),
    ];
    expect(policy.decide(profile(), record({ runtimeSignals }), now)).toEqual({
      action: "skip",
      reason: "recent-traffic-success",
      nextProbeAt: "2026-08-30T12:10:30.000Z",
    });
  });

  it("uses exponential failure backoff and does not let an older success hide a newer failure", () => {
    const policy = new ProviderProbePolicy();
    const runtimeSignals = [
      createProviderRuntimeHealthSignal({
        providerId: "router",
        modelId: "gpt-x",
        client: "codex",
        protocol: "openai-responses",
        outcome: "completed",
        observedAt: new Date("2026-08-30T12:00:00.000Z"),
      }),
      createProviderRuntimeHealthSignal({
        providerId: "router",
        modelId: "gpt-x",
        client: "codex",
        protocol: "openai-responses",
        outcome: "failed",
        errorType: "NETWORK_ERROR",
        observedAt: new Date("2026-08-30T12:08:30.000Z"),
      }),
      createProviderRuntimeHealthSignal({
        providerId: "router",
        modelId: "gpt-x",
        client: "codex",
        protocol: "openai-responses",
        outcome: "failed",
        errorType: "TIMEOUT",
        observedAt: new Date("2026-08-30T12:09:30.000Z"),
      }),
    ];
    expect(policy.decide(profile(), record({ runtimeSignals }), now)).toEqual({
      action: "skip",
      reason: "failure-backoff",
      nextProbeAt: "2026-08-30T12:11:30.000Z",
    });
    expect(
      policy.decide(
        profile(),
        record({ runtimeSignals }),
        new Date("2026-08-30T12:11:31.000Z"),
      ),
    ).toEqual({ action: "probe" });
  });
});

function profile(overrides: Record<string, unknown> = {}) {
  return parseProviderProfile({
    id: "router",
    displayName: "Router",
    baseUrl: "https://example.test/v1",
    healthCheck: {
      enabled: true,
      metadataTtlMs: 60_000,
      minimalInference: "on-demand",
      ...((overrides.healthCheck as Record<string, unknown> | undefined) ?? {}),
    },
    ...overrides,
  });
}

function record(
  values: Partial<ProviderHealthRecord> = {},
): ProviderHealthRecord {
  return {
    providerId: "router",
    history: [],
    diagnostics: [],
    runtimeSignals: [],
    ...values,
  };
}

function probeResult(
  checkedAt: string,
  status: ProviderProbeResult["health"]["status"],
): ProviderProbeResult {
  return {
    health: {
      providerId: "router",
      status,
      checkedAt,
      latencyMs: 1,
      discoveredModelCount: 0,
      appliedFixes: [],
    },
    models: [],
  };
}
