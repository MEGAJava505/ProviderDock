// Dry-run inventory of legacy Codex/Claude transcript files.
//
// This is a READ-ONLY, non-importing scan. It never mutates the filesystem,
// never performs a migration, and reports only structural metadata about each
// file it finds — never message content, tool arguments, tokens, or cookies.
// It is driven entirely by EXPLICITLY PASSED roots: there is no default search
// of a real session home. Callers pass the exact directories to inventory.
//
// Symlinks are recorded but never followed, so a link pointing outside a root
// cannot cause the scan to read or traverse anything beyond the passed roots.
//
// TOCTOU boundary (honest limitation). Each candidate is lstat'd, opened with
// O_NOFOLLOW where the platform provides it, and its opened identity (dev/ino/
// size/mtime/ctime, single hard link) is re-verified before and after the
// bounded read; a mismatch, a hard-linked/aliased path, or a non-regular file
// fails closed to `unsupported` rather than being vouched for. This narrows,
// but on a portable Node API (notably Windows, where O_NOFOLLOW is absent) does
// NOT fully eliminate, a concurrent-swap race. Therefore this scanner is NOT a
// proven security boundary for an untrusted or live root: run it only over
// directories the caller controls. Do not treat a `recognized` status as proof
// that an adversary could not have substituted the object mid-scan.
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";

export type TranscriptSourceClient = "claude-code" | "codex";

export type TranscriptInventoryStatus =
  | "recognized"
  | "empty"
  | "corrupt"
  | "unsupported"
  | "duplicate";

export interface TranscriptInventoryRoot {
  readonly client: TranscriptSourceClient;
  readonly path: string;
}

export interface TranscriptInventoryEntry {
  readonly client: TranscriptSourceClient;
  /** POSIX-normalised path relative to the root the entry was found under. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  /** SHA-256 of the raw file bytes; omitted when the file was not read. */
  readonly sha256?: string;
  readonly status: TranscriptInventoryStatus;
  /** Machine-readable explanation for non-recognized statuses. */
  readonly reason?: string;
  /** Derived session id (an identifier only, never message content). */
  readonly sessionId?: string;
}

export interface TranscriptInventoryOptions {
  readonly roots: readonly TranscriptInventoryRoot[];
  /** Files larger than this are inventoried but not read (default 5 MiB). */
  readonly maxFileBytes?: number;
}

export interface TranscriptInventoryResult {
  readonly dryRun: true;
  readonly entries: readonly TranscriptInventoryEntry[];
}

const DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Inventory the passed roots without importing or mutating anything. Duplicate
 * detection is per-client: the first file yielding a given session id is
 * `recognized`; any later file yielding the same id is `duplicate`.
 */
export async function dryRunTranscriptInventory(
  options: TranscriptInventoryOptions,
): Promise<TranscriptInventoryResult> {
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const entries: TranscriptInventoryEntry[] = [];
  for (const root of options.roots) {
    // Canonicalise the root so a directory that resolves elsewhere (a reparse
    // point Node may not report as a symlink) can be recognised as an escape.
    const realRoot = await realpath(root.path).catch(() => undefined);
    if (realRoot === undefined) continue;
    const found: RawEntry[] = [];
    await walk(root.path, realRoot, root.path, found);
    for (const raw of found.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
      entries.push(await classify(root.client, raw, maxFileBytes));
    }
  }
  return { dryRun: true, entries: dedupe(entries) };
}

interface RawEntry {
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly isSymbolicLink: boolean;
}

// Collect files (and symlink markers) under `directory`, never following links
// and never descending into a directory that resolves outside `realRoot`.
async function walk(
  root: string,
  realRoot: string,
  directory: string,
  into: RawEntry[],
): Promise<void> {
  const dirents = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  for (const dirent of dirents) {
    const absolutePath = join(directory, dirent.name);
    const relativePath = relative(root, absolutePath).split("\\").join("/");
    if (dirent.isSymbolicLink()) {
      into.push({ absolutePath, relativePath, isSymbolicLink: true });
      continue; // Never follow — a link may point outside the root.
    }
    if (dirent.isDirectory()) {
      const resolved = await realpath(absolutePath).catch(() => undefined);
      if (resolved === undefined || !isWithin(realRoot, resolved)) continue;
      await walk(root, realRoot, absolutePath, into);
      continue;
    }
    if (dirent.isFile()) into.push({ absolutePath, relativePath, isSymbolicLink: false });
  }
}

function isWithin(base: string, target: string): boolean {
  return target === base || target.startsWith(base.endsWith(sep) ? base : base + sep);
}

// Classify one file into a status + safe metadata, reading it at most once and
// never holding more than the read limit in memory.
async function classify(
  client: TranscriptSourceClient,
  raw: RawEntry,
  maxFileBytes: number,
): Promise<TranscriptInventoryEntry> {
  const before = await lstat(raw.absolutePath, { bigint: true }).catch(() => undefined);
  if (before === undefined) {
    // The entry vanished between listing and inspection — fail closed.
    return { client, relativePath: raw.relativePath, sizeBytes: 0, status: "unsupported", reason: "vanished" };
  }
  const base = { client, relativePath: raw.relativePath, sizeBytes: Number(before.size) };
  if (raw.isSymbolicLink || before.isSymbolicLink()) {
    return { ...base, status: "unsupported", reason: "symlink-not-followed" };
  }
  if (!raw.relativePath.endsWith(".jsonl")) {
    return { ...base, status: "unsupported", reason: "not-a-jsonl-transcript" };
  }
  if (!before.isFile()) {
    // A directory, device, FIFO or socket at a `.jsonl` path is not a transcript.
    return { ...base, status: "unsupported", reason: "not-a-regular-file" };
  }
  if (before.nlink !== 1n) {
    // A hard link means the path no longer names a single unique object; the
    // scanner cannot vouch for bytes reachable under another name, so refuse.
    return { ...base, status: "unsupported", reason: "aliased-hard-link" };
  }
  // Read at most maxFileBytes + 1 bytes so the limit is enforced on the bytes
  // actually read, not on a stat that a concurrent writer could have raced. The
  // open re-verifies it got the very inode we lstat'd (O_NOFOLLOW where present).
  let bytes: Buffer;
  try {
    bytes = await readBounded(raw.absolutePath, maxFileBytes + 1, before);
  } catch {
    return { ...base, status: "unsupported", reason: "read-failed" };
  }
  if (bytes.length > maxFileBytes) {
    return { ...base, status: "unsupported", reason: "exceeds-read-limit" };
  }
  // We read the whole file (within the limit): its identity and size must not
  // have changed under us, or we cannot vouch for the bytes we are about to hash.
  const after = await lstat(raw.absolutePath, { bigint: true }).catch(() => undefined);
  if (after === undefined || !sameIdentity(before, after)) {
    return { ...base, status: "unsupported", reason: "identity-changed" };
  }
  if (bytes.length !== Number(before.size)) {
    return { ...base, status: "unsupported", reason: "size-changed-during-read" };
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const text = bytes.toString("utf8");
  if (text.trim() === "") {
    return { ...base, sha256, status: "empty" };
  }
  const rows = parseObjectRows(text);
  if (rows.length === 0) {
    return { ...base, sha256, status: "corrupt", reason: "no-parseable-json-rows" };
  }
  const sessionId = deriveSessionId(client, rows, raw.relativePath);
  return { ...base, sha256, status: "recognized", sessionId };
}

// Read up to `limit` bytes from the head of a file, tolerating short reads. The
// opened handle's identity is re-checked against the pre-open lstat so a path
// swapped for a different object (or a link) between listing and open is caught.
async function readBounded(path: string, limit: number, before: BigIntStats): Promise<Buffer> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!sameIdentity(before, await handle.stat({ bigint: true }))) {
      throw new Error("identity-changed-on-open");
    }
    const buffer = Buffer.alloc(limit);
    let offset = 0;
    while (offset < limit) {
      const { bytesRead } = await handle.read(buffer, offset, limit - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

// Parse newline-delimited JSON, keeping only object rows. Partial/garbage lines
// are skipped exactly as the live session reader tolerates crash-truncated tails.
function parseObjectRows(text: string): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // Ignore a single unparseable line; a file of only these is "corrupt".
    }
  }
  return rows;
}

// Mirror the live reader's id derivation without touching message content:
// prefer the explicit session-id field, else fall back to the file's basename.
function deriveSessionId(
  client: TranscriptSourceClient,
  rows: readonly Record<string, unknown>[],
  relativePath: string,
): string {
  for (const row of rows) {
    if (client === "claude-code") {
      if (typeof row.sessionId === "string" && row.sessionId.trim() !== "") return row.sessionId;
    } else {
      const payload = isRecord(row.payload) ? row.payload : undefined;
      const id = firstString(payload?.session_id, payload?.id);
      if (id !== undefined) return id;
    }
  }
  return basename(relativePath, ".jsonl");
}

// Flag files that repeat an already-seen (client, sessionId) as duplicates,
// preserving the first occurrence as recognized.
function dedupe(entries: readonly TranscriptInventoryEntry[]): TranscriptInventoryEntry[] {
  const seen = new Set<string>();
  return entries.map((entry) => {
    if (entry.status !== "recognized" || entry.sessionId === undefined) return entry;
    const key = `${entry.client}\u0000${entry.sessionId}`;
    if (seen.has(key)) return { ...entry, status: "duplicate", reason: "session-id-already-seen" };
    seen.add(key);
    return entry;
  });
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string";
}

// Identity equality for the TOCTOU guard: the object must be the same inode,
// unchanged in size and timestamps, and still a single (non-aliased) hard link.
function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs &&
    right.nlink === 1n;
}
