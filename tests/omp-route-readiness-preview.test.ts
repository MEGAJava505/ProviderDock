import { describe, expect, it } from "vitest";
import {
  evaluateOmpRouteDecisionForPilot,
  type EvaluateOmpRouteDecisionForPilotInput,
} from "../src/migration/omp-route-decisions.js";
import {
  buildOmpRouteReadinessPreview,
  previewRetryPolicy,
  type PriorAttemptSignal,
} from "../src/migration/omp-route-readiness-preview.js";
import { makeOmpRouteFixture } from "./support/omp-route-fixtures.js";

const { profile, doctorSnapshot, decision, evidence, credentialFingerprint: CREDENTIAL } =
  makeOmpRouteFixture();

function baseInput(
  overrides: Partial<EvaluateOmpRouteDecisionForPilotInput> = {},
): EvaluateOmpRouteDecisionForPilotInput {
  return {
    profile,
    decision,
    evidence,
    doctorSnapshot,
    currentCredentialFingerprint: CREDENTIAL,
    selection: {
      providerId: decision.providerId,
      accountId: decision.accountId,
      modelId: decision.modelId,
    },
    artifact: {
      sha256: decision.localSmoke.executableSha256,
      sourceCommit: decision.localSmoke.sourceCommit,
    },
    ...overrides,
  };
}

function stateOf(preview: ReturnType<typeof buildOmpRouteReadinessPreview>, node: string) {
  return preview.chain.find((entry) => entry.node === node)!;
}

describe("offline OMP route-readiness preview (fixtures only)", () => {
  it("renders the full chain as ready only when the authoritative gate accepts", () => {
    const input = baseInput();
    expect(evaluateOmpRouteDecisionForPilot(input).accepted).toBe(true);

    const preview = buildOmpRouteReadinessPreview(input);
    expect(preview.verdict).toBe("ready");
    expect(preview.evidenceTier).toBe("real-paid-pilot");
    expect(preview.recommendedAction).toBe("none");
    expect(preview.autoFallback).toBe("not-offered");
    expect(preview.loopbackSmokeIsUpstreamPass).toBe(false);
    expect(preview.chain.map((entry) => entry.node)).toEqual([
      "provider", "account", "model", "protocol", "origin",
      "credential-state", "evidence-state",
    ]);
    expect(preview.chain.every((entry) => entry.state === "ready")).toBe(true);
  });

  it("never claims more readiness than the gate across breaking mutations", () => {
    const mutations: Array<Partial<EvaluateOmpRouteDecisionForPilotInput>> = [
      { doctorSnapshot: undefined },
      { evidence: undefined },
      { currentCredentialFingerprint: "8".repeat(64) },
      { currentCredentialFingerprint: undefined },
      { doctorSnapshot: { ...doctorSnapshot, checkedAt: "2026-09-22T21:00:00.000Z" } },
      { doctorSnapshot: { ...doctorSnapshot, verdict: "FAIL" } },
      { selection: { providerId: "gateway", accountId: "other-account", modelId: "exact-model" } },
      { selection: { providerId: "gateway", accountId: "confirmed-account", modelId: "other-model" } },
      { decision: { ...decision, origin: "https://elsewhere.invalid" } },
      { decision: "not-an-object" },
    ];
    for (const mutation of mutations) {
      const input = baseInput(mutation);
      const gate = evaluateOmpRouteDecisionForPilot(input);
      const preview = buildOmpRouteReadinessPreview(input);
      expect(gate.accepted).toBe(false);
      expect(preview.verdict).not.toBe("ready");
    }
  });

  it("treats a passing loopback smoke without a Doctor snapshot as unknown, not ready", () => {
    const preview = buildOmpRouteReadinessPreview(baseInput({ doctorSnapshot: undefined }));
    expect(preview.verdict).toBe("unknown");
    expect(preview.evidenceTier).toBe("local-smoke-only");
    expect(preview.loopbackSmokeIsUpstreamPass).toBe(false);
    const node = stateOf(preview, "evidence-state");
    expect(node.state).toBe("unknown");
    expect(node.reason).toBe("loopback-smoke-only-not-upstream-pass");
    expect(preview.recommendedAction).toBe("run-paid-doctor-level-3-requires-explicit-authorization");
  });

  it("marks a present-but-mismatched Doctor snapshot as a stale tier", () => {
    const preview = buildOmpRouteReadinessPreview(baseInput({
      doctorSnapshot: { ...doctorSnapshot, checkedAt: "2026-09-22T21:00:00.000Z" },
    }));
    expect(preview.verdict).toBe("unknown");
    expect(preview.evidenceTier).toBe("stale-doctor-snapshot");
    expect(stateOf(preview, "evidence-state").state).toBe("stale");
    expect(preview.recommendedAction).toBe("re-run-paid-doctor-level-3-evidence-stale");
  });

  it("reports a v2 candidate with no evidence at all as unknown", () => {
    const preview = buildOmpRouteReadinessPreview(
      baseInput({ doctorSnapshot: undefined, evidence: undefined }),
    );
    expect(preview.verdict).toBe("unknown");
    expect(preview.evidenceTier).toBe("v2-candidate");
    expect(stateOf(preview, "evidence-state").reason).toBe("no-paid-pilot-evidence-yet");
  });

  it("flags a rotated credential as stale evidence state", () => {
    const preview = buildOmpRouteReadinessPreview(
      baseInput({ currentCredentialFingerprint: "8".repeat(64) }),
    );
    expect(preview.verdict).toBe("unknown");
    expect(stateOf(preview, "credential-state").state).toBe("stale");
    expect(preview.evidenceTier).toBe("stale-doctor-snapshot");
  });

  it("blocks a structural mismatch on the exact node and never auto-falls-back", () => {
    const preview = buildOmpRouteReadinessPreview(baseInput({
      selection: { providerId: "gateway", accountId: "other-account", modelId: "exact-model" },
    }));
    expect(preview.verdict).toBe("blocked");
    expect(stateOf(preview, "account").state).toBe("blocked");
    expect(preview.autoFallback).toBe("not-offered");
    expect(preview.recommendedAction).toBe("fix-route-decision-mismatch");
  });

  it("collapses an unrepresentable decision to a fully blocked chain", () => {
    const preview = buildOmpRouteReadinessPreview(baseInput({ decision: { version: 1 } }));
    expect(preview.verdict).toBe("blocked");
    expect(preview.evidenceTier).toBe("none");
    expect(preview.chain.every((entry) => entry.state === "blocked")).toBe(true);
  });

  it("never leaks the credential fingerprint value into the rendered preview", () => {
    const serialized = JSON.stringify(buildOmpRouteReadinessPreview(baseInput()));
    expect(serialized).not.toContain(CREDENTIAL);
  });

  it("does not render a real-paid-pilot all-ready chain when the gate rejects for missing local-smoke evidence", () => {
    const input = baseInput({ evidence: undefined, doctorSnapshot });
    // The gate still rejects: local-smoke evidence is a mandatory piece.
    expect(evaluateOmpRouteDecisionForPilot(input).accepted).toBe(false);

    const preview = buildOmpRouteReadinessPreview(input);
    expect(preview.evidenceTier).not.toBe("real-paid-pilot");
    expect(stateOf(preview, "evidence-state").state).not.toBe("ready");
    // The whole point: a rejected gate must never present an all-ready chain.
    expect(preview.chain.every((entry) => entry.state === "ready")).toBe(false);
    expect(preview.verdict).not.toBe("ready");
  });

  it("localises an artifact-provenance mismatch at the evidence node rather than claiming ready", () => {
    const input = baseInput({ artifact: { sha256: "e".repeat(64), sourceCommit: "f".repeat(40) } });
    expect(evaluateOmpRouteDecisionForPilot(input).accepted).toBe(false);

    const preview = buildOmpRouteReadinessPreview(input);
    expect(stateOf(preview, "evidence-state").state).not.toBe("ready");
    expect(preview.evidenceTier).not.toBe("real-paid-pilot");
  });

  it("keeps the preview's per-node explanation consistent with the gate (never all-ready when rejected)", () => {
    const rejecting: Array<Partial<EvaluateOmpRouteDecisionForPilotInput>> = [
      { evidence: undefined },
      { doctorSnapshot: undefined },
      { doctorSnapshot: { ...doctorSnapshot, verdict: "FAIL" } },
      { doctorSnapshot: { ...doctorSnapshot, checkedAt: "2026-09-22T21:00:00.000Z" } },
      { currentCredentialFingerprint: "8".repeat(64) },
      { currentCredentialFingerprint: undefined },
      { artifact: { sha256: "e".repeat(64), sourceCommit: "f".repeat(40) } },
      { selection: { providerId: "gateway", accountId: "other-account", modelId: "exact-model" } },
      { selection: { providerId: "gateway", accountId: "confirmed-account", modelId: "other-model" } },
      { decision: { ...decision, origin: "https://elsewhere.invalid" } },
      { decision: "not-an-object" },
    ];
    for (const mutation of rejecting) {
      const input = baseInput(mutation);
      expect(evaluateOmpRouteDecisionForPilot(input).accepted).toBe(false);
      const preview = buildOmpRouteReadinessPreview(input);
      // Invariant: a rejected route is always localised to at least one non-ready node.
      expect(preview.chain.some((entry) => entry.state !== "ready")).toBe(true);
      // And the "fully proven" tier only ever appears on an accepted route.
      expect(preview.evidenceTier).not.toBe("real-paid-pilot");
    }
  });
});
describe("preview retry/side-effect policy (no request, no replay)", () => {
  it("invalidates credential evidence on 401/403 and blocks auto retry and fallback", () => {
    for (const signal of ["http-401", "http-403"] as PriorAttemptSignal[]) {
      const policy = previewRetryPolicy(signal);
      expect(policy.classification).toBe("credential-rejected");
      expect(policy.evidenceState).toBe("invalidated");
      expect(policy.autoRetry).toBe("blocked");
      expect(policy.autoFallback).toBe("blocked");
      expect(policy.requestSent).toBe(false);
    }
  });

  it("requires explicit backoff on 429 and manual retry on 5xx, never auto-fallback", () => {
    const rateLimited = previewRetryPolicy("http-429");
    expect(rateLimited.classification).toBe("rate-limited");
    expect(rateLimited.evidenceState).toBe("unchanged");
    expect(rateLimited.autoFallback).toBe("blocked");

    const serverError = previewRetryPolicy("http-5xx");
    expect(serverError.classification).toBe("upstream-server-error");
    expect(serverError.action).toBe("manual-retry-only-no-auto-fallback");
    expect(serverError.autoFallback).toBe("blocked");
  });

  it("never replays an already-executed tool side effect", () => {
    const policy = previewRetryPolicy("tool-already-executed");
    expect(policy.classification).toBe("side-effect-already-applied");
    expect(policy.action).toBe("reuse-recorded-result-never-replay");
    expect(policy.repeatsSideEffect).toBe(false);
    expect(policy.autoRetry).toBe("blocked");
  });
});
