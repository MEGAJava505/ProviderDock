import { createHash } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { assessOmpProviderMappings } from "../src/migration/omp-provider-mapping.js";
import {
  FileOmpProviderLocalSmokeEvidenceSource,
  MemoryOmpProviderLocalSmokeEvidenceSource,
  OmpProviderEvidenceError,
  parseOmpProviderLocalSmokeEvidence,
  reconcileOmpProviderLocalSmokeEvidence,
  reconcileSerializedOmpProviderLocalSmokeEvidence,
} from "../src/migration/omp-provider-evidence.js";
import {
  assertAssessmentOutputPath,
  writeExclusiveAssessmentArtifacts,
} from "../scripts/lib/omp-provider-evidence-publication.mjs";

const inventorySha256 = "a".repeat(64);
const executableSha256 = "b".repeat(64);

function assessment(overrides: Record<string, unknown> = {}) {
  return assessOmpProviderMappings([parseProviderProfile({
    id: "gateway",
    displayName: "Gateway",
    baseUrl: "https://gateway.invalid/v1",
    apiType: "openai-chat-completions",
    auth: { kind: "bearer", secretRef: "gateway.key" },
    manualModelIds: ["exact-model"],
    ...overrides,
  })]);
}

function passingResult(
  profileSha256: string,
  useTool: boolean,
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: "gateway",
    profileSha256,
    modelId: "exact-model",
    protocol: "openai-chat-completions",
    useTool,
    requests: useTool ? 2 : 1,
    exitCode: 0,
    timedOut: false,
    tooMuchOutput: false,
    wireAssertionFailed: false,
    keyInOutput: false,
    keyOnDisk: false,
    passed: true,
    ...overrides,
  };
}

function reportText(
  current = assessment(),
  overrides: Record<string, unknown> = {},
) {
  const row = current.providers[0]!;
  return JSON.stringify({
    purpose: "loopback-wire-shape-only-not-real-provider-acceptance",
    inventorySha256,
    executableSha256,
    sourceCommit: current.compilerSourceCommit,
    root: "F:\\ProviderDockBuild\\fixture",
    results: [
      passingResult(row.profileSha256, false),
      passingResult(row.profileSha256, true),
    ],
    skipped: [],
    allProfilesAccountedFor: true,
    ...overrides,
  });
}

describe("OMP local provider smoke evidence reconciliation", () => {
  it("binds evidence to the exact serialized inventory bytes", () => {
    const current = assessment();
    const inventoryText = JSON.stringify({ assessment: current });
    const exactInventorySha256 = createHash("sha256").update(inventoryText).digest("hex");
    const text = reportText(current, { inventorySha256: exactInventorySha256 });

    const reconciled = reconcileSerializedOmpProviderLocalSmokeEvidence({
      inventoryText,
      smokeReportText: text,
      executableSha256,
    });

    expect(reconciled.inventorySha256).toBe(exactInventorySha256);
    expect(reconciled.smokeReportSha256).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
    expect(reconciled.launchAuthorized).toBe(false);

    expect(() => reconcileSerializedOmpProviderLocalSmokeEvidence({
      inventoryText: `${inventoryText}\n`,
      smokeReportText: text,
      executableSha256,
    })).toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
  });

  it("clears only the local-smoke gate after both exact fixture cases pass", () => {
    const current = assessment();
    const text = reportText(current);
    const reconciled = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      smokeReportText: text,
      expectedExecutableSha256: executableSha256,
    });

    expect(reconciled).toMatchObject({
      version: 2,
      purpose: "verified-loopback-wire-shape-not-real-provider-acceptance",
      inventorySha256,
      smokeReportSha256: createHash("sha256").update(text).digest("hex"),
      executableSha256,
      sourceCommit: current.compilerSourceCommit,
      launchAuthorized: false,
      providers: [{
        providerId: "gateway",
        profileSha256: current.providers[0]!.profileSha256,
        status: "pending",
        models: [{
          modelId: "exact-model",
          protocols: [{ protocol: "openai-chat-completions", localSmoke: "passed" }],
        }],
      }],
    });
    expect(reconciled.providers[0]!.remainingUnresolved).not.toContain("LOCAL_PROFILE_SMOKE_REQUIRED");
    expect(reconciled.providers[0]!.remainingUnresolved).toEqual(expect.arrayContaining([
      "ACCOUNT_IDENTITY_REQUIRED",
      "ORIGIN_CONFIRMATION_REQUIRED",
      "MODEL_CAPABILITIES_UNVERIFIED",
      "CREDENTIAL_AVAILABILITY_UNVERIFIED",
      "REAL_PILOT_NOT_APPROVED",
    ]));
  });

  it("keeps the gate when the provider is explicitly skipped", () => {
    const current = assessment({ manualModelIds: [] });
    const row = current.providers[0]!;
    const reconciled = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      expectedExecutableSha256: executableSha256,
      smokeReportText: reportText(current, {
        results: [],
        skipped: [{
          providerId: row.providerId,
          profileSha256: row.profileSha256,
          reason: "no-supported-explicit-model-route",
          unresolved: row.unresolved,
        }],
      }),
    });

    expect(reconciled.providers[0]).toMatchObject({
      status: "pending",
      models: [],
      remainingUnresolved: expect.arrayContaining([
        "LOCAL_PROFILE_SMOKE_REQUIRED",
        "MODEL_SELECTION_REQUIRED",
      ]),
    });
    expect(reconciled.launchAuthorized).toBe(false);
  });

  it("keeps local smoke evidence separate for each exact model protocol", () => {
    const current = assessment({ apiType: "auto" });
    const row = current.providers[0]!;
    const text = reportText(current, {
      results: [
        passingResult(row.profileSha256, false, { protocol: "openai-responses" }),
        passingResult(row.profileSha256, true, { protocol: "openai-responses" }),
      ],
    });
    const reconciled = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      smokeReportText: text,
      expectedExecutableSha256: executableSha256,
    });

    expect(reconciled.providers[0]!.models).toEqual([{
      modelId: "exact-model",
      protocols: [
        { protocol: "openai-chat-completions", localSmoke: "missing" },
        { protocol: "openai-responses", localSmoke: "passed" },
        { protocol: "anthropic-messages", localSmoke: "missing" },
      ],
    }]);
  });

  it("rejects duplicate model or protocol rows before producing evidence", () => {
    const current = assessment();
    const row = current.providers[0]!;
    const duplicateModels = { ...current, providers: [{
      ...row, configuredModels: [...row.configuredModels, row.configuredModels[0]!],
    }] };
    const duplicateProtocols = { ...current, providers: [{
      ...row, transportTrials: [...row.transportTrials, row.transportTrials[0]!],
    }] };
    for (const invalid of [duplicateModels, duplicateProtocols]) {
      expect(() => reconcileOmpProviderLocalSmokeEvidence({
        assessment: invalid,
        inventorySha256,
        smokeReportText: reportText(invalid),
        expectedExecutableSha256: executableSha256,
      })).toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
    }
  });

  it("requires both no-tools and read-tool cases for every claimed model", () => {
    const current = assessment();
    const row = current.providers[0]!;
    for (const results of [
      [passingResult(row.profileSha256, false)],
      [passingResult(row.profileSha256, true)],
      [
        passingResult(row.profileSha256, false),
        passingResult(row.profileSha256, false),
      ],
    ]) {
      expect(() => reconcileOmpProviderLocalSmokeEvidence({
        assessment: current,
        inventorySha256,
        expectedExecutableSha256: executableSha256,
        smokeReportText: reportText(current, { results }),
      })).toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
    }
  });

  it("rejects stale or unknown evidence instead of applying it to current profiles", () => {
    const current = assessment();
    const row = current.providers[0]!;
    for (const changes of [
      { inventorySha256: "c".repeat(64) },
      { sourceCommit: "d".repeat(40) },
      { executableSha256: "e".repeat(64) },
      { results: [
        passingResult("f".repeat(64), false),
        passingResult("f".repeat(64), true),
      ] },
      { results: [
        passingResult(row.profileSha256, false, { modelId: "unknown-model" }),
        passingResult(row.profileSha256, true, { modelId: "unknown-model" }),
      ] },
    ]) {
      expect(() => reconcileOmpProviderLocalSmokeEvidence({
        assessment: current,
        inventorySha256,
        expectedExecutableSha256: executableSha256,
        smokeReportText: reportText(current, changes),
      })).toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
    }
  });

  it("rejects any failed, leaking, timed-out or incomplete claimed result", () => {
    const current = assessment();
    const row = current.providers[0]!;
    for (const patch of [
      { passed: false },
      { keyInOutput: true },
      { keyOnDisk: true },
      { timedOut: true },
      { tooMuchOutput: true },
      { wireAssertionFailed: true },
      { exitCode: 1 },
      { requests: 9 },
    ]) {
      expect(() => reconcileOmpProviderLocalSmokeEvidence({
        assessment: current,
        inventorySha256,
        expectedExecutableSha256: executableSha256,
        smokeReportText: reportText(current, {
          results: [
            passingResult(row.profileSha256, false, patch),
            passingResult(row.profileSha256, true),
          ],
        }),
      })).toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
    }
  });

  it("does not expose malformed report content in its fixed error", () => {
    try {
      reconcileOmpProviderLocalSmokeEvidence({
        assessment: assessment(),
        inventorySha256,
        expectedExecutableSha256: executableSha256,
        smokeReportText: '{"PRIVATE_VALUE"',
      });
      throw new Error("expected failure");
    } catch (error) {
      expect(String(error)).toContain("INVALID_LOCAL_SMOKE_EVIDENCE");
      expect(String(error)).not.toContain("PRIVATE_VALUE");
    }
  });

  it("parses evidence snapshots and returns defensive copies", async () => {
    const current = assessment();
    const text = reportText(current);
    const evidence = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      smokeReportText: text,
      expectedExecutableSha256: executableSha256,
    });
    expect(parseOmpProviderLocalSmokeEvidence(evidence)).toEqual(evidence);

    const source = new MemoryOmpProviderLocalSmokeEvidenceSource(evidence);
    const first = await source.get();
    expect(first).toEqual(evidence);
    const models = first!.providers[0]!.models as unknown as Array<{
      protocols: Array<{ localSmoke: string }>;
    }>;
    models[0]!.protocols[0]!.localSmoke = "missing";
    await expect(source.get()).resolves.toEqual(evidence);
  });

  it("treats old version-one evidence as non-authorizing", () => {
    const current = assessment();
    const evidence = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      smokeReportText: reportText(current),
      expectedExecutableSha256: executableSha256,
    });
    try {
      parseOmpProviderLocalSmokeEvidence({ ...evidence, version: 1 });
      throw new Error("expected legacy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OmpProviderEvidenceError);
      expect((error as OmpProviderEvidenceError).code).toBe("LEGACY_LOCAL_SMOKE_EVIDENCE");
    }
  });

  it("reads an evidence snapshot without creating or repairing files", async () => {
    const current = assessment();
    const text = reportText(current);
    const evidence = reconcileOmpProviderLocalSmokeEvidence({
      assessment: current,
      inventorySha256,
      smokeReportText: text,
      expectedExecutableSha256: executableSha256,
    });
    const root = await mkdtemp(join(tmpdir(), "omp-provider-evidence-"));
    const path = join(root, "evidence.json");
    const source = new FileOmpProviderLocalSmokeEvidenceSource(path);

    await expect(source.get()).resolves.toBeUndefined();
    await expect(access(path)).rejects.toBeDefined();
    const serialized = JSON.stringify(evidence);
    await writeFile(path, serialized);
    await expect(source.get()).resolves.toEqual(evidence);
    await expect(readFile(path, "utf8")).resolves.toBe(serialized);

    const privateContent = '{"private":"Bearer sk-secret"';
    await writeFile(path, privateContent);
    await expect(source.get()).rejects.toThrow("INVALID_LOCAL_SMOKE_EVIDENCE");
    await expect(readFile(path, "utf8")).resolves.toBe(privateContent);
  });
});

describe("OMP provider evidence publication helpers", () => {
  it("rejects live migration paths, traversal and relative output paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-evidence-publication-"));

    for (const path of [
      join(root, "migration", "omp-provider-evidence.json"),
      join(root, "omp-route-decisions.json"),
      `${root}\\..\\evidence.json`,
      "relative/evidence.json",
    ]) {
      expect(() => assertAssessmentOutputPath(path)).toThrow(
        "UNSAFE_EVIDENCE_OUTPUT_PATH",
      );
    }
  });

  it("writes both artifacts exclusively and preserves the first publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "omp-evidence-publication-"));
    const output = join(root, "assessment", "evidence.json");
    const verification = join(root, "assessment", "verification.json");
    await mkdir(join(root, "assessment"));

    await writeExclusiveAssessmentArtifacts({
      snapshotPath: output,
      verificationPath: verification,
      snapshotText: '{"launchAuthorized":false}\n',
      verificationText: '{"verified":true}\n',
    });

    await expect(readFile(output, "utf8")).resolves.toBe(
      '{"launchAuthorized":false}\n',
    );
    await expect(readFile(verification, "utf8")).resolves.toBe(
      '{"verified":true}\n',
    );

    await expect(writeExclusiveAssessmentArtifacts({
      snapshotPath: output,
      verificationPath: verification,
      snapshotText: '{"launchAuthorized":true}\n',
      verificationText: '{"verified":false}\n',
    })).rejects.toThrow("EVIDENCE_OUTPUT_EXISTS");

    await expect(readFile(output, "utf8")).resolves.toBe(
      '{"launchAuthorized":false}\n',
    );
    await expect(access(`${output}.tmp`)).rejects.toBeDefined();
  });
});
