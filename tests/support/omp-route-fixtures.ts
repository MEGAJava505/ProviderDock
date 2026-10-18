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
 * Overrides for {@link makeOmpRouteFixture}. Every field defaults to the canonical
 * `https://gateway.invalid` values, so `makeOmpRouteFixture()` with no argument is
 * byte-identical to the original data-only fixture. The integration harness passes
 * a `http://127.0.0.1:<port>/v1` loopback `baseUrl`/`origin` plus the fake child's
 * real streamed hash as `executableSha256` and the pinned `sourceCommit`, so the
 * SAME production route-acceptance path (evaluateOmpRouteDecisionForPilot +
 * verifyArtifact) passes with no test-only bypass.
 */
export interface OmpRouteFixtureOverrides {
  readonly baseUrl?: string;
  readonly origin?: string;
  readonly accountId?: string;
  readonly modelId?: string;
  readonly executableSha256?: string;
  readonly sourceCommit?: string;
  /**
   * Overrides the credential-revision fingerprint stamped on both the returned
   * value and the Doctor snapshot. The integration harness passes the real
   * `providerSecretRevisionFingerprint(profile, store)` so the SAME production
   * `assertCredentialGeneration` check accepts the fixture.
   */
  readonly credentialFingerprint?: string;
}

/**
 * The canonical accepted single-route fixture shared by the OMP route-decision
 * and route-readiness-preview suites. It is deliberately data-only: each suite
 * keeps its own assertions and edge-case mutations, so failure locality and the
 * negative checks stay in the file that owns them.
 */
export function makeOmpRouteFixture(overrides: OmpRouteFixtureOverrides = {}): OmpRouteFixture {
  const baseUrl = overrides.baseUrl ?? "https://gateway.invalid/v1";
  const origin = overrides.origin ?? "https://gateway.invalid";
  const accountId = overrides.accountId ?? "confirmed-account";
  const modelId = overrides.modelId ?? "exact-model";
  const executableSha256 = overrides.executableSha256 ?? "c".repeat(64);
  const sourceCommit = overrides.sourceCommit ?? "d".repeat(40);
  const credentialFingerprint = overrides.credentialFingerprint ?? "9".repeat(64);
  const profile = parseProviderProfile({
    id: "gateway",
    displayName: "Gateway",
    baseUrl,
    apiType: "openai-chat-completions",
    auth: { kind: "bearer", secretRef: "gateway.key" },
    manualModelIds: [modelId],
  });
  const doctorSnapshot: ModelCapabilitySnapshot = {
    providerId: "gateway",
    modelId,
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
    accountId,
    baseUrl,
    origin,
    modelId,
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
      executableSha256,
      sourceCommit,
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
