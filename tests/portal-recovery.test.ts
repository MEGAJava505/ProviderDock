import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { inventoryMigrationSource, type MigrationSourcePolicy } from "../src/migration/migration-manifest.js";
import { portalRecordSchema } from "../src/core/portals/portal-types.js";
import {
  acceptStagedPortalRecovery, dryRunPortalRecovery, stagePortalRecovery, type PortalRecoveryInput,
} from "../src/migration/portal-recovery.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("portal-recovery-")) {
      throw new Error("Unsafe test cleanup");
    }
    await rm(target, { recursive: true, force: true });
  }
});

const connection = {
  providerId: "one", adapterId: "new-api", siteUrl: "https://one.invalid",
  auth: { kind: "bearer", secretRef: "ACCOUNT_TOKEN" }, userId: 42,
};
const fixtureCorruptByteLength = 257;
const backup = {
  version: 2,
  records: [{ connection, revision: "76d2fe1c-5766-4413-afce-fab0239f609b", failures: 3,
    nextRefreshAt: "2026-09-15T01:00:00.000Z" }],
};

async function fixture(options: { readonly nulBackupByteLength?: number } = {}) {
  const base = await mkdtemp(join(tmpdir(), "portal-recovery-"));
  temporaryRoots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  await writeFile(join(root, "accounts.json"), Buffer.alloc(fixtureCorruptByteLength));
  await writeFile(join(root, "backup.json"), JSON.stringify(backup));
  await writeFile(
    join(root, "nul-backup.json"),
    Buffer.alloc(options.nulBackupByteLength ?? fixtureCorruptByteLength),
  );
  await writeFile(join(root, "providers.json"), JSON.stringify([
    { id: "one", displayName: "One", baseUrl: "https://one.invalid" },
  ]));
  await writeFile(join(root, "protected.bin"), "synthetic-protected-bytes");
  const source: MigrationSourcePolicy = { root, files: [
    { relativePath: "accounts.json", kind: "portal-metadata" },
    { relativePath: "backup.json", kind: "portal-metadata" },
    { relativePath: "nul-backup.json", kind: "portal-metadata" },
    { relativePath: "providers.json", kind: "provider-metadata" },
    { relativePath: "protected.bin", kind: "protected-secret" },
  ] };
  const input: PortalRecoveryInput = {
    source, manifest: await inventoryMigrationSource(source), activeRelativePath: "accounts.json",
    evidence: {
      providerMetadataPath: "providers.json", knownAdapterIds: ["new-api"],
      secretFiles: [{ reference: "ACCOUNT_TOKEN", relativePath: "protected.bin" }],
    },
    recovery: { kind: "connections", connections: [connection] },
  };
  return { base, root, input };
}

describe("portal recovery dry-run", () => {
  it("accepts a verified valid backup but rejects a 280047-byte NUL backup, missing backup or active-file alias", async () => {
    const { input } = await fixture({ nulBackupByteLength: 280_047 });
    expect(await dryRunPortalRecovery({
      ...input, recovery: { kind: "backup", relativePath: "backup.json" },
    })).toMatchObject({ status: "ready", source: "backup", connectionCount: 1 });
    for (const relativePath of ["nul-backup.json", "missing.json", "../backup.json", "protected.bin", "accounts.json"]) {
      const report = await dryRunPortalRecovery({ ...input, recovery: { kind: "backup", relativePath } });
      expect(report.status).toBe("blocked");
      expect(report.issues).toContainEqual({ code: "INVALID_BACKUP", severity: "error" });
    }
  });

  it.each([
    [{ version: 2, records: [] }, "EMPTY_RECOVERY"],
    [{ version: 1, records: [] }, "EMPTY_RECOVERY"],
    [{ version: 7, records: [] }, "INVALID_BACKUP"],
    [{ version: 2, records: [...backup.records, ...backup.records] }, "INVALID_BACKUP"],
    [{ version: 2, records: [{ ...backup.records[0], revision: "bad" }] }, "INVALID_BACKUP"],
    [{ version: 2, records: [{ ...backup.records[0], connection: { ...connection, adapterId: undefined } }] }, "INVALID_CONNECTION"],
  ])("rejects an empty or invalid backup without silently dropping records (%s)", async (value, code) => {
    const { root, input } = await fixture();
    await writeFile(join(root, "backup.json"), JSON.stringify(value));
    const report = await dryRunPortalRecovery({
      ...input, manifest: await inventoryMigrationSource(input.source),
      recovery: { kind: "backup", relativePath: "backup.json" },
    });
    expect(report.status).toBe("blocked");
    expect(report.issues.map((issue) => issue.code)).toContain(code);
  });

  it("accepts legacy durable connections without trusting obsolete observations", async () => {
    const { root, input } = await fixture();
    await writeFile(join(root, "backup.json"), JSON.stringify({
      version: 1, records: [{ ...backup.records[0], latest: { obsolete: true } }],
    }));
    expect(await dryRunPortalRecovery({
      ...input, manifest: await inventoryMigrationSource(input.source),
      recovery: { kind: "backup", relativePath: "backup.json" },
    })).toMatchObject({ status: "ready", connectionCount: 1 });
  });

  it.each([
    [{ ...connection, providerId: "unknown" }, "UNKNOWN_PROVIDER"],
    [{ ...connection, adapterId: "unknown" }, "UNKNOWN_ADAPTER"],
    [{ ...connection, auth: { kind: "bearer", secretRef: "UNKNOWN" } }, "UNKNOWN_SECRET_REFERENCE"],
    [{ ...connection, siteUrl: undefined }, "INVALID_CONNECTION"],
    [{ ...connection, adapterId: undefined }, "INVALID_CONNECTION"],
    [{ ...connection, auth: undefined }, "INVALID_CONNECTION"],
    [{ ...connection, auth: { kind: "bearer" } }, "INVALID_CONNECTION"],
    [{ ...connection, siteUrl: "https://one.invalid/?token=DO-NOT-REPORT" }, "INVALID_CONNECTION"],
    [{ ...connection, password: "DO-NOT-REPORT" }, "INVALID_CONNECTION"],
  ])("blocks unresolved or unsafe connection metadata without guessing (%s)", async (candidate, code) => {
    const { root, input } = await fixture();
    const report = await dryRunPortalRecovery({ ...input, recovery: { kind: "connections", connections: [candidate] } });
    expect(report.status).toBe("blocked");
    expect(report.issues).toContainEqual({ code, severity: "error", recordIndex: 0 });
    expect(JSON.stringify(report)).not.toContain("DO-NOT-REPORT");
    expect(await readFile(join(root, "accounts.json"))).toEqual(Buffer.alloc(fixtureCorruptByteLength));
  });

  it("reports an unknown optional userId rather than inventing an account identity", async () => {
    const { input } = await fixture();
    const { userId: _, ...unknownUser } = connection;
    const report = await dryRunPortalRecovery({
      ...input, recovery: { kind: "connections", connections: [unknownUser] },
    });
    expect(report.status).toBe("ready");
    expect(report.issues).toEqual([{ code: "UNKNOWN_USER_ID", severity: "warning", recordIndex: 0 }]);
  });

  it("blocks an explicit empty reset and duplicate provider connections", async () => {
    const { input } = await fixture();
    const empty = await dryRunPortalRecovery({ ...input, recovery: { kind: "connections", connections: [] } });
    expect(empty.status).toBe("blocked");
    expect(empty.issues).toContainEqual({ code: "EMPTY_RECOVERY", severity: "error" });
    const duplicates = await dryRunPortalRecovery({
      ...input, recovery: { kind: "connections", connections: [connection, connection] },
    });
    expect(duplicates.status).toBe("blocked");
    expect(duplicates.issues).toContainEqual({ code: "DUPLICATE_PROVIDER", severity: "error", recordIndex: 1 });
  });

  it("requires provider and protected-secret evidence of the correct kind, not just known-looking references", async () => {
    const { input } = await fixture();
    for (const path of ["missing.bin", "backup.json", "../escape"]) {
      const report = await dryRunPortalRecovery({ ...input, evidence: {
        ...input.evidence, secretFiles: [{ reference: "ACCOUNT_TOKEN", relativePath: path }],
      } });
      expect(report.status).toBe("blocked");
      expect(report.issues).toContainEqual({ code: "MISSING_SECRET_EVIDENCE", severity: "error", recordIndex: 0 });
    }
    for (const path of ["missing.json", "backup.json", "../escape"]) {
      const report = await dryRunPortalRecovery({
        ...input, evidence: { ...input.evidence, providerMetadataPath: path },
      });
      expect(report.status).toBe("blocked");
      expect(report.issues).toContainEqual({ code: "INVALID_PROVIDER_EVIDENCE", severity: "error" });
    }
    const missingActive = await dryRunPortalRecovery({ ...input, activeRelativePath: "missing.json" });
    expect(missingActive.status).toBe("blocked");
    expect(missingActive.issues).toContainEqual({ code: "MISSING_ACTIVE_EVIDENCE", severity: "error" });
  });

  it("uses explicit connections and manifest-backed references, reporting readiness without writes or automatic acceptance", async () => {
    const { root, input } = await fixture();
    const names = await readdir(root);
    expect(await dryRunPortalRecovery(input)).toEqual({
      status: "ready", source: "connections", connectionCount: 1, issues: [],
      requiresOperatorAcceptance: true, activeReplaced: false, refreshDisabled: true,
    });
    expect(await readdir(root)).toEqual(names);
    expect(await readFile(join(root, "accounts.json"))).toEqual(Buffer.alloc(fixtureCorruptByteLength));
    expect(await readFile(join(root, "protected.bin"), "utf8")).toBe("synthetic-protected-bytes");
  });
});

describe("portal recovery staging", () => {
  it("rejects an explicit empty recovery or unresolved mapping without creating a staged file", async () => {
    const { base, root, input } = await fixture();
    const destination = join(base, "recovered.staged.json");
    for (const connections of [[], [{ ...connection, providerId: "unknown" }]]) {
      await expect(stagePortalRecovery({ ...input, recovery: { kind: "connections", connections } }, destination))
        .rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    }
    await expect(stagePortalRecovery({
      ...input, recovery: { kind: "backup", relativePath: "nul-backup.json" },
    }, destination)).rejects.toMatchObject({ code: "RECOVERY_BLOCKED" });
    expect(await readdir(base)).toEqual(["source"]);
    expect(await readFile(join(root, "accounts.json"))).toEqual(Buffer.alloc(fixtureCorruptByteLength));
  });

  it("exclusively creates the staged file, allowing only one of two simultaneous writers", async () => {
    const { base, input } = await fixture();
    const destination = join(base, "recovered.staged.json");
    const results = await Promise.allSettled([
      stagePortalRecovery(input, destination), stagePortalRecovery(input, destination),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "DESTINATION_EXISTS" } });
    const before = await readFile(destination);
    await expect(stagePortalRecovery(input, destination)).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
    expect(await readFile(destination)).toEqual(before);
  });

  it("refuses active, nested, traversal, ADS and junction destinations", async () => {
    const { base, root, input } = await fixture();
    await symlink(root, join(base, "alias"), "junction");
    for (const destination of [
      join(root, "accounts.json"), join(root, "staged.json"), join(base, "alias", "staged.json"),
      "relative.json", `${base}/source/../escape.json`, join(base, "stage.json:stream"),
    ]) {
      await expect(stagePortalRecovery(input, destination)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    }
    expect(await readdir(root)).toEqual(["accounts.json", "backup.json", "nul-backup.json", "protected.bin", "providers.json"]);
  });

  it("rechecks manifest evidence after dry-run and refuses changed or missing protected bytes", async () => {
    const { base, root, input } = await fixture();
    expect((await dryRunPortalRecovery(input)).status).toBe("ready");
    await writeFile(join(root, "protected.bin"), "changed-protected-bytes");
    await expect(stagePortalRecovery(input, join(base, "changed.json"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    await rm(join(root, "protected.bin"));
    await expect(stagePortalRecovery(input, join(base, "missing.json"))).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await readdir(base)).toEqual(["source"]);
  });

  it("leaves unknown userId absent in the staged records and reports it for operator review", async () => {
    const { base, input } = await fixture();
    const { userId: _, ...unknownUser } = connection;
    const destination = join(base, "unknown-user.json");
    const result = await stagePortalRecovery({
      ...input, recovery: { kind: "connections", connections: [unknownUser] },
    }, destination);
    expect(result.report.issues).toContainEqual({ code: "UNKNOWN_USER_ID", severity: "warning", recordIndex: 0 });
    expect(JSON.parse(await readFile(destination, "utf8")).records[0].connection).not.toHaveProperty("userId");
  });

  it("does not accept malformed or ambiguous runtime input or expose its values in errors", async () => {
    const { base, input } = await fixture();
    const invalidInputs = [
      { ...input, recovery: { kind: "automatic-reset" } },
      { ...input, recovery: { kind: "backup", relativePath: "backup.json", connections: [] } },
      { ...input, evidence: { ...input.evidence, knownAdapterIds: undefined } },
      { ...input, evidence: { ...input.evidence, secretFiles: [...input.evidence.secretFiles, ...input.evidence.secretFiles] } },
      { ...input, password: "DO-NOT-REPORT" },
    ];
    for (const invalid of invalidInputs) {
      await expect(stagePortalRecovery(invalid as PortalRecoveryInput, join(base, "staged.json")))
        .rejects.toMatchObject({ code: "INVALID_RECOVERY_INPUT", message: "INVALID_RECOVERY_INPUT" });
    }
    expect(await readdir(base)).toEqual(["source"]);
  });

  it.each(["connections", "backup"] as const)("stages %s as version 2 with empty observations, preserves all originals and disables refresh", async (kind) => {
    const { root, base, input } = await fixture();
    const paths = await readdir(root);
    const before = await Promise.all(paths.map((path) => readFile(join(root, path))));
    const destination = join(base, "recovered.staged.json");
    const result = await stagePortalRecovery({
      ...input, recovery: kind === "connections" ? input.recovery : { kind, relativePath: "backup.json" },
    }, destination);
    expect(result.report).toMatchObject({ status: "ready", requiresOperatorAcceptance: true, activeReplaced: false });
    const raw = await readFile(destination, "utf8");
    const document = JSON.parse(raw);
    expect(document.version).toBe(2);
    expect(document.records).toHaveLength(1);
    const record = portalRecordSchema.parse(document.records[0]);
    expect(record.connection).toMatchObject({ ...connection, autoRefresh: false });
    expect(record.failures).toBe(0);
    expect(record.revision).not.toBe(backup.records[0]!.revision);
    expect(Object.keys(record).sort()).toEqual(["connection", "failures", "revision"]);
    expect(result.stagedFile).toMatchObject({ byteLength: Buffer.byteLength(raw), validation: "valid" });
    expect(result.stagedFile.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await readdir(root)).toEqual(paths);
    expect(await Promise.all(paths.map((path) => readFile(join(root, path))))).toEqual(before);
  });
});

describe("portal recovery acceptance", () => {
  it("preserves the exact active bytes before atomically accepting the validated stage", async () => {
    const { base, root, input } = await fixture();
    const stagedPath = join(base, "recovered.staged.json");
    const staged = await stagePortalRecovery(input, stagedPath);
    const original = await readFile(join(root, "accounts.json"));
    const backupDestination = join(base, "accepted-backup");

    const result = await acceptStagedPortalRecovery({
      recovery: input,
      stagedPath,
      stagedFile: staged.stagedFile,
      backupDestination,
      operatorAccepted: true,
    });

    expect(result).toMatchObject({
      status: "accepted", connectionCount: 1, activeReplaced: true,
      requiresOperatorAcceptance: false, refreshDisabled: true,
    });
    expect(await readFile(join(backupDestination, "accounts.json"))).toEqual(original);
    const active = JSON.parse(await readFile(join(root, "accounts.json"), "utf8"));
    expect(active).toEqual(JSON.parse(await readFile(stagedPath, "utf8")));
    expect(portalRecordSchema.parse(active.records[0]).connection)
      .toMatchObject({ ...connection, autoRefresh: false });
  });

  it.each([
    ["missing operator acceptance", "OPERATOR_ACCEPTANCE_REQUIRED"],
    ["changed staged bytes", "STAGE_CHANGED"],
    ["stage for a different connection", "STAGE_MISMATCH"],
    ["changed active bytes", "SOURCE_CHANGED"],
    ["existing backup destination", "DESTINATION_EXISTS"],
  ] as const)("leaves active bytes unchanged for %s", async (scenario, code) => {
    const { base, root, input } = await fixture();
    const stagedPath = join(base, "recovered.staged.json");
    let staged = await stagePortalRecovery(input, stagedPath);
    const activePath = join(root, "accounts.json");
    let expectedActive = await readFile(activePath);
    const backupDestination = join(base, "accepted-backup");
    let operatorAccepted = true;

    if (scenario === "missing operator acceptance") operatorAccepted = false;
    if (scenario === "changed staged bytes") await writeFile(stagedPath, JSON.stringify(backup));
    if (scenario === "stage for a different connection") {
      const differentPath = join(base, "different.staged.json");
      staged = await stagePortalRecovery({
        ...input,
        recovery: { kind: "connections", connections: [{ ...connection, userId: 43 }] },
      }, differentPath);
      await rm(stagedPath);
      await writeFile(stagedPath, await readFile(differentPath));
      staged = { ...staged, stagedFile: { ...staged.stagedFile, relativePath: "recovered.staged.json" } };
    }
    if (scenario === "changed active bytes") {
      await writeFile(activePath, "changed-active-bytes");
      expectedActive = await readFile(activePath);
    }
    if (scenario === "existing backup destination") await mkdir(backupDestination);

    await expect(acceptStagedPortalRecovery({
      recovery: input,
      stagedPath,
      stagedFile: staged.stagedFile,
      backupDestination,
      operatorAccepted,
    })).rejects.toMatchObject({ code, message: code });
    expect(await readFile(activePath)).toEqual(expectedActive);
  });

  it("refuses to replace a healthy active catalog with a recovery subset", async () => {
    const { base, root, input } = await fixture();
    const activePath = join(root, "accounts.json");
    await writeFile(activePath, JSON.stringify(backup));
    const healthyInput = { ...input, manifest: await inventoryMigrationSource(input.source) };
    const stagedPath = join(base, "recovered.staged.json");
    const staged = await stagePortalRecovery(healthyInput, stagedPath);
    const before = await readFile(activePath);

    await expect(acceptStagedPortalRecovery({
      recovery: healthyInput,
      stagedPath,
      stagedFile: staged.stagedFile,
      backupDestination: join(base, "accepted-backup"),
      operatorAccepted: true,
    })).rejects.toMatchObject({ code: "ACTIVE_NOT_CORRUPT", message: "ACTIVE_NOT_CORRUPT" });
    expect(await readFile(activePath)).toEqual(before);
    expect(await readdir(base)).toEqual(["recovered.staged.json", "source"]);
  });

  it("captures the accepted stage and backup destination before the first await", async () => {
    const { base, input } = await fixture();
    const stagedPath = join(base, "recovered.staged.json");
    const staged = await stagePortalRecovery(input, stagedPath);
    const acceptedBackup = join(base, "accepted-backup");
    const substitutedBackup = join(base, "substituted-backup");
    const acceptance = {
      recovery: input,
      stagedPath,
      stagedFile: staged.stagedFile,
      backupDestination: acceptedBackup,
      operatorAccepted: true,
    };

    const pending = acceptStagedPortalRecovery(acceptance);
    acceptance.backupDestination = substitutedBackup;
    await pending;

    expect(await readFile(join(acceptedBackup, "accounts.json")))
      .toEqual(Buffer.alloc(fixtureCorruptByteLength));
    expect(await readdir(base)).not.toContain("substituted-backup");
  });
});
