import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { portalRecordSchema } from "../core/portals/portal-types.js";
import { providerProfileSchema } from "../core/providers/provider-profile.js";

// Match FilePortalRepository's accepted durable metadata without its
// side-effecting list(), which writes corruption backups.
const portalMetadataSchema = z.union([
  z.object({ version: z.literal(2), records: z.array(portalRecordSchema).max(1_000) }).strict(),
  z.object({
    version: z.literal(1),
    records: z.array(portalRecordSchema.pick({ connection: true, revision: true }).passthrough()).max(1_000),
  }).strict(),
]).refine(({ records }) => new Set(records.map((record) => record.connection.providerId)).size === records.length);

export type MigrationDataKind = "portal-metadata" | "provider-metadata" | "protected-secret" | "session" | "opaque";
export interface MigrationSourcePolicy {
  /** Explicit existing absolute directory; no volume roots, UNC paths or linked ancestors. */
  readonly root: string;
  /**
   * Complete allowlist for this operation, not recursive whole-root discovery.
   * Paths use "/" separators. Kinds are caller classifications: protected-secret,
   * session and opaque contents are never parsed, decrypted or logged.
   */
  readonly files: readonly { readonly relativePath: string; readonly kind: MigrationDataKind }[];
}
export interface MigrationManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly files: readonly MigrationManifestEntry[];
}
export interface MigrationManifestEntry {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly kind: MigrationDataKind;
  readonly validation: "nul-bytes" | "not-inspected" | "valid" | "invalid-json" | "invalid-schema" | "too-large";
}

export interface AcceptedPortalMetadataReplacement {
  readonly backupManifest: MigrationManifest;
  readonly activeFile: MigrationManifestEntry;
}

/** Messages/codes deliberately contain no file contents, parser errors or absolute paths. */
export class MigrationSafetyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MigrationSafetyError";
  }
}

export async function inventoryMigrationSource(
  source: MigrationSourcePolicy, now = new Date(),
): Promise<MigrationManifest> {
  source = validatePolicy(source);
  await assertUnlinkedPath(source.root, true);
  const files: MigrationManifestEntry[] = [];
  for (const file of source.files) {
    files.push((await inspectFile(source.root, file)).entry);
  }
  return { version: 1, createdAt: now.toISOString(), files };
}

/**
 * Offline, explicit-allowlist snapshot. Stop all writers first. No Node path API
 * provides a filesystem transaction or protection against a hostile concurrent
 * ancestor rename. Links are rejected and identities/hashes rechecked throughout.
 * On failure a partial NEW destination may remain; it is never a verified snapshot
 * and is not recursively deleted (nor are originals modified).
 * Ciphertext is copied as-is; DPAPI portability to another user/PC is not implied.
 */
export async function createVerifiedSnapshot(
  source: MigrationSourcePolicy, manifest: MigrationManifest, destination: string,
): Promise<MigrationManifest> {
  source = validatePolicy(source);
  manifest = validateManifest(source, manifest);
  await assertSeparateDestination(source.root, destination);
  await verifyMigrationSource(source, manifest);
  await assertSeparateDestination(source.root, destination);
  try { await mkdir(destination, { mode: 0o700 }); }
  catch (error) { throw safeIoError(error); }
  await assertUnlinkedPath(destination, true);
  for (const [index, file] of source.files.entries()) {
    const target = join(destination, file.relativePath);
    // Create components one at a time, never mkdir recursively through a link.
    let parent = destination;
    for (const component of file.relativePath.split("/").slice(0, -1)) {
      await assertUnlinkedPath(parent, true);
      parent = join(parent, component);
      try { await mkdir(parent, { mode: 0o700 }); }
      catch (error) { if (!hasCode(error, "EEXIST")) throw safeIoError(error); }
      await assertUnlinkedPath(parent, true);
    }
    await assertUnlinkedPath(parent, true);
    const output = await open(target, "wx", 0o600).catch((error: unknown) => { throw safeIoError(error); });
    try {
      const { entry } = await inspectFile(source.root, file, async (chunk) => { await output.writeFile(chunk); });
      if (!sameEntry(entry, manifest.files[index]!)) {
        throw new MigrationSafetyError("SOURCE_CHANGED");
      }
      await output.sync();
    } finally { await output.close(); }
  }
  const copied = await inventoryMigrationSource({ root: destination, files: source.files }, new Date(manifest.createdAt));
  assertSameFiles(copied, manifest);
  await verifyMigrationSource(source, manifest);
  return copied;
}

/** Revalidate all allowlisted evidence, including kind/validation, against actual IO. */
export async function verifyMigrationSource(source: MigrationSourcePolicy, manifest: MigrationManifest): Promise<void> {
  source = validatePolicy(source);
  manifest = validateManifest(source, manifest);
  try {
    assertSameFiles(await inventoryMigrationSource(source, new Date(manifest.createdAt)), manifest);
  } catch (error) {
    if (error instanceof MigrationSafetyError) throw error;
    throw new MigrationSafetyError("SOURCE_CHANGED");
  }
}

/** Bounded JSON read of VERIFIED provider/portal metadata only; never exposes secret/session bytes. */
export async function readVerifiedMigrationMetadata(
  source: MigrationSourcePolicy, manifest: MigrationManifest, relativePath: string,
): Promise<unknown> {
  source = validatePolicy(source);
  manifest = validateManifest(source, manifest);
  const expected = manifest.files.find((file) => file.relativePath === relativePath);
  if (!expected || (expected.kind !== "portal-metadata" && expected.kind !== "provider-metadata") ||
      expected.validation !== "valid") throw new MigrationSafetyError("INVALID_METADATA");
  const actual = await inspectFile(source.root, expected);
  if (!sameEntry(actual.entry, expected)) throw new MigrationSafetyError("SOURCE_CHANGED");
  if (!actual.bytes) throw new MigrationSafetyError("INVALID_METADATA");
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(actual.bytes)) as unknown;
}

/**
 * Low-level staging IO, not connection recovery/acceptance: prefer stagePortalRecovery.
 * Requires stopped writers and a trusted destination with an existing parent.
 * A failure can leave a new, UNVERIFIED artifact; never apply it based on existence.
 * There is deliberately no rename/replace/accept API.
 */
export async function writeExclusivePortalStage(
  source: MigrationSourcePolicy, manifest: MigrationManifest, destination: string, document: unknown,
): Promise<MigrationManifestEntry> {
  source = validatePolicy(source);
  manifest = validateManifest(source, manifest);
  const parsed = portalMetadataSchema.safeParse(document);
  if (!parsed.success || parsed.data.version !== 2 || parsed.data.records.length === 0) {
    throw new MigrationSafetyError("INVALID_STAGE");
  }
  const bytes = Buffer.from(JSON.stringify(parsed.data) + "\n", "utf8");
  if (bytes.length > maximumMetadataBytes) throw new MigrationSafetyError("FILE_TOO_LARGE");
  await assertSeparateDestination(source.root, destination);
  await verifyMigrationSource(source, manifest);
  await assertSeparateDestination(source.root, destination);
  const handle = await open(destination, "wx", 0o600).catch((error: unknown) => { throw safeIoError(error); });
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally { await handle.close(); }
  const { entry } = await inspectFile(dirname(destination), { relativePath: basename(destination), kind: "portal-metadata" });
  if (entry.sha256 !== createHash("sha256").update(bytes).digest("hex") || entry.validation !== "valid") {
    throw new MigrationSafetyError("SOURCE_CHANGED");
  }
  await verifyMigrationSource(source, manifest);
  return entry;
}

/**
 * Replace one verified active portal document only after preserving its exact
 * manifest-bound bytes in a new verified snapshot. Callers must validate the
 * recovery semantics and explicit operator acceptance before using this IO seam.
 */
export async function replacePortalMetadataWithVerifiedBackup(
  source: MigrationSourcePolicy,
  manifest: MigrationManifest,
  activeRelativePath: string,
  document: unknown,
  backupDestination: string,
): Promise<AcceptedPortalMetadataReplacement> {
  source = validatePolicy(source);
  manifest = validateManifest(source, manifest);
  const active = manifest.files.find((file) => file.relativePath === activeRelativePath);
  if (active?.kind !== "portal-metadata") throw new MigrationSafetyError("INVALID_ACTIVE_FILE");
  const parsed = portalMetadataSchema.safeParse(document);
  if (!parsed.success || parsed.data.version !== 2 || parsed.data.records.length === 0) {
    throw new MigrationSafetyError("INVALID_STAGE");
  }
  const bytes = Buffer.from(JSON.stringify(parsed.data) + "\n", "utf8");
  if (bytes.length > maximumMetadataBytes) throw new MigrationSafetyError("FILE_TOO_LARGE");

  const activeSource: MigrationSourcePolicy = {
    root: source.root,
    files: [{ relativePath: active.relativePath, kind: "portal-metadata" }],
  };
  const activeManifest: MigrationManifest = {
    version: 1,
    createdAt: manifest.createdAt,
    files: [active],
  };
  await verifyMigrationSource(source, manifest);
  const backupManifest = await createVerifiedSnapshot(activeSource, activeManifest, backupDestination);
  await verifyMigrationSource(source, manifest);

  const target = join(source.root, active.relativePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600).catch((error: unknown) => { throw safeIoError(error); });
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    const temporaryEntry = (await inspectFile(dirname(temporary), {
      relativePath: basename(temporary), kind: "portal-metadata",
    })).entry;
    if (temporaryEntry.byteLength !== bytes.length || temporaryEntry.validation !== "valid" ||
        temporaryEntry.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
      throw new MigrationSafetyError("SOURCE_CHANGED");
    }
    await verifyMigrationSource(source, manifest);
    await rename(temporary, target).catch((error: unknown) => { throw safeIoError(error); });
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
  const replaced = await inventoryMigrationSource(activeSource);
  const activeFile = replaced.files[0]!;
  if (activeFile.byteLength !== bytes.length || activeFile.validation !== "valid" ||
      activeFile.sha256 !== createHash("sha256").update(bytes).digest("hex")) {
    throw new MigrationSafetyError("REPLACEMENT_VERIFY_FAILED");
  }
  return { backupManifest, activeFile };
}

function assertSameFiles(actual: MigrationManifest, expected: MigrationManifest): void {
  if (actual.files.length !== expected.files.length ||
      actual.files.some((file, index) => !sameEntry(file, expected.files[index]!))) {
    throw new MigrationSafetyError("SOURCE_CHANGED");
  }
}

function sameEntry(a: MigrationManifestEntry, b: MigrationManifestEntry): boolean {
  return a.relativePath === b.relativePath && a.byteLength === b.byteLength && a.sha256 === b.sha256 &&
    a.kind === b.kind && a.validation === b.validation;
}

const kindSchema = z.enum(["portal-metadata", "provider-metadata", "protected-secret", "session", "opaque"]);
const policySchema = z.object({
  root: z.string(),
  files: z.array(z.object({ relativePath: z.string(), kind: kindSchema }).strict()).min(1).max(100_000),
}).strict();
const manifestSchema = z.object({
  version: z.literal(1),
  createdAt: z.string().datetime(),
  files: z.array(z.object({
    relativePath: z.string(), byteLength: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/), kind: kindSchema,
    validation: z.enum(["nul-bytes", "not-inspected", "valid", "invalid-json", "invalid-schema", "too-large"]),
  }).strict()).min(1).max(100_000),
}).strict();

function validateManifest(source: MigrationSourcePolicy, input: MigrationManifest): MigrationManifest {
  const result = manifestSchema.safeParse(input);
  if (!result.success) throw new MigrationSafetyError("INVALID_MANIFEST");
  const manifest = result.data;
  manifest.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  if (manifest.files.length !== source.files.length || manifest.files.some((file, index) =>
    file.relativePath !== source.files[index]?.relativePath || file.kind !== source.files[index]?.kind)) {
    throw new MigrationSafetyError("INVALID_MANIFEST");
  }
  return manifest;
}

async function assertSeparateDestination(root: string, destination: string): Promise<void> {
  validateAbsolutePath(destination);
  const within = (parent: string, child: string) => {
    const rel = relative(pathKey(parent), pathKey(child));
    return rel === "" || (rel !== ".." && !rel.startsWith(".." + sep) && !isAbsolute(rel));
  };
  if (within(root, destination) || within(destination, root)) throw new MigrationSafetyError("UNSAFE_PATH");
  await assertUnlinkedPath(root, true);
  await assertUnlinkedPath(dirname(destination), true);
}

function validatePolicy(input: MigrationSourcePolicy): MigrationSourcePolicy {
  const result = policySchema.safeParse(input);
  if (!result.success) throw new MigrationSafetyError("INVALID_POLICY");
  const source = result.data;
  validateAbsolutePath(source.root);
  const seen = new Set<string>();
  for (const file of source.files) {
    validateRelativePath(file.relativePath);
    const key = file.relativePath.toLowerCase();
    if (seen.has(key)) throw new MigrationSafetyError("INVALID_POLICY");
    seen.add(key);
  }
  return { root: resolve(source.root), files: source.files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)) };
}

function validateRelativePath(path: string): void {
  // Portable manifests: no traversal, ADS, drive-relative paths, devices or
  // Windows names whose trailing dots/spaces silently alias another file.
  if (!path || /[\\:\x00-\x1f<>"|?*]/.test(path) || path.split("/").some(
    (part) => !part || part === "." || part === ".." || /[. ]$/.test(part) ||
      /^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part),
  )) throw new MigrationSafetyError("UNSAFE_PATH");
}

function validateAbsolutePath(path: string): void {
  if (!isAbsolute(path) || /^[\\/]{2}/.test(path) || resolve(path) === parse(path).root) {
    throw new MigrationSafetyError("UNSAFE_PATH");
  }
  validateRelativePath(path.slice(parse(path).root.length).split(sep).join("/"));
}

function pathKey(path: string): string {
  return process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);
}

async function assertUnlinkedPath(path: string, directory: boolean) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep);
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = await lstat(current, { bigint: true }).catch((error: unknown) => { throw safeIoError(error); });
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) {
      throw new MigrationSafetyError("UNSAFE_PATH");
    }
    if (index === parts.length - 1) {
      if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) {
        throw new MigrationSafetyError("UNSAFE_PATH");
      }
      const canonical = await realpath(current).catch((error: unknown) => { throw safeIoError(error); });
      if (pathKey(canonical) !== pathKey(absolute)) throw new MigrationSafetyError("UNSAFE_PATH");
      return stat;
    }
  }
  throw new MigrationSafetyError("UNSAFE_PATH");
}

const maximumMetadataBytes = 64 * 1024 * 1024;

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size &&
    a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && b.nlink === 1n;
}

async function inspectFile(
  root: string, file: MigrationSourcePolicy["files"][number],
  consume?: (bytes: Buffer) => Promise<void>,
): Promise<{ entry: MigrationManifestEntry; bytes?: Buffer }> {
  const path = join(root, file.relativePath);
  try {
    const before = await assertUnlinkedPath(path, false);
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if (!sameIdentity(before, await handle.stat({ bigint: true }))) throw new MigrationSafetyError("SOURCE_CHANGED");
      if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new MigrationSafetyError("FILE_TOO_LARGE");
      const metadata = file.kind === "portal-metadata" || file.kind === "provider-metadata";
      const capture = metadata && before.size <= BigInt(maximumMetadataBytes);
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(64 * 1024);
      let length = 0;
      while (length < Number(before.size)) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - length), length);
        if (!bytesRead) throw new MigrationSafetyError("SOURCE_CHANGED");
        const chunk = buffer.subarray(0, bytesRead);
        hash.update(chunk);
        if (capture) chunks.push(Buffer.from(chunk));
        if (consume) await consume(chunk);
        length += bytesRead;
      }
      if (!sameIdentity(before, await handle.stat({ bigint: true })) ||
          !sameIdentity(before, await assertUnlinkedPath(path, false))) throw new MigrationSafetyError("SOURCE_CHANGED");
      const bytes = capture ? Buffer.concat(chunks, length) : undefined;
      const entry: MigrationManifestEntry = {
        relativePath: file.relativePath, kind: file.kind, byteLength: length, sha256: hash.digest("hex"),
        validation: bytes ? validateBytes(file.kind, bytes) : metadata ? "too-large" : "not-inspected",
      };
      return bytes === undefined ? { entry } : { entry, bytes };
    } finally { await handle.close(); }
  } catch (error) { throw safeIoError(error); }
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function safeIoError(error: unknown): MigrationSafetyError {
  if (error instanceof MigrationSafetyError) return error;
  return new MigrationSafetyError(hasCode(error, "EEXIST") ? "DESTINATION_EXISTS" :
    hasCode(error, "ENOENT") ? "SOURCE_CHANGED" : "IO_FAILURE");
}
function validateBytes(kind: MigrationDataKind, bytes: Buffer): MigrationManifestEntry["validation"] {
  if (kind !== "portal-metadata" && kind !== "provider-metadata") return "not-inspected";
  if (bytes.includes(0)) return "nul-bytes";
  let input: unknown;
  try { input = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return "invalid-json"; }
  const schema = kind === "portal-metadata" ? portalMetadataSchema : z.array(providerProfileSchema);
  return schema.safeParse(input).success ? "valid" : "invalid-schema";
}
