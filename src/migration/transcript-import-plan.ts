// Deterministic import plan + atomic manifest for legacy transcripts.
//
// This module NEVER launches an importer, NEVER reads real session homes, and
// NEVER mutates a source transcript. It consumes the read-only inventory
// (see ./transcript-inventory.ts) plus an EXPLICIT user selection and target
// scope, and produces a plan whose only durable artifact is a manifest written
// into a caller-chosen (test) directory.
//
// Idempotency key = source identity (client, relative path, content hash) +
// target scope. A changed source (new hash) is a NEW candidate, never a silent
// overwrite of a different session. Two selected sources that resolve to the
// same OMP session id do not both import: the second is `duplicate`.
//
// The manifest carries only structural metadata. Secrets, permissions, old
// CLI flags and OAuth tokens are never derived here and never persisted.
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import type {
  TranscriptInventoryEntry,
  TranscriptInventoryResult,
  TranscriptSourceClient,
} from "./transcript-inventory.js";

export type ImportItemStatus =
  | "ready"
  | "already-imported"
  | "duplicate"
  | "unsupported"
  | "corrupt"
  | "skipped";

/** Isolated, caller-supplied target. No secrets, no live provider binding. */
export interface ImportTargetScope {
  readonly providerId: string;
  readonly accountId?: string;
}

/** A user's explicit pick from the inventory: matched by client + relative path. */
export interface ImportSelection {
  readonly client: TranscriptSourceClient;
  readonly relativePath: string;
}

export interface ImportPlanItem {
  readonly client: TranscriptSourceClient;
  readonly relativePath: string;
  /** Present only when the source file was actually read during inventory. */
  readonly sha256?: string;
  /** Inventory-derived session id; the future OMP identity links from this. */
  readonly sessionId?: string;
  readonly status: ImportItemStatus;
  readonly reason?: string;
  /** Stable key over (client, relativePath, sha256, target scope). */
  readonly idempotencyKey: string;
  /**
   * The verified new OMP session id. Populated ONLY after a real import has
   * been performed and re-read (a later stage). Never set at planning time.
   */
  readonly ompSessionId?: string;
}

export interface ImportPlan {
  readonly targetScope: ImportTargetScope;
  readonly items: readonly ImportPlanItem[];
}

export interface PlanTranscriptImportOptions {
  readonly inventory: TranscriptInventoryResult;
  readonly selection: readonly ImportSelection[];
  readonly targetScope: ImportTargetScope;
  /** A previously committed manifest, if any, to make re-runs idempotent. */
  readonly existingManifest?: ImportManifest;
}

export interface ImportManifest {
  readonly version: 1;
  readonly createdAt: string;
  readonly targetScope: ImportTargetScope;
  readonly items: readonly ImportManifestEntry[];
}

export interface ImportManifestEntry {
  readonly client: TranscriptSourceClient;
  readonly relativePath: string;
  readonly sha256?: string;
  readonly sessionId?: string;
  readonly idempotencyKey: string;
  /** Manifest-level lifecycle, independent of the plan's per-run status. */
  readonly state: "staged" | "imported";
  /** Set only alongside state === "imported". */
  readonly ompSessionId?: string;
}

/** Codes never contain file contents, parser detail, secrets or absolute paths. */
export class ImportManifestError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImportManifestError";
  }
}
const MAX_ITEMS = 10_000;

/**
 * Build a deterministic import plan. Pure and side-effect free: it reads no
 * files and writes nothing. Selection order does not affect statuses; items are
 * emitted in the inventory's (already sorted) order.
 */
export function planTranscriptImport(options: PlanTranscriptImportOptions): ImportPlan {
  const { inventory, selection, targetScope, existingManifest } = options;
  const chosen = new Set(selection.map((pick) => selectionKey(pick.client, pick.relativePath)));
  const committed = indexManifest(existingManifest, targetScope);
  // Within one plan, the first source yielding a given session id wins; any
  // later selected source with the same id is a duplicate, never an overwrite.
  const seenSessionIds = new Set<string>();
  const items: ImportPlanItem[] = [];
  for (const entry of inventory.entries) {
    if (!chosen.has(selectionKey(entry.client, entry.relativePath))) continue;
    items.push(classifyCandidate(entry, targetScope, committed, seenSessionIds));
  }
  return { targetScope, items };
}

function classifyCandidate(
  entry: TranscriptInventoryEntry,
  scope: ImportTargetScope,
  committed: Map<string, ImportManifestEntry>,
  seenSessionIds: Set<string>,
): ImportPlanItem {
  const idempotencyKey = deriveIdempotencyKey(entry, scope);
  // Omit optional keys entirely when absent — exactOptionalPropertyTypes
  // forbids assigning an explicit `undefined` to `sha256?`/`sessionId?`.
  const base = {
    client: entry.client,
    relativePath: entry.relativePath,
    ...(entry.sha256 !== undefined ? { sha256: entry.sha256 } : {}),
    ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}),
    idempotencyKey,
  };
  // Non-recognized inventory statuses are carried through verbatim so the plan
  // never promises an import for a file the scan could not vouch for.
  if (entry.status === "unsupported") {
    return { ...base, status: "unsupported", ...(entry.reason !== undefined ? { reason: entry.reason } : {}) };
  }
  if (entry.status === "corrupt") {
    return { ...base, status: "corrupt", ...(entry.reason !== undefined ? { reason: entry.reason } : {}) };
  }
  if (entry.status === "empty") return { ...base, status: "skipped", reason: "empty" };
  if (entry.status === "duplicate") {
    return { ...base, status: "duplicate", ...(entry.reason !== undefined ? { reason: entry.reason } : {}) };
  }

  // recognized: reconcile against the committed manifest and this run's ids.
  const prior = committed.get(idempotencyKey);
  if (prior?.state === "imported") {
    return {
      ...base,
      status: "already-imported",
      ...(prior.ompSessionId !== undefined ? { ompSessionId: prior.ompSessionId } : {}),
    };
  }
  if (entry.sessionId !== undefined) {
    if (seenSessionIds.has(entry.sessionId)) {
      return { ...base, status: "duplicate", reason: "session-id-already-selected" };
    }
    // A different committed source already claimed this session id: refuse to
    // silently point a second transcript at the same identity.
    const claimant = [...committed.values()].find(
      (item) => item.sessionId === entry.sessionId && item.idempotencyKey !== idempotencyKey,
    );
    if (claimant !== undefined) {
      return { ...base, status: "duplicate", reason: "session-id-claimed-by-manifest" };
    }
    seenSessionIds.add(entry.sessionId);
  }
  return { ...base, status: "ready" };
}

function indexManifest(
  manifest: ImportManifest | undefined,
  scope: ImportTargetScope,
): Map<string, ImportManifestEntry> {
  const index = new Map<string, ImportManifestEntry>();
  if (manifest === undefined) return index;
  if (!sameScope(manifest.targetScope, scope)) return index; // A manifest for another scope tells us nothing.
  for (const item of manifest.items) index.set(item.idempotencyKey, item);
  return index;
}

function selectionKey(client: TranscriptSourceClient, relativePath: string): string {
  return `${client}\u0000${relativePath}`;
}

function sameScope(left: ImportTargetScope, right: ImportTargetScope): boolean {
  return left.providerId === right.providerId && (left.accountId ?? "") === (right.accountId ?? "");
}

// The key binds the exact source bytes (hash) and chosen target together, so a
// changed source or a different target produces a distinct, non-colliding key.
function deriveIdempotencyKey(entry: TranscriptInventoryEntry, scope: ImportTargetScope): string {
  return createHash("sha256")
    .update([
      entry.client,
      entry.relativePath,
      entry.sha256 ?? "",
      scope.providerId,
      scope.accountId ?? "",
    ].join("\u0000"))
    .digest("hex");
}

// -- Manifest persistence -------------------------------------------------

const manifestSchema = z
  .object({
    version: z.literal(1),
    createdAt: z.string().min(1),
    targetScope: z
      .object({ providerId: z.string().min(1), accountId: z.string().min(1).optional() })
      .strict(),
    items: z
      .array(
        z
          .object({
            client: z.enum(["claude-code", "codex"]),
            relativePath: z.string().min(1),
            sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
            sessionId: z.string().min(1).optional(),
            idempotencyKey: z.string().regex(/^[0-9a-f]{64}$/),
            state: z.enum(["staged", "imported"]),
            ompSessionId: z.string().min(1).optional(),
          })
          .strict()
          // Biconditional identity invariant: `imported` REQUIRES an
          // ompSessionId, and `staged` FORBIDS one. Neither a staged row that
          // leaks an OMP id nor an imported row that fabricates the state
          // without a verified identity can pass.
          .refine((item) => (item.state === "imported") === (item.ompSessionId !== undefined), {
            message: "state and ompSessionId must agree: imported ⇔ ompSessionId present",
          }),
      )
      .max(MAX_ITEMS),
  })
  .strict()
  .refine(
    (m) => new Set(m.items.map((item) => item.idempotencyKey)).size === m.items.length,
    { message: "duplicate idempotencyKey" },
  );

/**
 * Derive this run's staged delta. `writeImportManifest` reconciles it with any
 * existing file before replacing that file, so prior history is not discarded.
 * No item is ever `imported` here: that state is reserved for a later stage
 * that has actually created and re-read a new OMP session.
 */
export function stageManifest(plan: ImportPlan, now: Date = new Date()): ImportManifest {
  const items: ImportManifestEntry[] = plan.items
    .filter((item) => item.status === "ready")
    .map((item) => ({
      client: item.client,
      relativePath: item.relativePath,
      ...(item.sha256 !== undefined ? { sha256: item.sha256 } : {}),
      ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
      idempotencyKey: item.idempotencyKey,
      state: "staged" as const,
    }));
  return { version: 1, createdAt: now.toISOString(), targetScope: plan.targetScope, items };
}

/**
 * Merge this run's staged rows onto a prior committed manifest of the SAME
 * target scope, preserving history: every previously recorded entry (whether
 * `staged` or already `imported`) survives, and only genuinely new sources are
 * appended as `staged`. This function NEVER mints an `imported` state — that
 * remains reserved for a later stage that has actually created and re-read a
 * new OMP session. A plan for a different scope is refused, never silently
 * overwritten, so a manifest can only ever describe one target.
 */
export function commitStagedManifest(
  existing: ImportManifest | undefined,
  plan: ImportPlan,
  now: Date = new Date(),
): ImportManifest {
  const staged = stageManifest(plan, now);
  if (existing === undefined) return staged;
  if (!sameScope(existing.targetScope, plan.targetScope)) {
    throw new ImportManifestError("MANIFEST_SCOPE_MISMATCH");
  }
  // Seed with prior entries so confirmed history (including `imported`) is kept
  // verbatim; a new staged row is added only when its key is not already known,
  // so a re-commit of the same plan is idempotent and no key is downgraded.
  const merged = new Map<string, ImportManifestEntry>();
  for (const item of existing.items) merged.set(item.idempotencyKey, item);
  for (const item of staged.items) {
    if (!merged.has(item.idempotencyKey)) merged.set(item.idempotencyKey, item);
  }
  return {
    version: 1,
    createdAt: existing.createdAt,
    targetScope: existing.targetScope,
    items: [...merged.values()],
  };
}

/**
 * Write a manifest atomically: validate and reconcile with the current file →
 * temp file in the SAME directory → fsync → rename → re-read and re-validate.
 * A staged delta cannot erase prior entries, switch target scope, or promote a
 * row to `imported` without a future verified-import API. An interruption
 * before the rename leaves any prior manifest untouched. This fixture-only
 * writer does not serialize concurrent processes; it is not a live importer.
 */
export async function writeImportManifest(path: string, manifest: ImportManifest): Promise<ImportManifest> {
  const parsed = manifestSchema.safeParse(manifest);
  if (!parsed.success) throw new ImportManifestError("MANIFEST_INVALID_SCHEMA");
  const reconciled = await reconcileManifestForWrite(path, parsed.data as ImportManifest);
  const validated = manifestSchema.safeParse(reconciled);
  if (!validated.success) throw new ImportManifestError("MANIFEST_INVALID_SCHEMA");
  const bytes = Buffer.from(`${JSON.stringify(validated.data, null, 2)}\n`, "utf8");
  const temporary = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    const handle = await open(temporary, "wx", 0o600).catch((error: unknown) => {
      throw ioError(error);
    });
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path).catch((error: unknown) => {
      throw ioError(error);
    });
    renamed = true;
  } finally {
    if (!renamed) await rm(temporary, { force: true }).catch(() => undefined);
  }
  // Re-read so the returned manifest reflects durable, reparsed bytes only.
  return readImportManifest(path);
}

async function reconcileManifestForWrite(path: string, incoming: ImportManifest): Promise<ImportManifest> {
  let existing: ImportManifest | undefined;
  try {
    existing = await readImportManifest(path);
  } catch (error) {
    if (!(error instanceof ImportManifestError && error.code === "MANIFEST_IO_ENOENT")) throw error;
  }
  if (existing !== undefined && !sameScope(existing.targetScope, incoming.targetScope)) {
    throw new ImportManifestError("MANIFEST_SCOPE_MISMATCH");
  }
  const items = [...(existing?.items ?? [])];
  const byKey = new Map(items.map((item) => [item.idempotencyKey, item]));
  for (const item of incoming.items) {
    const prior = byKey.get(item.idempotencyKey);
    if (prior === undefined) {
      if (item.state === "imported") throw new ImportManifestError("MANIFEST_UNVERIFIED_IMPORT");
      items.push(item);
      byKey.set(item.idempotencyKey, item);
      continue;
    }
    if (prior.state === "staged" && item.state === "imported") {
      throw new ImportManifestError("MANIFEST_UNVERIFIED_IMPORT");
    }
    if (!sameManifestEntry(prior, item)) {
      throw new ImportManifestError("MANIFEST_ENTRY_CONFLICT");
    }
  }
  return { ...incoming, items };
}

function sameManifestEntry(left: ImportManifestEntry, right: ImportManifestEntry): boolean {
  return left.client === right.client &&
    left.relativePath === right.relativePath &&
    left.sha256 === right.sha256 &&
    left.sessionId === right.sessionId &&
    left.idempotencyKey === right.idempotencyKey &&
    left.state === right.state &&
    left.ompSessionId === right.ompSessionId;
}

/** Read and validate a manifest; a malformed file fails closed, never partial. */
export async function readImportManifest(path: string): Promise<ImportManifest> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    throw ioError(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportManifestError("MANIFEST_INVALID_JSON");
  }
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) throw new ImportManifestError("MANIFEST_INVALID_SCHEMA");
  // zod infers optionals as `T | undefined`; the runtime shape is validated, so
  // narrow to the exact-optional interface the module exports.
  return result.data as ImportManifest;
}

function ioError(error: unknown): ImportManifestError {
  const code = error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string"
    ? (error as NodeJS.ErrnoException).code!
    : "UNKNOWN";
  return new ImportManifestError(`MANIFEST_IO_${code}`);
}
