import { describe, expect, it, vi } from "vitest";
import type { ProviderProfile } from "../src/core/providers/provider-profile.js";
import { createOperationDiagnostic, type OperationDiagnostic } from "../src/core/errors/operation-diagnostic.js";
import type { OmpPreflightResult, OmpRuntimeSelection } from "../src/clients/omp/omp-runtime.js";
import type { OmpRunRecord } from "../src/clients/omp/omp-run-repository.js";
import { OmpLaunchService, type OmpLaunchInput, type OmpLaunchResult } from "../src/application/omp-launch-service.js";
import { fingerprintOmpProviderProfile, MemoryOmpRouteDecisionSource, OmpRouteDecisionError, type OmpRouteDecision, type OmpRouteDecisionSource } from "../src/migration/omp-route-decisions.js";
import { MemoryOmpProviderLocalSmokeEvidenceSource, OmpProviderEvidenceError, type OmpProviderLocalSmokeEvidence, type OmpProviderLocalSmokeEvidenceSource } from "../src/migration/omp-provider-evidence.js";
import { providerConfigurationFingerprint, type ModelCapabilitySnapshot } from "../src/core/health/provider-health-repository.js";
import { fingerprintOmpDoctorSnapshot } from "../src/migration/omp-route-decisions.js";

const profile: ProviderProfile = {
  id: "provider-a", displayName: "Provider A", enabled: true,
  baseUrl: "https://provider.example/v1", apiType: "openai-responses",
  adapterId: "generic-openai", auth: { kind: "bearer", secretRef: "PROVIDER_A_KEY" },
  staticHeaders: {}, secretHeaders: {}, queryParameters: {}, modelsEndpoint: "models",
  manualModelIds: ["model-a"], disabledModelIds: [], modelPricing: {},
  preferredClient: "auto", timeoutMs: 10_000,
  healthCheck: { enabled: true, metadataTtlMs: 60_000, minimalInference: "on-demand" },
};
const input: OmpLaunchInput = {
  providerId: "provider-a", modelId: "model-a", accountId: "personal",
  projectDirectory: "E:\\Projects\\fixture",
  permissionAcknowledgement: "read-only-pilot-no-sandbox",
};

function createService(overrides: {
  profiles?: readonly ProviderProfile[];
  routeDecisions?: readonly OmpRouteDecision[];
  routeDecisionSource?: OmpRouteDecisionSource;
  evidence?: OmpProviderLocalSmokeEvidence;
  evidenceSource?: OmpProviderLocalSmokeEvidenceSource;
  doctorSnapshot?: ModelCapabilitySnapshot | null;
  preflight?: (selection: OmpRuntimeSelection) => Promise<OmpPreflightResult>;
  start?: (selection: OmpRuntimeSelection) => Promise<OmpLaunchResult>;
} = {}) {
  const profiles = overrides.profiles ?? [profile];
  const preflight = vi.fn(overrides.preflight ?? (async (selection: OmpRuntimeSelection) => ({
    ok: true as const, providerId: selection.route.profile.id,
    accountId: selection.route.accountId, modelId: selection.route.models[0]!.id,
    api: "openai-responses" as const,
  })));
  const start = vi.fn(overrides.start ?? (async () => ({ ok: true as const, runId: "run-1" })));
  const supervisor = {
    preflight, start,
    listRuns: vi.fn(async () => [] as readonly OmpRunRecord[]),
    getRun: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    reconcileAfterRestart: vi.fn(async () => [] as readonly OmpRunRecord[]),
  };
  const service = new OmpLaunchService({
    application: { listProviders: vi.fn(async () => profiles) },
    runtime: { preflight }, supervisor,
    routeDecisions: overrides.routeDecisionSource ?? new MemoryOmpRouteDecisionSource(overrides.routeDecisions ?? [decisionFor(profile)]),
    evidence: overrides.evidenceSource ?? new MemoryOmpProviderLocalSmokeEvidenceSource(
      overrides.evidence ?? evidenceFor(profiles[0] ?? profile),
    ),
    healthRecords: { get: async (providerId: string) => ({
      providerId, history: [],
      diagnostics: overrides.doctorSnapshot === null ? [] :
        [overrides.doctorSnapshot ?? snapshotFor(profiles[0] ?? profile)],
      runtimeSignals: [], surfaceChecks: [],
    }) },
    credentialFingerprint: async () => "9".repeat(64),
    artifact: {
      sha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    },
  });
  return { service, preflight, start, supervisor };
}

function evidenceFor(candidate: ProviderProfile): OmpProviderLocalSmokeEvidence {
  const decision = decisionFor(candidate);
  return {
    version: 2,
    purpose: "verified-loopback-wire-shape-not-real-provider-acceptance",
    inventorySha256: decision.localSmoke.inventorySha256,
    smokeReportSha256: decision.localSmoke.smokeReportSha256,
    executableSha256: decision.localSmoke.executableSha256,
    sourceCommit: decision.localSmoke.sourceCommit,
    launchAuthorized: false,
    providers: [{
      providerId: candidate.id,
      profileSha256: fingerprintOmpProviderProfile(candidate),
      status: "pending",
      models: [{ modelId: input.modelId, protocols: [{
        protocol: decision.protocol,
        localSmoke: "passed",
      }] }],
      remainingUnresolved: ["ACCOUNT_IDENTITY_REQUIRED"],
    }],
  };
}

function snapshotFor(candidate: ProviderProfile): ModelCapabilitySnapshot {
  if (candidate.apiType === "custom") throw new Error("unsupported test profile");
  return {
    providerId: candidate.id,
    modelId: input.modelId,
    protocol: candidate.apiType === "auto" ? "openai-chat-completions" : candidate.apiType,
    checkedAt: "2026-09-22T20:44:45.061Z",
    doctorLevel: 3,
    verdict: "PASS",
    configurationFingerprint: providerConfigurationFingerprint(candidate),
    credentialFingerprint: "9".repeat(64),
    capabilities: {
      text: "SUPPORTED", streaming: "SUPPORTED", tools: "SUPPORTED",
      parallel_tools: "UNKNOWN", reasoning: "UNKNOWN", images: "UNKNOWN",
      web_search: "UNKNOWN", long_context: "UNKNOWN", usage: "UNKNOWN",
      cancellation: "UNKNOWN", model_discovery: "SUPPORTED",
    },
    codexCompatibility: "ADAPTER",
    claudeCompatibility: "ADAPTER",
  };
}

function decisionFor(candidate: ProviderProfile): OmpRouteDecision {
  if (candidate.apiType === "custom") throw new Error("unsupported test profile");
  return {
    providerId: candidate.id,
    profileSha256: fingerprintOmpProviderProfile(candidate),
    accountId: input.accountId,
    baseUrl: candidate.baseUrl,
    origin: new URL(candidate.baseUrl).origin,
    modelId: input.modelId,
    protocol: candidate.apiType === "auto"
      ? "openai-chat-completions"
      : candidate.apiType,
    capabilities: {
      text: "supported",
      streaming: "supported",
      tools: "supported",
    },
    realPilot: {
      status: "passed",
      doctorLevel: 3,
      protocol: candidate.apiType === "auto"
        ? "openai-chat-completions"
        : candidate.apiType,
      checkedAt: "2026-09-22T20:44:45.061Z",
      doctorSnapshotSha256: fingerprintOmpDoctorSnapshot(snapshotFor(candidate)),
    },
    status: "accepted-for-pilot",
    localSmoke: {
      status: "passed",
      inventorySha256: "a".repeat(64), smokeReportSha256: "b".repeat(64),
      executableSha256: "c".repeat(64), sourceCommit: "d".repeat(40),
    },
  };
}

describe("OmpLaunchService", () => {
  it("preflights one exact explicit route", async () => {
    const { service, preflight } = createService();
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: true, providerId: "provider-a", accountId: "personal", modelId: "model-a" });
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      projectDirectory: input.projectDirectory,
      permissionAcknowledgement: "read-only-pilot-no-sandbox",
      route: expect.objectContaining({
        profile, accountId: "personal",
        allowedOrigins: ["https://provider.example"],
        models: [{ id: "model-a" }],
      }),
    }));
  });

  it("does not reach runtime when the stored Doctor snapshot is absent", async () => {
    const { service, preflight } = createService({ doctorSnapshot: null });
    expect(await service.preflight(input)).toMatchObject({
      ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("reports a safe upgrade diagnostic for legacy acceptance files", async () => {
    const routeSource: OmpRouteDecisionSource = {
      list: async () => { throw new OmpRouteDecisionError("LEGACY_OMP_ROUTE_DECISIONS"); },
      get: async () => { throw new OmpRouteDecisionError("LEGACY_OMP_ROUTE_DECISIONS"); },
    };
    const evidenceSource: OmpProviderLocalSmokeEvidenceSource = {
      get: async () => { throw new OmpProviderEvidenceError("LEGACY_LOCAL_SMOKE_EVIDENCE"); },
    };
    for (const overrides of [
      { routeDecisionSource: routeSource },
      { evidenceSource },
    ]) {
      const { service, preflight } = createService(overrides);
      expect(await service.preflight(input)).toMatchObject({
        ok: false, diagnostic: { code: "OMP_MIGRATION_EVIDENCE_V2_REQUIRED" },
      });
      expect(preflight).not.toHaveBeenCalled();
    }
  });

  it("fails closed before runtime when no fingerprint-bound decision exists", async () => {
    const { service, preflight } = createService({ routeDecisions: [] });
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects a stale profile fingerprint and never derives origin approval", async () => {
    const { service, preflight } = createService({ routeDecisions: [{
      ...decisionFor(profile), profileSha256: "f".repeat(64),
    }] });
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects accepted-route field or smoke-artifact drift before runtime", async () => {
    for (const changed of [
      { baseUrl: "https://provider.example/api/v1" },
      {
        protocol: "openai-chat-completions" as const,
        realPilot: {
          ...decisionFor(profile).realPilot,
          protocol: "openai-chat-completions" as const,
        },
      },
      {
        localSmoke: {
          ...decisionFor(profile).localSmoke,
          executableSha256: "e".repeat(64),
        },
      },
    ]) {
      const { service, preflight } = createService({
        routeDecisions: [{ ...decisionFor(profile), ...changed }],
      });
      const result = await service.preflight(input);
      expect(result).toMatchObject({
        ok: false,
        diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
      });
      expect(preflight).not.toHaveBeenCalled();
    }
  });

  it("rejects route decisions whose local-smoke provenance is absent from the evidence snapshot", async () => {
    const decision = decisionFor(profile);
    const evidence = evidenceFor(profile);
    const { service, preflight } = createService({
      routeDecisions: [decision],
      evidence: { ...evidence, smokeReportSha256: "e".repeat(64) },
    });
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("rejects a route whose exact model lacks a passed smoke claim", async () => {
    const evidence = evidenceFor(profile);
    const { service, preflight } = createService({
      evidence: {
        ...evidence,
        providers: [{
          ...evidence.providers[0]!,
          models: [{ modelId: input.modelId, protocols: [{
            protocol: decisionFor(profile).protocol,
            localSmoke: "missing",
          }] }],
        }],
      },
    });
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("uses the accepted exact base URL and protocol mapping for an auto profile", async () => {
    const autoProfile = { ...profile, apiType: "auto" as const };
    const { service, preflight } = createService({
      profiles: [autoProfile], routeDecisions: [decisionFor(autoProfile)],
    });
    await service.preflight(input);
    expect(preflight).toHaveBeenCalledWith(expect.objectContaining({
      protocolMappings: [{
        providerId: "provider-a", accountId: "personal", modelId: "model-a",
        origin: "https://provider.example", apiType: "openai-chat-completions",
      }],
      route: expect.objectContaining({
        allowedOrigins: ["https://provider.example"],
      }),
    }));
  });

  it("rejects an accepted auto route that the pinned compiler cannot represent", async () => {
    const unsupportedAutoProfile = {
      ...profile,
      apiType: "auto" as const,
      staticHeaders: { Originator: "fixture-only" },
    };
    const { service, preflight } = createService({
      profiles: [unsupportedAutoProfile],
      routeDecisions: [decisionFor(unsupportedAutoProfile)],
    });

    const result = await service.preflight(input);

    expect(result).toMatchObject({
      ok: false,
      diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" },
    });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("fails auto protocols closed without runtime preflight", async () => {
    const { service, preflight } = createService({
      profiles: [{ ...profile, apiType: "auto" }],
      routeDecisions: [],
    });
    const result = await service.preflight(input);
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_ROUTE_NOT_ACCEPTED" } });
    expect(preflight).not.toHaveBeenCalled();
  });

  it("requires all explicit identities and the OMP acknowledgement", async () => {
    const { service, preflight } = createService();
    const result = await service.preflight({ ...input, permissionAcknowledgement: undefined });
    expect(result).toMatchObject({ ok: false, diagnostic: { code: "OMP_PERMISSION_CONFIRMATION_REQUIRED" } });
    for (const key of ["providerId", "modelId", "accountId", "projectDirectory"] as const) {
      const missing = await service.preflight({ ...input, [key]: "" });
      expect(missing).toMatchObject({ ok: false, diagnostic: { code: "OMP_CONFIG_INVALID" } });
    }
    expect(preflight).not.toHaveBeenCalled();
  });

  it("launches only after preflight and returns safe run identity", async () => {
    const { service, preflight, start } = createService();
    const result = await service.launch(input);
    expect(result).toEqual({ ok: true, runId: "run-1" });
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(expect.objectContaining({
      route: expect.objectContaining({ profile, accountId: "personal", models: [{ id: "model-a" }] }),
    }));
  });

  it("returns only a safe diagnostic when preflight or launch fails", async () => {
    const unsafe = createOperationDiagnostic({ code: "OPERATION_FAILED", stage: "validation" }) as unknown as Record<string, unknown>;
    unsafe.message = "Bearer sk-secret";
    const { service, start } = createService({
      preflight: async () => ({ ok: true, providerId: "provider-a", accountId: "personal", modelId: "model-a", api: "openai-responses" }),
      start: async () => ({ ok: false, runId: "run-2", diagnostic: unsafe as never as OperationDiagnostic }),
    });
    expect(await service.preflight(input)).toMatchObject({ ok: true });
    expect(start).not.toHaveBeenCalled();
    const launched = await service.launch(input);
    expect(launched).toEqual({ ok: false, runId: "run-2", diagnostic: expect.objectContaining({ code: "OPERATION_FAILED", message: "Операция не выполнена." }) });
    expect(JSON.stringify(launched)).not.toContain("sk-secret");
  });

  it("delegates safe run history and restart reconciliation", async () => {
    const { service, supervisor } = createService();
    await service.listRuns();
    await service.getRun("run-1");
    await service.cancel("run-1");
    await service.reconcileAfterRestart();
    expect(supervisor.listRuns).toHaveBeenCalledOnce();
    expect(supervisor.getRun).toHaveBeenCalledWith("run-1");
    expect(supervisor.cancel).toHaveBeenCalledWith("run-1");
    expect(supervisor.reconcileAfterRestart).toHaveBeenCalledOnce();
  });
});
