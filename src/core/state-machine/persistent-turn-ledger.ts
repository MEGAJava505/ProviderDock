import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import {
  TurnLedger,
  turnStates,
  type TurnAdmission,
  type TurnLedgerOptions,
  type TurnLedgerSnapshot,
  type TurnSignature,
  type TurnState,
  type TurnToken,
  type TurnToolCall,
} from "./turn-ledger.js";

const turnRecordSchema = z
  .object({
    fingerprint: z.string().min(1),
    state: z.enum(turnStates),
    streamStarted: z.boolean(),
    toolActivity: z.boolean(),
    replayUnsafe: z.boolean(),
    attempt: z.number().int().positive(),
    updatedAtMs: z.number().int().nonnegative(),
  })
  .strict();

const toolCallRecordSchema = z
  .object({
    callId: z.string().min(1),
    name: z.string(),
    argumentsHash: z.string().min(1),
    resolved: z.boolean(),
    resultHash: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((record, context) => {
    if (record.resolved && record.resultHash === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "A resolved tool call must retain its result hash.",
        path: ["resultHash"],
      });
    }
    if (!record.resolved && record.resultHash !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "An unresolved tool call cannot have a result hash.",
        path: ["resultHash"],
      });
    }
  });

const turnLedgerSnapshotSchema = z
  .object({
    version: z.literal(1),
    turns: z.array(turnRecordSchema).max(16_384),
    toolCalls: z.array(toolCallRecordSchema).max(65_536),
  })
  .strict();

export interface TurnLedgerStore {
  load(): Promise<TurnLedgerSnapshot | undefined>;
  save(snapshot: TurnLedgerSnapshot): Promise<void>;
}

export class TurnLedgerPersistenceError extends Error {
  constructor(message: string, options: { readonly cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = "TurnLedgerPersistenceError";
  }
}

export interface FileTurnLedgerStoreOptions {
  readonly filePath: string;
  readonly maxFileBytes?: number;
}

/**
 * Crash-safe JSON snapshot store. It contains request/tool hashes and state
 * only; provider credentials and raw prompts/results are never written.
 */
export class FileTurnLedgerStore implements TurnLedgerStore {
  readonly filePath: string;
  private readonly maxFileBytes: number;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(options: FileTurnLedgerStoreOptions) {
    if (options.filePath.trim() === "") {
      throw new TypeError("A turn ledger file path is required.");
    }
    this.filePath = resolve(options.filePath);
    this.maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxFileBytes) || this.maxFileBytes < 1) {
      throw new RangeError("maxFileBytes must be a positive safe integer.");
    }
  }

  async load(): Promise<TurnLedgerSnapshot | undefined> {
    let contents: Buffer;
    try {
      contents = await readFile(this.filePath);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new TurnLedgerPersistenceError("Unable to read the turn ledger snapshot.", {
        cause: error,
      });
    }
    if (contents.byteLength > this.maxFileBytes) {
      throw new TurnLedgerPersistenceError(
        `Turn ledger snapshot exceeds the configured ${this.maxFileBytes}-byte limit.`,
      );
    }

    try {
      return turnLedgerSnapshotSchema.parse(
        JSON.parse(contents.toString("utf8")) as unknown,
      ) as TurnLedgerSnapshot;
    } catch (error) {
      throw new TurnLedgerPersistenceError(
        "Turn ledger snapshot is corrupt or uses an unsupported schema.",
        { cause: error },
      );
    }
  }

  save(snapshot: TurnLedgerSnapshot): Promise<void> {
    const detached = turnLedgerSnapshotSchema.parse(snapshot) as TurnLedgerSnapshot;
    const task = this.writeQueue.then(() => this.writeSnapshot(detached));
    this.writeQueue = task.catch(() => undefined);
    return task;
  }

  private async writeSnapshot(snapshot: TurnLedgerSnapshot): Promise<void> {
    const encoded = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    if (encoded.byteLength > this.maxFileBytes) {
      throw new TurnLedgerPersistenceError(
        `Turn ledger snapshot exceeds the configured ${this.maxFileBytes}-byte limit.`,
      );
    }

    const directory = dirname(this.filePath);
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(temporaryPath, encoded, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw new TurnLedgerPersistenceError(
        "Unable to atomically persist the turn ledger snapshot.",
        { cause: error },
      );
    }
  }
}

export interface PersistentTurnLedgerOptions
  extends Omit<TurnLedgerOptions, "initialSnapshot"> {
  readonly store?: TurnLedgerStore;
}

/**
 * Async persistence boundary used by both bridges. Every accepted mutation is
 * durably saved before its caller may contact upstream or forward a tool call.
 */
export class PersistentTurnLedger {
  private ledger: TurnLedger;
  private readonly ledgerOptions: Omit<TurnLedgerOptions, "initialSnapshot">;
  private readonly store: TurnLedgerStore | undefined;
  private initializeTask: Promise<void> | undefined;
  private mutationQueue: Promise<void> = Promise.resolve();
  private initialized = false;
  private failure: TurnLedgerPersistenceError | undefined;

  constructor(options: PersistentTurnLedgerOptions = {}) {
    const { store, ...ledgerOptions } = options;
    this.store = store;
    this.ledgerOptions = ledgerOptions;
    this.ledger = new TurnLedger(ledgerOptions);
  }

  initialize(): Promise<void> {
    if (this.initialized) return Promise.resolve();
    if (this.failure !== undefined) return Promise.reject(this.failure);
    if (this.initializeTask !== undefined) return this.initializeTask;
    this.initializeTask = this.hydrate().finally(() => {
      this.initializeTask = undefined;
    });
    return this.initializeTask;
  }

  async admit(signature: TurnSignature): Promise<TurnAdmission> {
    await this.initialize();
    return this.serialize(async () => {
      this.assertHealthy();
      const admission = this.ledger.admit(signature);
      if (admission.decision === "accepted") await this.persist();
      return admission;
    });
  }

  async markStreamStarted(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.markStreamStarted(token));
  }

  async markToolActivity(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.markToolActivity(token));
  }

  async recordDeliveredToolCalls(
    token: TurnToken,
    calls: readonly TurnToolCall[],
  ): Promise<void> {
    if (calls.length === 0) return;
    await this.mutate(() => this.ledger.recordDeliveredToolCalls(token, calls));
  }

  async complete(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.complete(token));
  }

  async fail(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.fail(token));
  }

  async cancel(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.cancel(token));
  }

  async incomplete(token: TurnToken): Promise<void> {
    await this.mutate(() => this.ledger.incomplete(token));
  }

  stateOf(fingerprint: string): TurnState | undefined {
    this.assertHealthy();
    return this.ledger.stateOf(fingerprint);
  }

  private async hydrate(): Promise<void> {
    try {
      const snapshot = await this.store?.load();
      if (snapshot !== undefined) {
        this.ledger = new TurnLedger({
          ...this.ledgerOptions,
          initialSnapshot: snapshot,
        });
        if (this.ledger.recoverInterruptedTurns()) await this.persistSnapshot();
      }
      this.initialized = true;
    } catch (error) {
      const failure =
        error instanceof TurnLedgerPersistenceError
          ? error
          : new TurnLedgerPersistenceError("Unable to initialize the turn ledger.", {
              cause: error,
            });
      this.failure = failure;
      throw failure;
    }
  }

  private async mutate(operation: () => void): Promise<void> {
    await this.initialize();
    await this.serialize(async () => {
      this.assertHealthy();
      operation();
      await this.persist();
    });
  }

  private async persist(): Promise<void> {
    try {
      await this.persistSnapshot();
      this.assertHealthy();
    } catch (error) {
      const failure =
        error instanceof TurnLedgerPersistenceError
          ? error
          : new TurnLedgerPersistenceError("Unable to persist the turn ledger.", {
              cause: error,
            });
      this.failure = failure;
      throw failure;
    }
  }

  private async persistSnapshot(): Promise<void> {
    await this.store?.save(this.ledger.snapshot());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.mutationQueue.then(operation);
    this.mutationQueue = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }

  private assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
