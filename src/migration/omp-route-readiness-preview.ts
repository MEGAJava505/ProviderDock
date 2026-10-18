// Read-only offline route-readiness preview.
//
// Renders WHY an OMP pilot launch is available or blocked for one exact
// selection, as a chain provider → account → model → protocol → origin →
// credential state → evidence state. It NEVER sends a request, resolves a
// secret, writes a file, contacts an upstream, or performs a fallback. The
// authoritative "ready" verdict is DELEGATED to evaluateOmpRouteDecisionForPilot
// — this layer only annotates and can never claim more readiness than that gate
// (see the invariant test). Loopback smoke is never treated as an upstream PASS.
import { providerConfigurationFingerprint } from "../core/health/provider-health-repository.js";
import {
  evaluateOmpRouteDecisionForPilot,
  fingerprintOmpDoctorSnapshot,
  fingerprintOmpProviderProfile,
  matchesLocalSmokeEvidence,
  parseOmpRouteDecisionDocument,
  type EvaluateOmpRouteDecisionForPilotInput,
  type OmpRouteDecision,
} from "./omp-route-decisions.js";

export type RouteNodeName =
  | "provider"
  | "account"
  | "model"
  | "protocol"
  | "origin"
  | "credential-state"
  | "evidence-state";

export type RouteNodeState = "ready" | "unknown" | "stale" | "blocked";

// These tiers describe Doctor L3 and local smoke/artifact provenance, NOT a
// completed OMP pilot. The persisted v2 field named realPilot binds a Doctor
// snapshot; it supplies no evidence that OMP ran. Only "doctor-l3-ready-for-pilot"
// can back a ready route, exclusively on the accepted-gate branch.
// "incomplete-provenance" marks a route whose Doctor snapshot matches the pilot
// record but whose mandatory local-smoke/artifact provenance is absent or
// mismatched. "doctor-l3-evidence-route-blocked" marks matching Doctor/local
// evidence on a route rejected at another node (account/model/protocol/origin/
// provider). Neither tier proves a successful OMP pilot or production readiness.
export type OmpEvidenceTier =
  | "doctor-l3-ready-for-pilot"
  | "doctor-l3-evidence-route-blocked"
  | "incomplete-provenance"
  | "stale-doctor-snapshot"
  | "local-smoke-only"
  | "v2-candidate"
  | "none";

/** `ready` means eligible for preflight/a pilot, never that the pilot passed. */
export type PreviewVerdict = "ready" | "unknown" | "blocked";

export interface RouteChainNode {
  readonly node: RouteNodeName;
  readonly state: RouteNodeState;
  /** Content-free identifier; never transcript content, secrets, or paths. */
  readonly reason: string;
}

export interface OmpRouteReadinessPreview {
  readonly selection: {
    readonly providerId: string;
    readonly accountId: string;
    readonly modelId: string;
  };
  readonly verdict: PreviewVerdict;
  /** Content-free top-level code explaining the verdict. */
  readonly reason: string;
  readonly evidenceTier: OmpEvidenceTier;
  readonly chain: readonly RouteChainNode[];
  /** Explicit-only: a preview never selects an alternative route. */
  readonly autoFallback: "not-offered";
  /** Structural guard: loopback smoke is never treated as upstream acceptance. */
  readonly loopbackSmokeIsUpstreamPass: false;
  readonly recommendedAction: string;
}

const NODE_ORDER: readonly RouteNodeName[] = [
  "provider",
  "account",
  "model",
  "protocol",
  "origin",
  "credential-state",
  "evidence-state",
];

/**
 * Build the read-only readiness preview for one selection. Pure and side-effect
 * free. When the authoritative gate accepts, every node is `ready` and the tier
 * is `doctor-l3-ready-for-pilot`; otherwise each node is annotated best-effort and the
 * verdict is at most `unknown` — never `ready`.
 */
export function buildOmpRouteReadinessPreview(
  input: EvaluateOmpRouteDecisionForPilotInput,
): OmpRouteReadinessPreview {
  const selection = {
    providerId: input.selection.providerId,
    accountId: input.selection.accountId,
    modelId: input.selection.modelId,
  };
  if (evaluateOmpRouteDecisionForPilot(input).accepted) {
    return {
      selection,
      verdict: "ready",
      reason: "route-accepted-for-pilot",
      evidenceTier: "doctor-l3-ready-for-pilot",
      chain: NODE_ORDER.map((node) => ({
        node,
        state: "ready" as const,
        reason: "matches-accepted-decision",
      })),
      autoFallback: "not-offered",
      loopbackSmokeIsUpstreamPass: false,
      recommendedAction: "none",
    };
  }
  return classifyBlocked(input, selection);
}

function classifyBlocked(
  input: EvaluateOmpRouteDecisionForPilotInput,
  selection: OmpRouteReadinessPreview["selection"],
): OmpRouteReadinessPreview {
  let parsed: OmpRouteDecision | undefined;
  try {
    parsed = parseOmpRouteDecisionDocument({
      version: 2,
      decisions: [input.decision],
    }).decisions[0];
  } catch {
    parsed = undefined;
  }
  if (parsed === undefined) {
    return {
      selection,
      verdict: "blocked",
      reason: "route-blocked",
      evidenceTier: "none",
      chain: NODE_ORDER.map((node) => ({
        node,
        state: "blocked" as const,
        reason: "no-representable-v2-decision",
      })),
      autoFallback: "not-offered",
      loopbackSmokeIsUpstreamPass: false,
      recommendedAction: "fix-or-publish-v2-route-decision",
    };
  }
  const decision = parsed;
  const profile = input.profile;
  let baseOrigin: string | undefined;
  try {
    baseOrigin = new URL(profile.baseUrl).origin;
  } catch {
    baseOrigin = undefined;
  }
  const knownModels = [...profile.manualModelIds, ...Object.keys(profile.modelPricing)];
  const modelDisabled = profile.disabledModelIds.some(
    (id) => id.toLowerCase() === decision.modelId.toLowerCase(),
  );
  const credential = classifyCredential(input);
  const evidence = classifyEvidence(decision, input);

  const chain: RouteChainNode[] = [
    node("provider",
      decision.providerId === selection.providerId &&
      decision.profileSha256 === fingerprintOmpProviderProfile(profile) &&
      decision.baseUrl === profile.baseUrl
        ? ["ready", "profile-identity-bound"]
        : ["blocked", "provider-or-profile-mismatch"]),
    node("account",
      decision.accountId === selection.accountId
        ? ["ready", "confirmed-account-identity"]
        : ["blocked", "account-identity-mismatch"]),
    node("model",
      decision.modelId === selection.modelId &&
      knownModels.includes(decision.modelId) && !modelDisabled
        ? ["ready", "known-enabled-model"]
        : ["blocked", "model-unknown-disabled-or-mismatched"]),
    node("protocol",
      profile.apiType === "auto" || profile.apiType === decision.protocol
        ? ["ready", "protocol-declared-for-profile"]
        : ["blocked", "protocol-not-declared"]),
    node("origin",
      baseOrigin !== undefined && decision.origin === baseOrigin
        ? ["ready", "origin-bound-to-base-url"]
        : ["blocked", "origin-mismatch"]),
    node("credential-state", credential),
    node("evidence-state", evidence.node),
  ];

  const anyBlocked = chain.some((entry) => entry.state === "blocked");
  const verdict: PreviewVerdict = anyBlocked ? "blocked" : "unknown";
  return {
    selection,
    verdict,
    reason: anyBlocked ? "route-blocked" : "insufficient-current-evidence",
    evidenceTier: evidence.tier,
    chain,
    autoFallback: "not-offered",
    loopbackSmokeIsUpstreamPass: false,
    recommendedAction: recommend(verdict, evidence.tier, credential[0]),
  };
}

type NodeVerdict = readonly [RouteNodeState, string];

function node(name: RouteNodeName, [state, reason]: NodeVerdict): RouteChainNode {
  return { node: name, state, reason };
}

function classifyCredential(input: EvaluateOmpRouteDecisionForPilotInput): NodeVerdict {
  const doctor = input.doctorSnapshot;
  if (doctor === undefined || doctor.credentialFingerprint === undefined) {
    return ["unknown", "no-doctor-credential-evidence"];
  }
  if (input.currentCredentialFingerprint === undefined) {
    return ["unknown", "current-credential-fingerprint-unknown"];
  }
  return doctor.credentialFingerprint === input.currentCredentialFingerprint
    ? ["ready", "credential-fingerprint-matches"]
    : ["stale", "doctor-credential-fingerprint-outdated"];
}

/**
 * Classify the evidence tier without ever treating a loopback smoke pass as an
 * upstream acceptance, and without ever claiming a fully proven route on Doctor
 * evidence alone. A `ready` evidence node requires ALL of the gate's mandatory
 * pieces: a matching Doctor Level-3 snapshot AND matching local-smoke evidence
 * AND matching executable/source-commit artifact provenance. A Doctor snapshot
 * that attests upstream but lacks that local provenance is `incomplete-provenance`,
 * never `doctor-l3-ready-for-pilot`. These prerequisites do not attest an OMP
 * run. A present-but-mismatched snapshot is `stale`;
 * loopback-only or no evidence stays `unknown`.
 *
 * Note on "stale": there is NO age-based freshness/TTL policy for Doctor L3
 * capability snapshots in this codebase (the only TTL, in
 * provider-probe-policy.ts, is a reachability re-probe cadence). "stale" here
 * therefore means a fingerprint MISMATCH against the pilot record, never
 * wall-clock age — this layer must not invent a freshness window.
 */
function classifyEvidence(
  decision: OmpRouteDecision,
  input: EvaluateOmpRouteDecisionForPilotInput,
): { readonly tier: OmpEvidenceTier; readonly node: NodeVerdict } {
  const doctor = input.doctorSnapshot;
  const doctorMatchesDecision = doctor !== undefined &&
    doctor.providerId === decision.providerId &&
    doctor.modelId === decision.modelId &&
    doctor.protocol === decision.protocol &&
    doctor.doctorLevel === 3 &&
    doctor.verdict === "PASS" &&
    doctor.checkedAt === decision.realPilot.checkedAt &&
    doctor.configurationFingerprint === providerConfigurationFingerprint(input.profile) &&
    doctor.credentialFingerprint !== undefined &&
    doctor.credentialFingerprint === input.currentCredentialFingerprint &&
    doctor.capabilities.text === "SUPPORTED" &&
    doctor.capabilities.streaming === "SUPPORTED" &&
    doctor.capabilities.tools === "SUPPORTED" &&
    fingerprintOmpDoctorSnapshot(doctor) === decision.realPilot.doctorSnapshotSha256;

  // The two other mandatory pieces the gate requires beyond the Doctor snapshot.
  const localSmokeOk = input.evidence !== undefined && matchesLocalSmokeEvidence(decision, input.evidence);
  const artifactOk = decision.localSmoke.executableSha256 === input.artifact.sha256 &&
    decision.localSmoke.sourceCommit === input.artifact.sourceCommit;

  if (doctorMatchesDecision) {
    if (!localSmokeOk) {
      // Upstream is attested, but the mandatory local-smoke provenance is
      // absent or mismatched — the route is not fully proven. Localise it here
      // instead of presenting an all-ready chain the gate has already rejected.
      return input.evidence === undefined
        ? { tier: "incomplete-provenance", node: ["unknown", "local-smoke-evidence-absent"] }
        : { tier: "incomplete-provenance", node: ["blocked", "local-smoke-evidence-mismatch"] };
    }
    if (!artifactOk) {
      return { tier: "incomplete-provenance", node: ["blocked", "artifact-provenance-mismatch"] };
    }
    // Doctor/local provenance matches, but another route node failed the gate.
    // The evidence node is ready; neither the route nor a completed OMP pilot is.
    return { tier: "doctor-l3-evidence-route-blocked", node: ["ready", "doctor-level-3-and-local-provenance"] };
  }
  if (doctor !== undefined) {
    return { tier: "stale-doctor-snapshot", node: ["stale", "doctor-snapshot-does-not-match-pilot"] };
  }
  if (localSmokeOk) {
    return { tier: "local-smoke-only", node: ["unknown", "loopback-smoke-only-not-upstream-pass"] };
  }
  return { tier: "v2-candidate", node: ["unknown", "no-doctor-level-3-evidence-yet"] };
}

function recommend(verdict: PreviewVerdict, tier: OmpEvidenceTier, credential: RouteNodeState): string {
  if (verdict === "ready") return "none";
  if (verdict === "blocked") return "fix-route-decision-mismatch";
  if (tier === "incomplete-provenance") return "provide-matching-local-smoke-and-artifact-provenance";
  if (tier === "stale-doctor-snapshot" || credential === "stale") {
    return "re-run-paid-doctor-level-3-evidence-stale";
  }
  return "run-paid-doctor-level-3-requires-explicit-authorization";
}

// A prior-attempt signal the preview may reason about WITHOUT sending a request.
export type PriorAttemptSignal =
  | "http-401"
  | "http-403"
  | "http-429"
  | "http-5xx"
  | "tool-already-executed";

export interface PreviewRetryPolicy {
  readonly signal: PriorAttemptSignal;
  /** Content-free classification of the prior signal. */
  readonly classification: string;
  /** Automatic retry is never taken by a preview. */
  readonly autoRetry: "blocked";
  /** Automatic fallback to another route is never taken by a preview. */
  readonly autoFallback: "blocked";
  /** Structural guard: the preview sends no request. */
  readonly requestSent: false;
  /** Structural guard: the preview repeats no side effect. */
  readonly repeatsSideEffect: false;
  /** Whether prior Doctor evidence must be treated as invalidated. */
  readonly evidenceState: "unchanged" | "invalidated";
  /** Content-free explicit next step the user must take. */
  readonly action: string;
}

/**
 * Map a prior-attempt signal to a preview policy. This is a pure data → policy
 * function: it sends no request, repeats no side effect, and never authorizes an
 * automatic retry or fallback. A 401/403 invalidates credential-bound evidence
 * (a re-authenticated credential needs a fresh paid Doctor run); an
 * already-executed tool must never be replayed.
 */
export function previewRetryPolicy(signal: PriorAttemptSignal): PreviewRetryPolicy {
  const base = {
    signal,
    autoRetry: "blocked" as const,
    autoFallback: "blocked" as const,
    requestSent: false as const,
    repeatsSideEffect: false as const,
  };
  switch (signal) {
    case "http-401":
    case "http-403":
      return {
        ...base,
        classification: "credential-rejected",
        evidenceState: "invalidated",
        action: "re-authenticate-then-re-run-paid-doctor-before-any-launch",
      };
    case "http-429":
      return {
        ...base,
        classification: "rate-limited",
        evidenceState: "unchanged",
        action: "explicit-backoff-then-manual-retry-no-auto-fallback",
      };
    case "http-5xx":
      return {
        ...base,
        classification: "upstream-server-error",
        evidenceState: "unchanged",
        action: "manual-retry-only-no-auto-fallback",
      };
    case "tool-already-executed":
      return {
        ...base,
        classification: "side-effect-already-applied",
        evidenceState: "unchanged",
        action: "reuse-recorded-result-never-replay",
      };
  }
}
