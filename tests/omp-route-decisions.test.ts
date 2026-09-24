import { describe, expect, it } from "vitest";
import { providerConfigurationFingerprint, type ModelCapabilitySnapshot } from "../src/core/health/provider-health-repository.js";
import {
  FileOmpRouteDecisionSource,
  MemoryOmpRouteDecisionSource,
  OmpRouteDecisionError,
  evaluateOmpRouteDecisionForPilot,
  fingerprintOmpProviderProfile,
  fingerprintOmpDoctorSnapshot,
  parseOmpRouteDecisionDocument,
} from "../src/migration/omp-route-decisions.js";
import type { OmpProviderLocalSmokeEvidence } from "../src/migration/omp-provider-evidence.js";
import { makeOmpRouteFixture } from "./support/omp-route-fixtures.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const { profile, doctorSnapshot, decision, evidence } = makeOmpRouteFixture();

describe("OMP fingerprint-bound route decisions", () => {
  it("does not accept self-asserted Doctor success without an independent snapshot", () => {
    expect(evaluateOmpRouteDecisionForPilot({
      profile,
      decision,
      evidence,
      doctorSnapshot: undefined,
      currentCredentialFingerprint: "9".repeat(64),
      selection: {
        providerId: decision.providerId,
        accountId: decision.accountId,
        modelId: decision.modelId,
      },
      artifact: {
        sha256: decision.localSmoke.executableSha256,
        sourceCommit: decision.localSmoke.sourceCommit,
      },
    })).toEqual({ accepted: false });
  });

  it("evaluates one exact decision offline without credentials or runtime", () => {
    expect(evaluateOmpRouteDecisionForPilot({
      profile,
      decision,
      evidence,
      doctorSnapshot,
      currentCredentialFingerprint: "9".repeat(64),
      selection: {
        providerId: decision.providerId,
        accountId: decision.accountId,
        modelId: decision.modelId,
      },
      artifact: {
        sha256: decision.localSmoke.executableSha256,
        sourceCommit: decision.localSmoke.sourceCommit,
      },
    })).toEqual({
      accepted: true,
      route: {
        profile,
        accountId: decision.accountId,
        allowedOrigins: [decision.origin],
        models: [{ id: decision.modelId }],
      },
      protocolMappings: [{
        providerId: decision.providerId,
        accountId: decision.accountId,
        modelId: decision.modelId,
        origin: decision.origin,
        apiType: decision.protocol,
      }],
    });
  });

  it("fails closed for stale evidence or a compiler-rejected transport", () => {
    const input = {
      profile,
      decision,
      evidence,
      doctorSnapshot,
      currentCredentialFingerprint: "9".repeat(64),
      selection: {
        providerId: decision.providerId,
        accountId: decision.accountId,
        modelId: decision.modelId,
      },
      artifact: {
        sha256: decision.localSmoke.executableSha256,
        sourceCommit: decision.localSmoke.sourceCommit,
      },
    };
    expect(evaluateOmpRouteDecisionForPilot({
      ...input,
      evidence: { ...evidence, smokeReportSha256: "e".repeat(64) },
    })).toEqual({ accepted: false });
    expect(evaluateOmpRouteDecisionForPilot({
      ...input,
      profile: {
        ...profile,
        apiType: "auto",
        staticHeaders: { Originator: "fixture-only" },
      },
      decision: { ...decision, protocol: "openai-chat-completions" },
    })).toEqual({ accepted: false });
  });

  it("rejects Doctor snapshots from a different credential, route, or capability result", () => {
    const input = {
      profile, decision, evidence, doctorSnapshot,
      currentCredentialFingerprint: "9".repeat(64),
      selection: {
        providerId: decision.providerId,
        accountId: decision.accountId,
        modelId: decision.modelId,
      },
      artifact: {
        sha256: decision.localSmoke.executableSha256,
        sourceCommit: decision.localSmoke.sourceCommit,
      },
    };
    for (const changed of [
      { configurationFingerprint: providerConfigurationFingerprint({
        ...profile, auth: { kind: "bearer" as const, secretRef: "other-key" },
      }) },
      { modelId: "other-model" },
      { protocol: "openai-responses" as const },
      { doctorLevel: 2 },
      { verdict: "FAIL" as const },
      { checkedAt: "2026-09-22T20:45:00.000Z" },
      { capabilities: { ...doctorSnapshot.capabilities, tools: "UNKNOWN" as const } },
    ]) {
      expect(evaluateOmpRouteDecisionForPilot({
        ...input, doctorSnapshot: { ...doctorSnapshot, ...changed },
      })).toEqual({ accepted: false });
    }
    expect(evaluateOmpRouteDecisionForPilot({
      ...input,
      decision: { ...decision, realPilot: {
        ...decision.realPilot, doctorSnapshotSha256: "f".repeat(64),
      } },
    })).toEqual({ accepted: false });
    expect(evaluateOmpRouteDecisionForPilot({
      ...input, currentCredentialFingerprint: "8".repeat(64),
    })).toEqual({ accepted: false });
  });

  it("binds auto-profile smoke evidence to the exact accepted protocol", () => {
    const autoProfile = { ...profile, apiType: "auto" as const };
    const autoDoctor: ModelCapabilitySnapshot = {
      ...doctorSnapshot,
      protocol: "openai-responses",
      configurationFingerprint: providerConfigurationFingerprint(autoProfile),
    };
    const responsesDecision = {
      ...decision,
      profileSha256: fingerprintOmpProviderProfile(autoProfile),
      protocol: "openai-responses" as const,
      realPilot: {
        ...decision.realPilot,
        protocol: "openai-responses" as const,
        doctorSnapshotSha256: fingerprintOmpDoctorSnapshot(autoDoctor),
      },
    };
    const input = {
      profile: autoProfile,
      decision: responsesDecision,
      doctorSnapshot: autoDoctor,
      currentCredentialFingerprint: "9".repeat(64),
      selection: {
        providerId: responsesDecision.providerId,
        accountId: responsesDecision.accountId,
        modelId: responsesDecision.modelId,
      },
      artifact: {
        sha256: responsesDecision.localSmoke.executableSha256,
        sourceCommit: responsesDecision.localSmoke.sourceCommit,
      },
    };
    const protocolEvidence = (protocol: "openai-chat-completions" | "openai-responses") => ({
      ...evidence,
      providers: [{
        ...evidence.providers[0]!,
        profileSha256: responsesDecision.profileSha256,
        models: [{ modelId: responsesDecision.modelId, protocols: [{
          protocol,
          localSmoke: "passed" as const,
        }] }],
      }],
    });

    expect(evaluateOmpRouteDecisionForPilot({
      ...input,
      evidence: protocolEvidence("openai-responses") as OmpProviderLocalSmokeEvidence,
    }).accepted).toBe(true);
    expect(evaluateOmpRouteDecisionForPilot({
      ...input,
      evidence: protocolEvidence("openai-chat-completions") as OmpProviderLocalSmokeEvidence,
    })).toEqual({ accepted: false });
  });

  it("accepts only explicit non-secret route decisions", () => {
    const document = parseOmpRouteDecisionDocument({ version: 2, decisions: [decision] });
    expect(document).toEqual({ version: 2, decisions: [decision] });
    const source = new MemoryOmpRouteDecisionSource(document.decisions);
    expect(source.get("gateway", "confirmed-account", "exact-model")).resolves.toEqual(decision);
    expect(source.get("gateway", "other-account", "exact-model")).resolves.toBeUndefined();
    expect(source.get("gateway", "confirmed-account", "other-model")).resolves.toBeUndefined();
  });

  it("treats old version-one decisions as non-authorizing", () => {
    try {
      parseOmpRouteDecisionDocument({ version: 1, decisions: [decision] });
      throw new Error("expected legacy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OmpRouteDecisionError);
      expect((error as OmpRouteDecisionError).code).toBe("LEGACY_OMP_ROUTE_DECISIONS");
    }
  });

  it("rejects duplicate route keys and free-form credential-like fields", () => {
    expect(() => parseOmpRouteDecisionDocument({ version: 2, decisions: [decision, decision] }))
      .toThrow("INVALID_OMP_ROUTE_DECISIONS");
    expect(() => parseOmpRouteDecisionDocument({
      version: 2,
      decisions: [{ ...decision, accountId: "Bearer sk-secret" }],
    })).toThrow("INVALID_OMP_ROUTE_DECISIONS");
    expect(() => parseOmpRouteDecisionDocument({
      version: 2,
      decisions: [{ ...decision, origin: "https://gateway.invalid/v1" }],
    })).toThrow("INVALID_OMP_ROUTE_DECISIONS");
  });

  it("rejects unsafe endpoints, unsupported protocols and malformed smoke evidence", () => {
    for (const patch of [
      { baseUrl: "https://gateway.invalid/v1/chat/completions" },
      { origin: "https://other.invalid" },
      { protocol: "custom" as const },
      { localSmoke: { ...decision.localSmoke, status: "missing" as const } },
      { localSmoke: { ...decision.localSmoke, executableSha256: "not-a-sha256" } },
    ]) {
      expect(() => parseOmpRouteDecisionDocument({
        version: 2,
        decisions: [{ ...decision, ...patch }],
      })).toThrow("INVALID_OMP_ROUTE_DECISIONS");
    }
  });

  it("requires passed level-3 evidence for the exact protocol and core capabilities", () => {
    for (const patch of [
      { capabilities: { ...decision.capabilities, tools: "unknown" } },
      { realPilot: { ...decision.realPilot, status: "failed" } },
      { realPilot: { ...decision.realPilot, doctorLevel: 2 } },
      { realPilot: { ...decision.realPilot, protocol: "openai-responses" } },
    ]) {
      expect(() => parseOmpRouteDecisionDocument({
        version: 2,
        decisions: [{ ...decision, ...patch }],
      })).toThrow("INVALID_OMP_ROUTE_DECISIONS");
    }
  });

  it("reads decisions without creating or repairing files", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-route-decisions-"));
    const path = join(root, "decisions.json");
    const source = new FileOmpRouteDecisionSource(path);
    await expect(source.list()).resolves.toEqual([]);
    await expect(source.get("gateway", "confirmed-account", "exact-model")).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ version: 2, decisions: [decision] }));
    await expect(source.get("gateway", "confirmed-account", "exact-model")).resolves.toEqual(decision);
  });

  it("fails closed on malformed files without exposing or repairing their content", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-route-decisions-invalid-"));
    const path = join(root, "decisions.json");
    const privateContent = '{"private":"Bearer sk-secret"';
    await writeFile(path, privateContent);
    const source = new FileOmpRouteDecisionSource(path);

    await expect(source.list()).rejects.toThrow("INVALID_OMP_ROUTE_DECISIONS");
    try {
      await source.list();
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).not.toContain("sk-secret");
    }
    await expect(readFile(path, "utf8")).resolves.toBe(privateContent);
  });
});
