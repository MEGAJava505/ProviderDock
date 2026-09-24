import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join, parse as parsePath, resolve, sep } from "node:path";
import { z } from "zod";
import { sanitizeOperationDiagnostic, type OperationDiagnostic } from "../../core/errors/operation-diagnostic.js";

const stateSchema = z.enum([
  "VALIDATING", "STARTING", "TERMINAL_OPEN", "READY", "RUNNING",
  "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED",
]);
export type OmpRunState = z.infer<typeof stateSchema>;

export interface OmpRunCreateInput {
  readonly providerId: string;
  readonly accountId: string;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly mode: "tui" | "rpc";
}

export interface OmpRunTransitionDetails {
  readonly pid?: number;
  readonly sessionId?: string;
  readonly diagnostic?: OperationDiagnostic;
}

export interface OmpRunRecord extends OmpRunCreateInput, OmpRunTransitionDetails {
  readonly runId: string;
  readonly state: OmpRunState;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly transitions: readonly { readonly state: OmpRunState; readonly at: string }[];
}

export interface OmpRunRepository {
  create(input: OmpRunCreateInput): Promise<OmpRunRecord>;
  get(runId: string): Promise<OmpRunRecord | undefined>;
  list(): Promise<readonly OmpRunRecord[]>;
  transition(runId: string, state: OmpRunState, details?: OmpRunTransitionDetails): Promise<OmpRunRecord>;
}

const identitySchema = z.string().min(1).max(1024)
  .refine((value) => value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value));
const createSchema = z.object({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  accountId: z.string().max(256).pipe(identitySchema),
  modelId: identitySchema,
  // Metadata only: existence, cwd access and process preflight belong to the caller.
  projectDirectory: z.string().refine(isSafeAbsolutePath),
  mode: z.enum(["tui", "rpc"]),
}).strict();
const detailsFields = {
  pid: z.number().int().positive().safe().optional(),
  sessionId: identitySchema.optional(),
  diagnostic: z.record(z.unknown()).transform(sanitizeOperationDiagnostic).optional(),
};
const detailsSchema = z.object(detailsFields).strict().transform(projectDetails);
const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const timeSchema = z.string().datetime().refine((value) =>
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const recordSchema = createSchema.extend({
  ...detailsFields,
  runId: idSchema,
  state: stateSchema,
  createdAt: timeSchema,
  updatedAt: timeSchema,
  transitions: z.array(z.object({ state: stateSchema, at: timeSchema }).strict()).min(1).max(6),
}).strict();
const maximumRecordBytes = 64 * 1024;
const maximumDirectoryEntries = 1000;
const transientRenameErrorCodes = new Set(["EACCES", "EBUSY", "EPERM"]);
const renameRetryDelaysMs = [10, 25, 50, 100, 200, 400, 800] as const;

const successors: Readonly<Record<OmpRunState, readonly OmpRunState[]>> = {
  VALIDATING: ["STARTING", "FAILED", "CANCELLED", "INTERRUPTED"],
  STARTING: ["TERMINAL_OPEN", "READY", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"],
  // Opening a terminal is NOT agent readiness. Evidence is the caller's responsibility.
  TERMINAL_OPEN: ["READY", "RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"],
  READY: ["RUNNING", "SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"],
  RUNNING: ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"],
  SUCCEEDED: [], FAILED: [], CANCELLED: [],
  // Lost supervisor ownership, not evidence that the child failed or exited.
  INTERRUPTED: [],
};

class RunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "OmpRunStorageError";
  }
}

function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) throw new RunError("OMP_RUN_INVALID_DATA");
  return result.data;
}

async function safely<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof RunError) throw error;
    // Never return filesystem paths, payloads, Zod issues or an unsafe cause.
    throw new RunError("OMP_RUN_IO_FAILED");
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}

function errorCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    ? String(error.code) : undefined;
}

async function renameWithRetry(source: string, destination: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, destination);
      return;
    } catch (error) {
      const delay = renameRetryDelaysMs[attempt];
      if (!transientRenameErrorCodes.has(errorCode(error) ?? "") || delay === undefined) {
        throw error;
      }
      await new Promise<void>((resolveDelay) => {
        setTimeout(resolveDelay, delay);
      });
    }
  }
}

function snapshot(record: OmpRunRecord): OmpRunRecord {
  return Object.freeze({
    ...record,
    transitions: Object.freeze(record.transitions.map((step) => Object.freeze({ ...step }))),
    ...(record.diagnostic ? { diagnostic: Object.freeze({ ...record.diagnostic }) } : {}),
  });
}

function projectDetails(value: {
  pid?: number | undefined; sessionId?: string | undefined; diagnostic?: OperationDiagnostic | undefined;
}): OmpRunTransitionDetails {
  return {
    ...(value.pid === undefined ? {} : { pid: value.pid }),
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.diagnostic === undefined ? {} : { diagnostic: value.diagnostic }),
  };
}

function validateRecord(value: unknown, runId: string): OmpRunRecord {
  const { pid, sessionId, diagnostic, ...record } = parse(recordSchema, value);
  const first = record.transitions[0]!;
  const last = record.transitions.at(-1)!;
  if (record.runId !== runId || first.state !== "VALIDATING" || first.at !== record.createdAt ||
      last.state !== record.state || last.at !== record.updatedAt ||
      record.transitions.some((step, index) => {
        const previous = record.transitions[index - 1];
        return previous && (step.at < previous.at || !successors[previous.state].includes(step.state));
      })) throw new RunError("OMP_RUN_INVALID_DATA");
  return { ...record, ...projectDetails({ pid, sessionId, diagnostic }) };
}

function isSafeAbsolutePath(value: string): boolean {
  if (!value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value) ||
      !isAbsolute(value) || /^[\\/]{2}/.test(value)) return false;
  const root = parsePath(value).root;
  if (process.platform === "win32" && !/^[a-z]:[\\/]$/i.test(root)) return false;
  if (process.platform !== "win32" && value.includes("\\")) return false;
  return value.slice(root.length).replace(/[\\/]$/, "").split(/[\\/]/).every((part) =>
    (part !== "" || value === root) && part !== "." && part !== ".." &&
    !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[1-9\u00b9\u00b2\u00b3]|lpt[1-9\u00b9\u00b2\u00b3])(?:\.|$)/i.test(part));
}

function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

function assertRegular(stat: BigIntStats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1n) throw new RunError("OMP_RUN_UNSAFE_PATH");
}

async function optionalStat(path: string): Promise<BigIntStats | undefined> {
  try { return await fs.lstat(path, { bigint: true }); }
  catch (error) {
    if (hasCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

/**
 * One UUID.json per run, 64 KiB maximum, at most 1,000 entries per list().
 * All writers share a fail-fast mkdir lock; abandoned locks require explicit
 * offline recovery, never PID probing or time-based stealing.
 *
 * Use an app-owned local directory with trusted ancestors/ACLs. Node has no
 * portable openat/renameat transaction: checks reject links and changed file
 * identities, but cannot defeat a hostile concurrent ancestor rename.
 */
export class FileOmpRunRepository implements OmpRunRepository {
  constructor(private readonly directory: string, private readonly clock: () => Date = () => new Date()) {}

  async create(input: OmpRunCreateInput): Promise<OmpRunRecord> {
    return safely(async () => {
      const selection = parse(createSchema, input);
      const at = parse(timeSchema, this.clock().toISOString());
      const record: OmpRunRecord = {
        ...selection, runId: randomUUID(), state: "VALIDATING", createdAt: at, updatedAt: at,
        transitions: [{ state: "VALIDATING", at }],
      };
      await this.withWriter(async (directory) => { await this.write(record, directory); });
      return snapshot(record);
    });
  }

  async get(runId: string): Promise<OmpRunRecord | undefined> {
    return safely(async () => {
      parse(idSchema, runId);
      if (!await this.checkDirectory(false)) return undefined;
      const stored = await this.read(runId);
      return stored ? snapshot(stored.record) : undefined;
    });
  }

  async list(): Promise<readonly OmpRunRecord[]> {
    return safely(async () => {
      if (!await this.checkDirectory(false)) return Object.freeze([]);
      const names: string[] = [];
      const directory = await fs.opendir(this.directory);
      let entries = 0;
      for await (const entry of directory) {
        if (++entries > maximumDirectoryEntries) throw new RunError("OMP_RUN_LIMIT_EXCEEDED");
        if (entry.name === ".writer.lock") {
          const stat = await optionalStat(join(this.directory, entry.name));
          if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new RunError("OMP_RUN_UNSAFE_PATH");
          continue;
        }
        if (entry.name.startsWith(".") && entry.name.endsWith(".tmp") &&
            idSchema.safeParse(entry.name.slice(1, -4)).success) {
          const stat = await optionalStat(join(this.directory, entry.name));
          if (stat) assertRegular(stat);
          continue; // In-flight or abandoned staging bytes are never run records.
        }
        if (!entry.name.endsWith(".json")) throw new RunError("OMP_RUN_INVALID_DATA");
        parse(idSchema, entry.name.slice(0, -5));
        names.push(entry.name);
      }
      const records: OmpRunRecord[] = [];
      for (const name of names.sort()) {
        const record = await this.get(name.slice(0, -5));
        if (!record) throw new RunError("OMP_RUN_CHANGED");
        records.push(record);
      }
      return Object.freeze(records);
    });
  }

  async transition(runId: string, state: OmpRunState, details: OmpRunTransitionDetails = {}): Promise<OmpRunRecord> {
    return safely(async () => {
      const additions = parse(detailsSchema, details);
      parse(idSchema, runId);
      parse(stateSchema, state);
      return this.withWriter(async (directory) => {
        const stored = await this.read(runId);
        if (!stored) throw new RunError("OMP_RUN_NOT_FOUND");
        const previous = stored.record;
        if (!successors[previous.state].includes(state)) throw new RunError("OMP_RUN_INVALID_TRANSITION");
        const at = parse(timeSchema, this.clock().toISOString());
        if (at < previous.updatedAt) throw new RunError("OMP_RUN_INVALID_CLOCK");
        const record: OmpRunRecord = {
          ...previous, ...additions, state, updatedAt: at,
          transitions: [...previous.transitions, { state, at }],
        };
        await this.write(record, directory, stored.stat);
        return snapshot(record);
      });
    });
  }

  private async checkDirectory(create: boolean, expected?: BigIntStats): Promise<BigIntStats | undefined> {
    if (typeof this.directory !== "string" || !isSafeAbsolutePath(this.directory) ||
        resolve(this.directory) === parsePath(this.directory).root) throw new RunError("OMP_RUN_UNSAFE_PATH");
    const absolute = resolve(this.directory);
    let current = parsePath(absolute).root;
    let stat: BigIntStats | undefined;
    for (const part of absolute.slice(current.length).split(sep)) {
      current = join(current, part);
      stat = await optionalStat(current);
      if (!stat && create) {
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
        stat = await optionalStat(current);
      }
      if (!stat) {
        if (expected) throw new RunError("OMP_RUN_CHANGED");
        return undefined;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new RunError("OMP_RUN_UNSAFE_PATH");
    }
    const key = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
    if (key(await fs.realpath(absolute)) !== key(absolute) || (expected && !sameIdentity(stat!, expected))) {
      throw new RunError("OMP_RUN_UNSAFE_PATH");
    }
    return stat;
  }

  private async withWriter<T>(operation: (directory: BigIntStats) => Promise<T>): Promise<T> {
    const directory = (await this.checkDirectory(true))!;
    const lock = join(this.directory, ".writer.lock");
    try { await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (hasCode(error, "EEXIST")) throw new RunError("OMP_RUN_LOCKED");
      throw error;
    }
    const owned = await fs.lstat(lock, { bigint: true });
    try {
      await this.checkDirectory(false, directory);
      if (!owned.isDirectory() || owned.isSymbolicLink()) throw new RunError("OMP_RUN_UNSAFE_PATH");
      return await operation(directory);
    } finally {
      await this.checkDirectory(false, directory);
      const current = await fs.lstat(lock, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameIdentity(current, owned)) {
        throw new RunError("OMP_RUN_CHANGED");
      }
      await fs.rmdir(lock); // Only our empty lock, never recursive or another owner's lock.
    }
  }

  private async read(runId: string): Promise<{ record: OmpRunRecord; stat: BigIntStats } | undefined> {
    const file = join(this.directory, `${runId}.json`);
    const stat = await optionalStat(file);
    if (!stat) return undefined;
    assertRegular(stat);
    if (stat.size > BigInt(maximumRecordBytes)) throw new RunError("OMP_RUN_LIMIT_EXCEEDED");
    const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const opened = await handle.stat({ bigint: true });
      assertRegular(opened);
      if (!sameFile(opened, stat)) throw new RunError("OMP_RUN_CHANGED");
      // Fixed allocation and bounded reads even if a non-cooperating writer grows the file.
      const buffer = Buffer.alloc(maximumRecordBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
      }
      if (length > maximumRecordBytes) throw new RunError("OMP_RUN_LIMIT_EXCEEDED");
      const after = await handle.stat({ bigint: true });
      assertRegular(after);
      if (BigInt(length) !== stat.size || !sameFile(after, stat)) throw new RunError("OMP_RUN_CHANGED");
      const bytes = buffer.subarray(0, length);
      if (bytes.includes(0)) throw new RunError("OMP_RUN_INVALID_DATA");
      const record = validateRecord(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), runId);
      return { record, stat };
    } finally { await handle.close(); }
  }

  private async write(record: OmpRunRecord, directory: BigIntStats, previous?: BigIntStats): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(validateRecord(record, record.runId)) + "\n");
    if (bytes.length > maximumRecordBytes) throw new RunError("OMP_RUN_LIMIT_EXCEEDED");
    const destination = join(this.directory, `${record.runId}.json`);
    const temporary = join(this.directory, `.${randomUUID()}.tmp`);
    await this.checkDirectory(false, directory);
    const handle = await fs.open(temporary, "wx", 0o600);
    let owned: BigIntStats | undefined;
    let written: BigIntStats;
    try {
      try {
        owned = await handle.stat({ bigint: true });
        assertRegular(owned);
        await handle.writeFile(bytes);
        written = await handle.stat({ bigint: true });
        await handle.sync();
      } finally { await handle.close(); }
      await this.checkDirectory(false, directory);
      const current = await optionalStat(destination);
      if (current) assertRegular(current);
      if (previous ? !current || !sameFile(current, previous) : current !== undefined) {
        throw new RunError("OMP_RUN_CHANGED");
      }
      const staged = await fs.lstat(temporary, { bigint: true });
      assertRegular(staged);
      if (!sameIdentity(staged, owned) || !sameFile(staged, written) || staged.size !== BigInt(bytes.length)) {
        throw new RunError("OMP_RUN_CHANGED");
      }
      // No unlink-before-rename fallback: failed replacement leaves old good bytes intact.
      await renameWithRetry(temporary, destination);
    } finally {
      await this.checkDirectory(false, directory);
      const remaining = await optionalStat(temporary);
      if (remaining) {
        assertRegular(remaining);
        if (!owned || !sameIdentity(remaining, owned)) throw new RunError("OMP_RUN_CHANGED");
        await fs.unlink(temporary);
      }
    }
  }
}
