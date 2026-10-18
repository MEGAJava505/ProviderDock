// Run after `npm run build`. End-to-end backup/recovery rehearsal on isolated temporary fixture roots.
// No provider calls, no network, no real user vault/profiles/OMP/browser profile. DPAPI is used ONLY to
// protect NEW fictional values on the healthy Windows branch; if native DPAPI is unavailable those facts
// are reported BLOCKED (never fallback-as-PASS). Secrets and the backup passphrase are generated in memory,
// passed via an injected reader, and never printed, logged, or written to argv/report. One JSON result on stdout.
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { ProviderDockApplication } from "../dist/application/provider-dock-application.js";
import { ProviderProbeService } from "../dist/core/health/provider-probe-service.js";
import { ProviderAdapterRegistry } from "../dist/core/providers/provider-adapter-registry.js";
import { FileProviderProfileRepository } from "../dist/core/providers/provider-profile-repository.js";
import { FilePortalRepository } from "../dist/core/portals/portal-repository.js";
import { portalRecordSchema } from "../dist/core/portals/portal-types.js";
import { WindowsDpapiProtector, DpapiFileSecretVault, SecretProtectionError } from "../dist/core/security/dpapi-secret-vault.js";
import { FileCredentialMetadataRepository, MemoryCredentialMetadataRepository } from "../dist/core/security/credential-repository.js";
import { CredentialManager } from "../dist/core/security/credential-manager.js";
import { ApplicationCredentialBindings } from "../dist/core/security/credential-bindings.js";
import { runProviderDockCli } from "../dist/cli/provider-dock-cli.js";
import { inventoryMigrationSource } from "../dist/migration/migration-manifest.js";
import { dryRunPortalRecovery, stagePortalRecovery, acceptStagedPortalRecovery } from "../dist/migration/portal-recovery.js";

const createdRoots = [];
const checks = [];
const record = (name, status, detail) => checks.push(detail === undefined ? { name, status } : { name, status, detail });

// Fictional values + backup passphrase live only in memory and are treated as canaries for the leak scan.
const secretValues = {
  alphaApi: `fixture-alpha-api-${randomUUID()}`,
  betaApi: `fixture-beta-api-${randomUUID()}`,
  portalCookie: `fixture-portal-cookie-${randomUUID()}`,
};
const passphrase = randomBytes(24).toString("base64url");
const canaries = [secretValues.alphaApi, secretValues.betaApi, secretValues.portalCookie, passphrase];

// CLI is exercised with an INJECTED passphrase reader; stdout/stderr are captured internally and never
// echoed into the JSON result (the CLI backup message would otherwise carry an absolute fixture path).
const cliOut = [];
const cliErr = [];
const io = { stdout: (line) => cliOut.push(line), stderr: (line) => cliErr.push(line) };
async function runCli(argv, application, reader = async () => passphrase) {
  const out0 = cliOut.length;
  const err0 = cliErr.length;
  const code = await runProviderDockCli(argv, {
    application,
    io,
    environment: {},
    credentialPassphraseReader: reader,
  });
  return { code, out: cliOut.slice(out0), err: cliErr.slice(err0) };
}

// Build a ProviderDockApplication whose only wired seam is the credential manager (arg 18).
function makeApp(profiles, credentials) {
  const probes = new ProviderProbeService(new ProviderAdapterRegistry());
  return new ProviderDockApplication(
    profiles, probes,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    credentials,
  );
}

async function expectReject(run, expectedCode) {
  try {
    await run();
    return false;
  } catch (error) {
    return error?.code === expectedCode;
  }
}

function makeManager(profiles, portals, vault, metadata) {
  return new CredentialManager({
    secrets: vault,
    metadata,
    bindings: new ApplicationCredentialBindings(profiles, portals),
    idFactory: () => randomUUID(),
    now: () => new Date(),
  });
}

async function probeDpapi() {
  const protector = new WindowsDpapiProtector();
  // Fixture-only rehearsal hook for the persistent --negative runner: force the "no native DPAPI" branch WITHOUT
  // touching the real Windows profile or master key (protect/unprotect are never called). Proves a BLOCKED
  // credential branch can never report sourcePreserved/ok:true. Inert unless the env flag is set.
  if (process.env.SMOKE_MUTATE === "dpapi-unavailable") {
    return { protector, available: false, note: "forced-unavailable (fixture-only rehearsal; real profile/master key untouched)" };
  }
  try {
    const probe = `dpapi-probe-${randomUUID()}`;
    const sealed = await protector.protect(probe);
    const opened = await protector.unprotect(sealed);
    const available = opened === probe && sealed !== probe;
    return { protector, available, note: available ? "native DPAPI round-trip verified" : "round-trip mismatch" };
  } catch {
    return { protector, available: false, note: "native DPAPI unavailable on this host" };
  }
}

// Read errors we tolerate as an ALLOWLISTED code (never a raw path/message) while scanning fixture space.
const SCAN_ALLOWED_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "EBUSY", "ELOOP", "EMFILE"]);

// A content-addressed snapshot of a directory tree: sha256 per file, keyed by POSIX-relative path. Symlinks
// are NOT followed (they are recorded as an unreadable marker). Used to prove source bytes never drift.
async function snapshotTree(root) {
  const snapshot = new Map();
  async function walk(dir, rel) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, entry.name);
      const relPath = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) { snapshot.set(relPath, "symlink:not-followed"); continue; }
      if (entry.isDirectory()) { await walk(abs, relPath); continue; }
      if (!entry.isFile()) continue;
      snapshot.set(relPath, createHash("sha256").update(await readFile(abs)).digest("hex"));
    }
  }
  await walk(root, "");
  return snapshot;
}

function treesEqual(before, after) {
  if (before.size !== after.size) return false;
  for (const [key, value] of before) if (after.get(key) !== value) return false;
  return true;
}

// Compare a single root's before/after snapshot for byte preservation. Every original file must remain, with
// identical bytes, EXCEPT the POSIX-relative paths in `allowedChanged` (e.g. the active catalog a positive
// recovery is permitted to replace). No file may be added to or removed from the root — stage files and operator
// backups are written OUTSIDE the source root — so a differing key set is itself a preservation failure. This
// replaces selective per-file comparisons that silently ignored files such as providers.json/backup.json.
function sourceRootPreserved(before, after, allowedChanged) {
  if (before.size !== after.size) return false;
  for (const key of before.keys()) if (!after.has(key)) return false;
  for (const [key, value] of before) {
    if (allowedChanged.has(key)) continue;
    if (after.get(key) !== value) return false;
  }
  return true;
}

// A safe, secret-free projection of any thrown cause: an allowlisted code when present, else a fixed marker.
// Never returns the raw message (which may embed a fixture path) or any secret material.
function safeCause(error) {
  const code = error?.code;
  if (typeof code === "string" && SCAN_ALLOWED_CODES.has(code)) return code;
  return "unexpected-error";
}

async function runCredentialBranch(dpapi) {
  // `sourceBytesStable` starts UNDEFINED, not `true`: a branch that never runs must claim NOTHING about source
  // preservation. `blocked` records that the DPAPI-backed rehearsal was skipped, so the overall verdict can refuse
  // to report sourcePreserved/ok:true for an unexecuted branch (a BLOCKED result is never a silent PASS).
  const flags = { blocked: false, apiKeyPreservation: false, metadataRecovery: false, sourceBytesStable: undefined };
  if (!dpapi.available) {
    for (const name of [
      "source-seed", "healthy-dpapi-backup", "context-loss-preserves-records",
      "restore-api-key-preservation", "restore-metadata-recovery", "restore-no-foreign-activation",
      "restore-additive", "restore-safe-refusal", "restore-partial-accounting",
    ]) record(name, "BLOCKED", "native DPAPI unavailable; DPAPI-backed facts not run (no fallback)");
    flags.blocked = true;
    return flags;
  }

  const base = await mkdtemp(join(tmpdir(), "credential-recovery-smoke-"));
  createdRoots.push(base);
  const sourceRoot = join(base, "source");
  const targetRoot = join(base, "target");
  const refusedRoot = join(base, "target-refused");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });
  await mkdir(refusedRoot, { recursive: true });

  const sourceRegistryPath = join(sourceRoot, "registry.json");
  const targetRegistryPath = join(targetRoot, "registry.json");
  const backupPath = join(base, "credential-backup.pdv");

  // Source root: file registry + profile + portal + DPAPI vault, all wired together.
  const sourceProfiles = new FileProviderProfileRepository(join(sourceRoot, "providers.json"));
  const sourcePortals = new FilePortalRepository(join(sourceRoot, "portals.json"));
  const sourceVault = new DpapiFileSecretVault(join(sourceRoot, "vault"), dpapi.protector);
  const sourceRegistry = new FileCredentialMetadataRepository(sourceRegistryPath);
  const sourceManager = makeManager(sourceProfiles, sourcePortals, sourceVault, sourceRegistry);

  // Pre-seed the binding surfaces so activation has something to reference.
  await sourceProfiles.upsert({ id: "alpha", displayName: "Alpha", baseUrl: "https://alpha.invalid",
    auth: { kind: "bearer", secretRef: "SEED_ALPHA" } });
  await sourceProfiles.upsert({ id: "beta", displayName: "Beta", baseUrl: "https://beta.invalid",
    auth: { kind: "bearer", secretRef: "SEED_BETA" } });
  await sourcePortals.update("alpha", () => portalRecordSchema.parse({
    connection: { providerId: "alpha", adapterId: "new-api", siteUrl: "https://alpha.invalid",
      auth: { kind: "cookie", secretRef: "SEED_PORTAL" }, userId: 7 },
    revision: randomUUID(), failures: 0,
  }));

  // Two API credentials + one separate portal-session credential, activated onto their bindings.
  await sourceManager.add({ providerId: "alpha", purpose: "provider-api", value: secretValues.alphaApi, activate: true });
  await sourceManager.add({ providerId: "beta", purpose: "provider-api", value: secretValues.betaApi, activate: true });
  await sourceManager.add({ providerId: "alpha", purpose: "portal-session", value: secretValues.portalCookie, activate: true });
  const sourceApp = makeApp(sourceProfiles, sourceManager);

  const seeded = await sourceManager.list();
  const activeCount = seeded.filter((s) => s.state === "active").length;
  record("source-seed", seeded.length === 3 && seeded.every((s) => s.state !== "unavailable") ? "PASS" : "FAIL",
    `three credentials seeded (${activeCount} active) across file registry/profile/portal/DPAPI vault`);

  // Byte baseline: a content hash of EVERY seeded source file (registry/profile/portal/DPAPI vault), captured
  // now — after seeding, before any backup/loss/restore. The recovery flow reads the source and writes only to
  // separate target/refused/partial roots, so these bytes must be identical when the branch ends.
  const sourceSnapshot = await snapshotTree(sourceRoot);

  // Backup is created BEFORE any simulated context loss, through the CLI + injected passphrase reader.
  const backup = await runCli(["credentials", "backup", "--file", backupPath], sourceApp);
  const backupOk = backup.code === 0 && backup.out.some((l) => l.includes("3 included, 0 unavailable skipped"));
  record("healthy-dpapi-backup", backupOk ? "PASS" : "FAIL",
    "CLI backup via injected reader: 3 included, 0 skipped");

  // Simulated context loss: a new vault over the SAME files whose protector can no longer unprotect.
  const lostProtector = {
    async protect() { throw new SecretProtectionError("fixture protector is write-blocked"); },
    async unprotect() { throw new SecretProtectionError("fixture context loss: master key unavailable"); },
  };
  const lostManager = makeManager(sourceProfiles, sourcePortals,
    new DpapiFileSecretVault(join(sourceRoot, "vault"), lostProtector), sourceRegistry);
  const afterLoss = await lostManager.list();
  const lostBackupPath = join(base, "after-loss.pdv");
  const lostReport = await lostManager.createBackup(lostBackupPath, passphrase);
  const lossHonest = afterLoss.length === 3 && afterLoss.every((s) => s.state === "unavailable") &&
    (await sourceRegistry.list()).length === 3 && lostReport.included === 0 && lostReport.skipped === 3;
  record("context-loss-preserves-records", lossHonest ? "PASS" : "FAIL",
    "unreadable vault → summaries unavailable, registry intact, post-loss backup empty");

  // Restore into a FRESH target root (its own registry/profile/portal/DPAPI vault), via CLI + injected reader.
  const targetProfiles = new FileProviderProfileRepository(join(targetRoot, "providers.json"));
  const targetPortals = new FilePortalRepository(join(targetRoot, "portals.json"));
  const targetVault = new DpapiFileSecretVault(join(targetRoot, "vault"), dpapi.protector);
  const targetRegistry = new FileCredentialMetadataRepository(targetRegistryPath);
  const targetManager = makeManager(targetProfiles, targetPortals, targetVault, targetRegistry);
  const targetApp = makeApp(targetProfiles, targetManager);

  const restore1 = await runCli(["credentials", "restore", "--file", backupPath], targetApp);
  const restore1Ok = restore1.code === 0 && restore1.out.some((l) => l.includes("Restored 3 credential(s); skipped 0"));

  // Fact A: API-key values round-trip through the portable backup into the fresh DPAPI vault (values never shown).
  const refs = await targetManager.listManagedReferences();
  const recovered = [];
  for (const ref of refs) recovered.push(await targetManager.get(ref));
  const recoveredSet = new Set(recovered);
  flags.apiKeyPreservation = restore1Ok && recovered.length === 3 &&
    recoveredSet.has(secretValues.alphaApi) && recoveredSet.has(secretValues.betaApi) &&
    recoveredSet.has(secretValues.portalCookie);
  record("restore-api-key-preservation", flags.apiKeyPreservation ? "PASS" : "FAIL",
    "two API keys + portal cookie recovered by value into a fresh DPAPI vault");

  // Fact B: metadata (providerId/purpose) recovered as available; nothing re-activated.
  const restored = await targetManager.list();
  flags.metadataRecovery = restored.length === 3 && restored.every((s) => s.state === "available") &&
    new Set(restored.map((s) => `${s.providerId}:${s.purpose}`)).size === 3;
  record("restore-metadata-recovery", flags.metadataRecovery ? "PASS" : "FAIL",
    "records recovered as available; providerId/purpose intact");

  const noForeignActivation = (await targetProfiles.list()).length === 0 && (await targetPortals.list()).length === 0;
  record("restore-no-foreign-activation", noForeignActivation ? "PASS" : "FAIL",
    "restore fabricated no provider profiles or portal bindings");

  // --- M4-R.3: finish the user-path — real CLI list, explicit fixture activation, resolveActive in memory ----
  // (a) Real CLI `credentials list --json` after restore: masked shape only (providerId/purpose/state/mask),
  // never plaintext; target bindings are still empty before any explicit activation.
  const listRun = await runCli(["credentials", "list", "--json"], targetApp);
  let listed = [];
  try { listed = JSON.parse(listRun.out.join("\n")); } catch { listed = []; }
  const listShapeOk = listRun.code === 0 && Array.isArray(listed) && listed.length === 3 &&
    listed.every((s) =>
      typeof s.id === "string" && typeof s.providerId === "string" &&
      (s.purpose === "provider-api" || s.purpose === "portal-session") &&
      s.state === "available" && typeof s.maskedValue === "string" && !("value" in s));
  const listText = listRun.out.join("\n");
  const listNoPlaintext = recovered.every((secret) => !listText.includes(secret));
  const bindingsEmptyPreActivation =
    (await targetProfiles.list()).length === 0 && (await targetPortals.list()).length === 0;
  record("restore-cli-list-masked", listShapeOk && listNoPlaintext && bindingsEmptyPreActivation ? "PASS" : "FAIL",
    "CLI list --json: providerId/purpose/state/mask only, no plaintext, target bindings empty pre-activation");

  // Source binding refs as they stand AFTER seeding (seeding activated onto them, so they hold credential refs,
  // not the SEED_* placeholders). Target-side activation must leave every one of these byte-for-byte unchanged.
  const sourceApiRefBefore = (await sourceProfiles.get("alpha"))?.auth.secretRef;
  const sourceBetaRefBefore = (await sourceProfiles.get("beta"))?.auth.secretRef;
  const sourcePortalRefBefore = (await sourcePortals.get("alpha"))?.connection.auth.secretRef;

  // (b) Create EXPLICIT fixture profile + portal placeholders, pick recovered IDs by provider/purpose, and
  // activate through the REAL CLI. resolveActive returns DECRYPTED PLAINTEXT — compared ONLY in memory here.
  const apiPick = listed.find((s) => s.providerId === "alpha" && s.purpose === "provider-api");
  const portalPick = listed.find((s) => s.providerId === "alpha" && s.purpose === "portal-session");
  await targetProfiles.upsert({ id: "alpha", displayName: "Alpha", baseUrl: "https://alpha.invalid",
    auth: { kind: "bearer", secretRef: "TARGET_PLACEHOLDER_API" } });
  await targetPortals.update("alpha", () => portalRecordSchema.parse({
    connection: { providerId: "alpha", adapterId: "new-api", siteUrl: "https://alpha.invalid",
      auth: { kind: "cookie", secretRef: "TARGET_PLACEHOLDER_PORTAL" }, userId: 7 },
    revision: randomUUID(), failures: 0,
  }));

  const activateApi = await runCli(["credentials", "activate", "--provider", "alpha",
    "--purpose", "provider-api", "--credential", apiPick?.id ?? "MISSING"], targetApp);
  const activatePortal = await runCli(["credentials", "activate", "--provider", "alpha",
    "--purpose", "portal-session", "--credential", portalPick?.id ?? "MISSING"], targetApp);
  // __M4R3_ACTIVATION_ASSERT__

  // resolveActive decrypts the active credential; equality is checked in memory and never printed/recorded.
  const apiActive = await targetManager.resolveActive("alpha", "provider-api");
  const portalActive = await targetManager.resolveActive("alpha", "portal-session");

  const profileAfter = await targetProfiles.get("alpha");
  const portalAfter = await targetPortals.get("alpha");
  const apiRef = profileAfter !== undefined && profileAfter.auth.kind !== "none" ? profileAfter.auth.secretRef : undefined;
  const portalRef = portalAfter !== undefined && portalAfter.connection.auth.kind !== "none"
    ? portalAfter.connection.auth.secretRef : undefined;
  // API and portal bindings are independent: each activation rewrote only its own binding's secretRef.
  const bindingsIndependent = apiRef !== undefined && portalRef !== undefined && apiRef !== portalRef &&
    apiRef !== "TARGET_PLACEHOLDER_API" && portalRef !== "TARGET_PLACEHOLDER_PORTAL";

  // Only the two chosen credentials went active; the untouched beta API key stays available (no auto-activation).
  const afterActivation = await targetManager.list();
  const betaStillInactive = afterActivation.some(
    (s) => s.providerId === "beta" && s.purpose === "provider-api" && s.state === "available");
  const activatedActive = afterActivation.filter((s) => s.state === "active").length === 2;

  // Source binding refs are untouched by any target-side activation (byte identity is re-checked at branch end).
  // Compared against the refs captured immediately after seeding, since seeding activated credential refs onto
  // them — the SEED_* placeholders no longer exist to compare against.
  const sourceRefsIntact = sourceApiRefBefore !== undefined && sourceBetaRefBefore !== undefined &&
    sourcePortalRefBefore !== undefined &&
    (await sourceProfiles.get("alpha"))?.auth.secretRef === sourceApiRefBefore &&
    (await sourceProfiles.get("beta"))?.auth.secretRef === sourceBetaRefBefore &&
    (await sourcePortals.get("alpha"))?.connection.auth.secretRef === sourcePortalRefBefore;

  const activationOk = activateApi.code === 0 && activatePortal.code === 0 &&
    apiActive === secretValues.alphaApi && portalActive === secretValues.portalCookie &&
    bindingsIndependent && betaStillInactive && activatedActive && sourceRefsIntact;
  record("restore-explicit-activation", activationOk ? "PASS" : "FAIL",
    "recovered IDs activated via real CLI onto explicit fixtures; resolveActive matches in memory; API/portal bindings independent; beta stays available; source refs intact");

  const restore2 = await runCli(["credentials", "restore", "--file", backupPath], targetApp);
  const additive = restore2.code === 0 && (await targetManager.list()).length === 6 &&
    new Set(await targetManager.listManagedReferences()).size === 6;
  record("restore-additive", additive ? "PASS" : "FAIL",
    "second restore adds three more records with fresh references");

  // Safe refusal: wrong password / tampered ciphertext / unreadable envelope must write nothing and
  // leave the original backup intact. A fresh refused-target root proves no partial writes leak through.
  const refusedProfiles = new FileProviderProfileRepository(join(refusedRoot, "providers.json"));
  const refusedPortals = new FilePortalRepository(join(refusedRoot, "portals.json"));
  const refusedManager = makeManager(refusedProfiles, refusedPortals,
    new DpapiFileSecretVault(join(refusedRoot, "vault"), dpapi.protector),
    new FileCredentialMetadataRepository(join(refusedRoot, "registry.json")));
  const refusedApp = makeApp(refusedProfiles, refusedManager);

  // Seed the refused-target with a PRE-EXISTING binding + placeholder refs so "unchanged" is a real property,
  // not merely "an empty root stays empty": a safe refusal must leave every file byte, every binding ref, and
  // the managed-record set exactly as they were, and must never touch the source snapshot either.
  await refusedProfiles.upsert({ id: "keeper", displayName: "Keeper", baseUrl: "https://keeper.invalid",
    auth: { kind: "bearer", secretRef: "KEEPER_PLACEHOLDER" } });
  await refusedPortals.update("keeper", () => portalRecordSchema.parse({
    connection: { providerId: "keeper", adapterId: "new-api", siteUrl: "https://keeper.invalid",
      auth: { kind: "cookie", secretRef: "KEEPER_PORTAL_PLACEHOLDER" }, userId: 3 },
    revision: randomUUID(), failures: 0,
  }));
  const refusedListBefore = (await refusedManager.list()).length;
  const refusedApiRefBefore = (await refusedProfiles.get("keeper"))?.auth.secretRef;
  const refusedPortalRefBefore = (await refusedPortals.get("keeper"))?.connection.auth.secretRef;
  const refusedSnapshotBefore = await snapshotTree(refusedRoot);

  const backupBytesBefore = await readFile(backupPath);
  const wrongPass = await runCli(["credentials", "restore", "--file", backupPath], refusedApp, async () => "wrong-passphrase");
  const sourceAfterWrong = await snapshotTree(sourceRoot);

  const envelope = JSON.parse(await readFile(backupPath, "utf8"));
  const swapped = (envelope.ciphertext[0] === "A" ? "B" : "A") + envelope.ciphertext.slice(1);
  const tamperedPath = join(base, "tampered-backup.pdv");
  await writeFile(tamperedPath, JSON.stringify({ ...envelope, ciphertext: swapped }), "utf8");
  const tampered = await runCli(["credentials", "restore", "--file", tamperedPath], refusedApp);
  const sourceAfterTampered = await snapshotTree(sourceRoot);

  const invalidPath = join(base, "invalid-backup.pdv");
  await writeFile(invalidPath, "not-a-valid-backup-envelope{", "utf8");
  const invalid = await runCli(["credentials", "restore", "--file", invalidPath], refusedApp);
  const sourceAfterInvalid = await snapshotTree(sourceRoot);

  const refused = [wrongPass, tampered, invalid].every((r) => r.code === 1 && r.err.some((l) => l.includes("could not be")));
  // Files, binding refs, and the managed-record set of the refused target are all unchanged (not just count===0):
  const refusedFilesIntact = treesEqual(refusedSnapshotBefore, await snapshotTree(refusedRoot));
  const refusedBindingsIntact =
    refusedApiRefBefore === "KEEPER_PLACEHOLDER" && refusedPortalRefBefore === "KEEPER_PORTAL_PLACEHOLDER" &&
    (await refusedProfiles.get("keeper"))?.auth.secretRef === refusedApiRefBefore &&
    (await refusedPortals.get("keeper"))?.connection.auth.secretRef === refusedPortalRefBefore &&
    (await refusedManager.list()).length === refusedListBefore;
  // ...and the source snapshot is byte-identical after EACH refusal, not merely at the end.
  const sourceStableThroughRefusals = [sourceAfterWrong, sourceAfterTampered, sourceAfterInvalid]
    .every((snap) => treesEqual(sourceSnapshot, snap));
  const backupIntact = Buffer.compare(backupBytesBefore, await readFile(backupPath)) === 0;
  record("restore-safe-refusal",
    refused && refusedFilesIntact && refusedBindingsIntact && sourceStableThroughRefusals && backupIntact ? "PASS" : "FAIL",
    "wrong-password / tampered / unreadable rejected; refused-target files/refs/bindings & source byte-identical after each; original backup intact");

  // Partial-restore accounting via a per-record vault fault (a dependency seam, NOT app-method mocking):
  // the 3rd set() throws → restored:2 / skipped:1 must be reported honestly, never over-counted.
  let setCalls = 0;
  const store = new Map();
  const partialVault = {
    async get(reference) { return store.get(reference); },
    async set(reference, value) {
      setCalls += 1;
      if (setCalls === 3) throw new Error("fixture vault write fault on third record");
      store.set(reference, value);
    },
    async delete(reference) { return store.delete(reference); },
    async listReferences() { return [...store.keys()]; },
    async revision() { return randomUUID(); },
  };
  const partialManager = makeManager(
    new FileProviderProfileRepository(join(base, "partial-providers.json")),
    new FilePortalRepository(join(base, "partial-portals.json")),
    partialVault, new MemoryCredentialMetadataRepository());
  const partialReport = await partialManager.restoreBackup(backupPath, passphrase);
  const partialHonest = partialReport.restored === 2 && partialReport.skipped === 1 &&
    partialReport.credentialIds.length === 2 && (await partialManager.list()).length === 2;
  record("restore-partial-accounting", partialHonest ? "PASS" : "FAIL",
    "per-record vault fault → restored:2 skipped:1 (no over-counting)");

  // Fault injection for the persistent --negative runner ONLY (env-gated). It mutates GENERATED FIXTURES,
  // never production code or the credential manager, and runs just before the byte re-check so mutant 1 is
  // caught by it. Absent the env flag this is inert, so normal runs and production stay unaffected.
  if (process.env.SMOKE_MUTATE === "source-bytes") {
    // Reviewer mutant 1: source bytes drift while the credential COUNT is unchanged. A count-only check would
    // miss it; the byte snapshot must not. providers.json/portals.json are not re-read after the baseline, so
    // only the byte-check trips (every other fact stays PASS), isolating the signal to sourceBytesStable.
    for (const name of ["providers.json", "portals.json"]) {
      const path = join(sourceRoot, name);
      await writeFile(path, `${(await readFile(path)).toString("utf8")}\n`, "utf8");
    }
  }
  if (process.env.SMOKE_MUTATE === "vault-canary") {
    // Reviewer mutant 2: a plaintext canary written INTO the target DPAPI vault directory — the exact place a
    // real decryption leak would surface (plaintext sitting beside ciphertext), where the reviewer's manual probe
    // already confirmed the scanner detects it. It is outside the snapshot'd sourceRoot, so ONLY the full-tree
    // canary scan trips (isolating the signal to canary.leaks). The value is a real in-memory canary.
    const vaultDir = join(targetRoot, "vault");
    await mkdir(vaultDir, { recursive: true });
    await writeFile(join(vaultDir, `leaked-plaintext-${randomUUID()}.probe`), secretValues.alphaApi, "utf8");
  }

  flags.sourceBytesStable = treesEqual(sourceSnapshot, await snapshotTree(sourceRoot));
  record("source-bytes-stable", flags.sourceBytesStable ? "PASS" : "FAIL",
    "every seeded source file (registry/profile/portal/DPAPI vault) is byte-identical after backup+loss+restore");
  return flags;
}

const portalConnection = {
  providerId: "one", adapterId: "new-api", siteUrl: "https://one.invalid",
  auth: { kind: "bearer", secretRef: "ACCOUNT_TOKEN" }, userId: 42,
};
const corruptByteLength = 257;

async function buildPortalFixture() {
  const base = await mkdtemp(join(tmpdir(), "portal-recovery-smoke-"));
  createdRoots.push(base);
  const root = join(base, "source");
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "accounts.json"), Buffer.alloc(corruptByteLength));
  await writeFile(join(root, "backup.json"), JSON.stringify({
    version: 2,
    records: [{ connection: portalConnection, revision: "76d2fe1c-5766-4413-afce-fab0239f609b",
      failures: 3, nextRefreshAt: "2026-09-15T01:00:00.000Z" }],
  }));
  await writeFile(join(root, "nul-backup.json"), Buffer.alloc(corruptByteLength));
  await writeFile(join(root, "providers.json"), JSON.stringify([
    { id: "one", displayName: "One", baseUrl: "https://one.invalid" },
  ]));
  await writeFile(join(root, "protected.bin"), "synthetic-protected-bytes");
  const source = { root, files: [
    { relativePath: "accounts.json", kind: "portal-metadata" },
    { relativePath: "backup.json", kind: "portal-metadata" },
    { relativePath: "nul-backup.json", kind: "portal-metadata" },
    { relativePath: "providers.json", kind: "provider-metadata" },
    { relativePath: "protected.bin", kind: "protected-secret" },
  ] };
  const input = {
    source, manifest: await inventoryMigrationSource(source), activeRelativePath: "accounts.json",
    evidence: {
      providerMetadataPath: "providers.json", knownAdapterIds: ["new-api"],
      secretFiles: [{ reference: "ACCOUNT_TOKEN", relativePath: "protected.bin" }],
    },
    recovery: { kind: "connections", connections: [portalConnection] },
  };
  return { base, root, input };
}

async function runPortalBranch() {
  let sourcePreserved = true;

  // Fixture A: corrupt active catalog → dry-run ready, NUL backup blocked, operator gate, verified accept.
  const a = await buildPortalFixture();
  const aBefore = await snapshotTree(a.root);
  const dry = await dryRunPortalRecovery(a.input);
  record("portal-dryrun-ready", dry.status === "ready" && dry.connectionCount === 1 ? "PASS" : "FAIL",
    "corrupt active catalog + verified connection → recovery ready");

  const nulDry = await dryRunPortalRecovery({ ...a.input, recovery: { kind: "backup", relativePath: "nul-backup.json" } });
  record("portal-nul-backup-blocked",
    nulDry.status === "blocked" && nulDry.issues.some((i) => i.code === "INVALID_BACKUP") ? "PASS" : "FAIL",
    "NUL backup source is rejected, not silently accepted");

  const stagedPath = join(a.base, "recovered.staged.json");
  const staged = await stagePortalRecovery(a.input, stagedPath);
  const activePath = join(a.root, "accounts.json");
  const backupDestination = join(a.base, "accepted-backup");

  // Operator acceptance gate: without explicit true, accept refuses and leaves the corrupt active bytes untouched.
  const gated = await expectReject(() => acceptStagedPortalRecovery({
    recovery: a.input, stagedPath, stagedFile: staged.stagedFile, backupDestination, operatorAccepted: false,
  }), "OPERATOR_ACCEPTANCE_REQUIRED");
  const activeUntouched = Buffer.compare(await readFile(activePath), Buffer.alloc(corruptByteLength)) === 0;
  record("portal-accept-requires-operator", gated && activeUntouched ? "PASS" : "FAIL",
    "accept without operator confirmation refuses; corrupt active bytes preserved");

  const accepted = await acceptStagedPortalRecovery({
    recovery: a.input, stagedPath, stagedFile: staged.stagedFile, backupDestination, operatorAccepted: true,
  });
  const preservedOriginal = Buffer.compare(
    await readFile(join(backupDestination, "accounts.json")), Buffer.alloc(corruptByteLength)) === 0;
  const activeNow = JSON.parse(await readFile(activePath, "utf8"));
  const stagedDoc = JSON.parse(await readFile(stagedPath, "utf8"));
  const replacedWithStage = JSON.stringify(activeNow) === JSON.stringify(stagedDoc);
  const connection = portalRecordSchema.parse(activeNow.records[0]).connection;
  record("portal-accept-preserves-and-replaces",
    accepted.status === "accepted" && accepted.activeReplaced === true && accepted.refreshDisabled === true &&
    preservedOriginal && replacedWithStage && connection.autoRefresh === false ? "PASS" : "FAIL",
    "original 257-byte catalog backed up verbatim; active atomically replaced with refresh disabled");

  // Full-root byte comparison: a positive accept may replace ONLY the active catalog (accounts.json). Every other
  // original file (backup.json, providers.json, protected.bin, nul-backup.json) must be byte-identical, and no
  // file may be added to or removed from the root (the stage file + operator backup live outside it). This
  // replaces the earlier selective reads that ignored providers.json.
  const aOthersIntact = sourceRootPreserved(aBefore, await snapshotTree(a.root), new Set(["accounts.json"]));
  if (!aOthersIntact) sourcePreserved = false;

  // Fixture B: stale protected bytes after a ready dry-run must block staging (fail-closed re-check),
  // and the corrupt active catalog stays exactly as it was.
  const b = await buildPortalFixture();
  const bBefore = await snapshotTree(b.root);
  const readyB = (await dryRunPortalRecovery(b.input)).status === "ready";
  await writeFile(join(b.root, "protected.bin"), "changed-protected-bytes");
  const sourceChanged = await expectReject(
    () => stagePortalRecovery(b.input, join(b.base, "changed.json")), "SOURCE_CHANGED");
  const bActiveIntact = Buffer.compare(await readFile(join(b.root, "accounts.json")), Buffer.alloc(corruptByteLength)) === 0;
  const stageNotCreated = !(await readdir(b.base)).includes("changed.json");
  // A blocked recovery must write NOTHING: the only permitted difference from the starting point is the test's
  // OWN explicit protected.bin mutation (a test action, not a recovery action). Everything else must be identical.
  const bOthersIntact = sourceRootPreserved(bBefore, await snapshotTree(b.root), new Set(["protected.bin"]));
  if (!bActiveIntact || !bOthersIntact) sourcePreserved = false;
  record("portal-source-changed-refused", readyB && sourceChanged && bActiveIntact && stageNotCreated ? "PASS" : "FAIL",
    "protected bytes changed after dry-run → staging refused; corrupt active bytes untouched; no stage written");

  // Fixture C: positive recovery driven by a VERIFIED kind:"backup" (connections read from a validated backup
  // file, not a hand-built list). The same dry-run → operator-gate → accept contract must hold, and the recovered
  // active catalog must carry exactly the backup's connection while every other source file stays byte-identical.
  const c = await buildPortalFixture();
  const cBefore = await snapshotTree(c.root);
  const cInput = { ...c.input, recovery: { kind: "backup", relativePath: "backup.json" } };
  const cDry = await dryRunPortalRecovery(cInput);
  const cStagedPath = join(c.base, "recovered-from-backup.staged.json");
  const cStaged = await stagePortalRecovery(cInput, cStagedPath);
  const cActivePath = join(c.root, "accounts.json");
  const cBackupDestination = join(c.base, "accepted-backup");
  const cGated = await expectReject(() => acceptStagedPortalRecovery({
    recovery: cInput, stagedPath: cStagedPath, stagedFile: cStaged.stagedFile,
    backupDestination: cBackupDestination, operatorAccepted: false,
  }), "OPERATOR_ACCEPTANCE_REQUIRED");
  const cActiveStillCorrupt = Buffer.compare(await readFile(cActivePath), Buffer.alloc(corruptByteLength)) === 0;
  const cAccepted = await acceptStagedPortalRecovery({
    recovery: cInput, stagedPath: cStagedPath, stagedFile: cStaged.stagedFile,
    backupDestination: cBackupDestination, operatorAccepted: true,
  });
  const cConnection = portalRecordSchema.parse(JSON.parse(await readFile(cActivePath, "utf8")).records[0]).connection;
  const cPreservedOriginal = Buffer.compare(
    await readFile(join(cBackupDestination, "accounts.json")), Buffer.alloc(corruptByteLength)) === 0;

  // Persistent --negative injection points: after a FULLY accepted recovery, drift a NON-active original — the
  // provider-metadata catalog, and (separately) the backup source file — leaving the active catalog, its
  // connection, and the credential count unchanged. The old selective check ignored these files; the full-root
  // snapshot below must now turn portal preservation to FAIL. Inert unless the matching env flag is set.
  if (process.env.SMOKE_MUTATE === "portal-provider-metadata") {
    const p = join(c.root, "providers.json");
    await writeFile(p, `${(await readFile(p)).toString("utf8")} `, "utf8");
  }
  if (process.env.SMOKE_MUTATE === "portal-backup-file") {
    const p = join(c.root, "backup.json");
    await writeFile(p, `${(await readFile(p)).toString("utf8")} `, "utf8");
  }

  // Full-root byte comparison: only the active catalog may differ from the start-of-scenario snapshot; every other
  // source file (providers.json, backup.json, protected.bin, nul-backup.json) must be byte-identical.
  const cOthersIntact = sourceRootPreserved(cBefore, await snapshotTree(c.root), new Set(["accounts.json"]));
  if (!cOthersIntact) sourcePreserved = false;
  record("portal-backup-verified-recovery",
    cDry.status === "ready" && cDry.source === "backup" && cDry.connectionCount === 1 && cGated &&
    cActiveStillCorrupt && cAccepted.status === "accepted" && cAccepted.activeReplaced === true &&
    cConnection.providerId === "one" && cConnection.autoRefresh === false && cPreservedOriginal ? "PASS" : "FAIL",
    "verified kind:backup drives dry-run→operator-gate→accept; active carries the backup connection; original preserved");

  // Fixture D: invalid recovery EVIDENCE (unknown adapter) → dry-run blocked with the issue code; staging must
  // THROW and write no stage file, and the corrupt active catalog must be left exactly as found. A refusal that
  // silently mutated the active catalog or dropped a stage file would be a real defect, so both are byte-checked.
  const d = await buildPortalFixture();
  const dBefore = await snapshotTree(d.root);
  const dInput = { ...d.input, evidence: { ...d.input.evidence, knownAdapterIds: [] } };
  const dDry = await dryRunPortalRecovery(dInput);
  const dBlocked = dDry.status === "blocked" && dDry.issues.some((i) => i.code === "UNKNOWN_ADAPTER");
  const dRefused = await expectReject(
    () => stagePortalRecovery(dInput, join(d.base, "must-not-exist.staged.json")), "RECOVERY_BLOCKED");
  const dNoStage = !(await readdir(d.base)).includes("must-not-exist.staged.json");
  const dActiveIntact = Buffer.compare(await readFile(join(d.root, "accounts.json")), Buffer.alloc(corruptByteLength)) === 0;
  // Blocked recovery must leave the WHOLE source root exactly as found — nothing added, removed, or modified.
  const dOthersIntact = sourceRootPreserved(dBefore, await snapshotTree(d.root), new Set());
  if (!dActiveIntact || !dOthersIntact) sourcePreserved = false;
  record("portal-invalid-evidence-refused", dBlocked && dRefused && dNoStage && dActiveIntact ? "PASS" : "FAIL",
    "invalid recovery evidence → dry-run blocked, staging throws, no stage file written, active catalog untouched");

  record("portal-source-non-active-preserved", sourcePreserved ? "PASS" : "FAIL",
    "recovery mutated only the active catalog it replaced; every other source file preserved");
  return { sourcePreserved };
}

async function canaryScan(resultJson) {
  // Search for leaked plaintext across (a) the emitted result and captured CLI streams, and (b) a BOUNDED
  // recursive walk of EVERY own-created root — profile/portal/vault files included, not just scanPaths. The walk
  // enforces depth / file-count / per-file-byte / total-byte limits on our OWN fixture roots; hitting any limit,
  // or a stat/read error, is UNKNOWN — never "no leak" — and increments `unreadable` (a synthetic, secret-free
  // code only), which the caller folds into the verdict as an overall refusal. Symlinks are not followed. Only
  // counts and synthetic codes leave this function — never a raw path or a scanned byte.
  const LIMITS = { maxDepth: 24, maxFiles: 4000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
  let scanned = 0;
  let leaks = 0;
  let unreadable = 0;
  let files = 0;
  let totalBytes = 0;
  let limitHit;
  const readErrorCodes = new Set();
  const scan = (text) => {
    scanned += 1;
    for (const token of canaries) if (text.includes(token)) leaks += 1;
  };
  for (const text of [resultJson, ...cliOut, ...cliErr]) scan(text);

  const seen = new Set();
  async function walk(dir, depth) {
    if (depth > LIMITS.maxDepth) { unreadable += 1; readErrorCodes.add("EDEPTH"); limitHit = limitHit ?? "depth"; return; }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      unreadable += 1;
      readErrorCodes.add(safeCause(error));
      return;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isSymbolicLink()) { unreadable += 1; readErrorCodes.add("ELOOP"); continue; }
      if (entry.isDirectory()) { await walk(abs, depth + 1); continue; }
      if (!entry.isFile()) continue;
      files += 1;
      if (files > LIMITS.maxFiles) { unreadable += 1; readErrorCodes.add("EFCOUNT"); limitHit = limitHit ?? "file-count"; return; }
      let info;
      try {
        info = await stat(abs);
      } catch (error) {
        unreadable += 1; readErrorCodes.add(safeCause(error)); continue;
      }
      if (info.size > LIMITS.maxFileBytes) {
        // Too large to fully scan: a partial read could miss a leak, so treat as UNKNOWN rather than read part.
        unreadable += 1; readErrorCodes.add("EFBIG"); limitHit = limitHit ?? "file-bytes"; continue;
      }
      if (totalBytes + info.size > LIMITS.maxTotalBytes) {
        unreadable += 1; readErrorCodes.add("ETOTAL"); limitHit = limitHit ?? "total-bytes"; return;
      }
      let bytes;
      try {
        bytes = await readFile(abs);
      } catch (error) {
        unreadable += 1;
        readErrorCodes.add(safeCause(error));
        continue;
      }
      totalBytes += bytes.length;
      // Compare as latin1 so raw bytes never need to leave this scope; ciphertext is not plaintext, so a
      // DPAPI-sealed value never matches a plaintext canary — only a genuine plaintext leak does.
      scan(bytes.toString("latin1"));
    }
  }
  for (const root of createdRoots) {
    const abs = resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    await walk(abs, 0);
  }
  const canary = { scanned, leaks, unreadable, files, readErrorCodes: [...readErrorCodes].sort() };
  if (limitHit !== undefined) canary.limitHit = limitHit;
  return canary;
}

async function cleanup() {
  for (const root of createdRoots.splice(0)) {
    const target = resolve(root);
    const inTmp = target.startsWith(resolve(tmpdir()) + sep);
    const owned = target.includes("credential-recovery-smoke-") || target.includes("portal-recovery-smoke-");
    if (!inTmp || !owned) {
      record("cleanup-guard", "FAIL", "refused to remove a root outside the created fixture space");
      continue;
    }
    try {
      await rm(target, { recursive: true, force: true });
    } catch (error) {
      // A cleanup failure is reported with an allowlisted code only (never a raw path) and, being a FAIL check
      // folded into the verdict, it can never flip a refusal into a success.
      record("cleanup-error", "FAIL", `fixture cleanup could not complete (${safeCause(error)})`);
    }
  }
}

async function main() {
  const dpapi = await probeDpapi();
  let credentialFlags = { blocked: false, apiKeyPreservation: false, metadataRecovery: false, sourceBytesStable: undefined };
  let portalFlags = { sourcePreserved: true };
  let fatal;
  try {
    credentialFlags = await runCredentialBranch(dpapi);
    portalFlags = await runPortalBranch();
  } catch (error) {
    // A fatal abort is projected to an allowlisted, secret-free cause: a raw message could embed a fixture path
    // or injected canary/secret material.
    fatal = safeCause(error);
    record("harness", "FAIL", "unexpected error aborted the rehearsal");
  }

  const credentialBlocked = credentialFlags.blocked === true;
  const blockedChecks = checks.filter((c) => c.status === "BLOCKED").length;

  const result = {
    smoke: "credential-recovery",
    fixtureOnly: true,
    network: "none",
    dpapi: { available: dpapi.available, note: dpapi.note },
    // A skipped native branch is surfaced as BLOCKED, never as a silent pass.
    credentialBranch: credentialBlocked ? "BLOCKED" : "EXECUTED",
    facts: {
      apiKeyPreservation: dpapi.available ? (credentialFlags.apiKeyPreservation ? "PASS" : "FAIL") : "BLOCKED",
      metadataRecovery: dpapi.available ? (credentialFlags.metadataRecovery ? "PASS" : "FAIL") : "BLOCKED",
      upstreamCookieValidity: "BLOCKED",
    },
    // Portal preservation is surfaced on its own so a portal PASS stays visible even when the credential branch is
    // BLOCKED — but it does NOT substitute for the overall claim below.
    portalSourcePreserved: portalFlags.sourcePreserved === true,
    // Overall source preservation is claimed ONLY when the credential branch actually EXECUTED and both the
    // credential source bytes and every portal original are proven stable. A BLOCKED credential branch (e.g. no
    // native DPAPI) establishes nothing, so it can never report sourcePreserved:true.
    sourcePreserved:
      !credentialBlocked &&
      credentialFlags.sourceBytesStable === true &&
      portalFlags.sourcePreserved === true,
    blockedChecks,
    checks,
  };
  if (fatal !== undefined) result.fatal = fatal;

  // Scan every result string and every fixture file for leaked plaintext BEFORE removing the roots.
  const canary = await canaryScan(JSON.stringify(result));
  await cleanup();

  result.canary = canary;
  const failing = checks.filter((c) => c.status === "FAIL").length;
  // Any of these fails the whole verdict — a BLOCKED (unexecuted) credential branch, a fatal abort, a leaked
  // canary, a scan we could not finish (leaks UNKNOWN → unreadable>0), a failing check, or drifted source bytes.
  // A BLOCKED or incomplete rehearsal can never report ok:true.
  result.ok =
    fatal === undefined &&
    !credentialBlocked &&
    canary.leaks === 0 &&
    canary.unreadable === 0 &&
    failing === 0 &&
    result.sourcePreserved === true;
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok ? 0 : 1;
}

// --- Persistent negative fixture-check (`--negative`) -------------------------------------------------------
// Proves the byte-baseline, full-root portal preservation, DPAPI-BLOCKED refusal, and full-tree canary scan
// actually REJECT each mutant instead of silently passing. It spawns THIS script as children with SMOKE_MUTATE
// set (each child mutates its OWN generated fixtures / forces its OWN DPAPI probe — never production code, the
// credential manager, or a real profile), and asserts each mutant child refuses while an unmutated control passes.

// Parse the single pretty-printed JSON object a child smoke run prints on stdout (outermost {...} block).
function parseChildResult(stdout) {
  const start = stdout.indexOf("{");
  const end = stdout.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return undefined;
  try { return JSON.parse(stdout.slice(start, end + 1)); } catch { return undefined; }
}

// Run this same script as a child with SMOKE_MUTATE set; capture its exit code and parsed verdict. Child stderr
// is drained but never surfaced (it may embed a raw fixture path).
function runMutantChild(mutant) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
      env: { ...process.env, SMOKE_MUTATE: mutant },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (chunk) => { out += chunk.toString("utf8"); });
    child.stderr.on("data", () => {});
    child.on("close", (code) => resolvePromise({ exitCode: code, result: parseChildResult(out) }));
    child.on("error", () => resolvePromise({ exitCode: null, result: undefined }));
  });
}

async function negativeMain() {
  const negativeChecks = [];
  const nrecord = (name, status, detail) => negativeChecks.push({ name, status, detail });

  // Teeth can only be proven when the child's credential branch reaches the mutation points, which requires
  // native DPAPI. Without it the branch is BLOCKED before seeding, so we report BLOCKED, never a false PASS.
  const dpapi = await probeDpapi();
  if (!dpapi.available) {
    console.log(JSON.stringify({
      smoke: "credential-recovery-negative", ok: false, blocked: true,
      dpapi: { available: false, note: dpapi.note },
      note: "native DPAPI unavailable; mutant rejection cannot be proven (no fallback)",
    }, null, 2));
    process.exitCode = 1;
    return;
  }

  // Mutant 1: original source bytes drift while the credential COUNT is unchanged. A count-only check would pass;
  // the byte baseline must reject it → child exit 1, ok:false, sourcePreserved:false.
  const m1 = await runMutantChild("source-bytes");
  const m1Rejected = m1.exitCode === 1 && m1.result?.ok === false && m1.result?.sourcePreserved === false;
  nrecord("negative-source-bytes-rejected", m1Rejected ? "PASS" : "FAIL",
    "mutated original bytes (unchanged count) → child exit 1, ok:false, sourcePreserved:false");

  // Mutant 2: a plaintext canary in a fixture file the old scanPaths-only scan skipped. The full-tree scan must
  // reject it → child exit 1, ok:false, canary.leaks>0 (a read failure would instead raise canary.unreadable).
  const m2 = await runMutantChild("vault-canary");
  const m2Rejected = m2.exitCode === 1 && m2.result?.ok === false && (m2.result?.canary?.leaks ?? 0) > 0;
  nrecord("negative-vault-canary-rejected", m2Rejected ? "PASS" : "FAIL",
    "plaintext canary in an unscanned fixture file → child exit 1, ok:false, canary.leaks>0");

  // Mutant 3: force the native DPAPI branch UNAVAILABLE (fixture-only, real profile untouched). A BLOCKED
  // credential branch must NEVER report a pass: child exit 1, ok:false, sourcePreserved not claimed, and the
  // DPAPI-backed facts recorded BLOCKED. (Reviewer false-PASS #1.)
  const m3 = await runMutantChild("dpapi-unavailable");
  const m3Blocked = m3.exitCode === 1 && m3.result?.ok === false && m3.result?.sourcePreserved !== true &&
    m3.result?.credentialBranch === "BLOCKED" &&
    m3.result?.facts?.apiKeyPreservation === "BLOCKED" && m3.result?.facts?.metadataRecovery === "BLOCKED";
  nrecord("negative-dpapi-blocked-not-pass", m3Blocked ? "PASS" : "FAIL",
    "forced-unavailable DPAPI → credential checks BLOCKED, sourcePreserved not claimed, child exit 1 ok:false");

  // Mutant 4: after an accepted portal recovery, drift a NON-active original (providers.json) with the active
  // catalog/connection/count unchanged. The old selective check ignored it; the full-root snapshot must reject it
  // → portalSourcePreserved:false, child exit 1, ok:false. (Reviewer false-PASS #2.)
  const m4 = await runMutantChild("portal-provider-metadata");
  const m4Rejected = m4.exitCode === 1 && m4.result?.ok === false && m4.result?.portalSourcePreserved === false;
  nrecord("negative-portal-provider-metadata-rejected", m4Rejected ? "PASS" : "FAIL",
    "post-accept drift of providers.json (active/connection/count unchanged) → portalSourcePreserved:false, child exit 1");

  // Mutant 5: the same, but drifting the backup source file. Also a non-active original → must be rejected by the
  // full-root snapshot → portalSourcePreserved:false, child exit 1, ok:false.
  const m5 = await runMutantChild("portal-backup-file");
  const m5Rejected = m5.exitCode === 1 && m5.result?.ok === false && m5.result?.portalSourcePreserved === false;
  nrecord("negative-portal-backup-file-rejected", m5Rejected ? "PASS" : "FAIL",
    "post-accept drift of backup.json → portalSourcePreserved:false, child exit 1");

  // Control: an unmutated child must be accepted, proving the runner rejects mutants — not everything.
  const control = await runMutantChild("none");
  const controlAccepted = control.exitCode === 0 && control.result?.ok === true;
  nrecord("negative-control-accepted", controlAccepted ? "PASS" : "FAIL",
    "unmutated child accepted (exit 0, ok:true): the runner rejects mutants, not every run");

  const failing = negativeChecks.filter((c) => c.status === "FAIL").length;
  const ok = failing === 0;
  console.log(JSON.stringify({
    smoke: "credential-recovery-negative", fixtureOnly: true, network: "none",
    dpapi: { available: dpapi.available, note: dpapi.note }, ok, checks: negativeChecks,
  }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

const wantNegative = process.argv.includes("--negative");
(wantNegative ? negativeMain() : main()).catch((error) => {
  console.log(JSON.stringify({
    smoke: wantNegative ? "credential-recovery-negative" : "credential-recovery",
    ok: false, error: safeCause(error),
  }, null, 2));
  process.exitCode = 1;
});

