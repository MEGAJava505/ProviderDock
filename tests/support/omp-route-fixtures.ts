import { parseProviderProfile, type ProviderProfile } from "../../src/core/providers/provider-profile.js";
import {
  providerConfigurationFingerprint,
  type ModelCapabilitySnapshot,
} from "../../src/core/health/provider-health-repository.js";
import {
  fingerprintOmpDoctorSnapshot,
  fingerprintOmpProviderProfile,
  type OmpRouteDecision,
} from "../../src/migration/omp-route-decisions.js";
import type { OmpProviderLocalSmokeEvidence } from "../../src/migration/omp-provider-evidence.js";

export interface OmpRouteFixture {
  readonly profile: ProviderProfile;
  readonly doctorSnapshot: ModelCapabilitySnapshot;
  readonly decision: OmpRouteDecision;
  readonly evidence: OmpProviderLocalSmokeEvidence;
  readonly credentialFingerprint: string;
}

/**
 * The canonical accepted single-route fixture shared by the OMP route-decision
 * and route-readiness-preview suites. It is deliberately data-only: each suite
 * keeps its own assertions and edge-case mutations, so failure locality and the
 * negative checks stay in the file that owns them.
 */
export function makeOmpRouteFixture(): OmpRouteFixture {
  const credentialFingerprint = "9".repeat(64);
  const profile = parseProviderProfile({
    id: "gateway",
    displayName: "Gateway",
    baseUrl: "https://gateway.invalid/v1",
    apiType: "openai-chat-completions",
    auth: { kind: "bearer", secretRef: "gateway.key" },
    manualModelIds: ["exact-model"],
  });
  const doctorSnapshot: ModelCapabilitySnapshot = {
    providerId: "gateway",
    modelId: "exact-model",
    protocol: "openai-chat-completions",
    checkedAt: "2026-09-22T20:44:45.061Z",
    doctorLevel: 3,
    verdict: "PASS",
    configurationFingerprint: providerConfigurationFingerprint(profile),
    credentialFingerprint,
    capabilities: {
      text: "SUPPORTED", streaming: "SUPPORTED", tools: "SUPPORTED",
      parallel_tools: "UNKNOWN", reasoning: "UNKNOWN", images: "UNKNOWN",
      web_search: "UNKNOWN", long_context: "UNKNOWN", usage: "UNKNOWN",
      cancellation: "UNKNOWN", model_discovery: "SUPPORTED",
    },
    codexCompatibility: "ADAPTER",
    claudeCompatibility: "ADAPTER",
  };
  const decision: OmpRouteDecision = {
    providerId: "gateway",
    profileSha256: fingerprintOmpProviderProfile(profile),
    accountId: "confirmed-account",
    baseUrl: "https://gateway.invalid/v1",
    origin: "https://gateway.invalid",
    modelId: "exact-model",
    protocol: "openai-chat-completions",
    capabilities: { text: "supported", streaming: "supported", tools: "supported" },
    realPilot: {
      status: "passed",
      doctorLevel: 3,
      protocol: "openai-chat-completions",
      checkedAt: "2026-09-22T20:44:45.061Z",
      doctorSnapshotSha256: fingerprintOmpDoctorSnapshot(doctorSnapshot),
    },
    status: "accepted-for-pilot",
    localSmoke: {
      status: "passed",
      inventorySha256: "a".repeat(64),
      smokeReportSha256: "b".repeat(64),
      executableSha256: "c".repeat(64),
      sourceCommit: "d".repeat(40),
    },
  };
  const evidence: OmpProviderLocalSmokeEvidence = {
    version: 2,
    purpose: "verified-loopback-wire-shape-not-real-provider-acceptance",
    inventorySha256: decision.localSmoke.inventorySha256,
    smokeReportSha256: decision.localSmoke.smokeReportSha256,
    executableSha256: decision.localSmoke.executableSha256,
    sourceCommit: decision.localSmoke.sourceCommit,
    launchAuthorized: false,
    providers: [{
      providerId: decision.providerId,
      profileSha256: decision.profileSha256,
      status: "pending",
      models: [{ modelId: decision.modelId, protocols: [{
        protocol: decision.protocol,
        localSmoke: "passed",
      }] }],
      remainingUnresolved: ["ACCOUNT_IDENTITY_REQUIRED"],
    }],
  };
  return { profile, doctorSnapshot, decision, evidence, credentialFingerprint };
}
