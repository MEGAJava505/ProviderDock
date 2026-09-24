import { spawn as spawnNodeProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
  createOperationDiagnostic,
  type OperationDiagnostic,
  type OperationStage,
} from "../../core/errors/operation-diagnostic.js";
import { projectOmpRpcControlFrame } from "./omp-rpc-projection.js";
import {
  OmpRuntimeError,
  type OmpPreflightResult,
  type OmpRuntimeSelection,
  type PreparedOmpRuntime,
} from "./omp-runtime.js";
import type {
  OmpRunRecord,
  OmpRunRepository,
  OmpRunState,
  OmpRunTransitionDetails,
} from "./omp-run-repository.js";

/** Narrow runtime seam: preflight is public-safe, prepare stays server-side only. */
export interface OmpSupervisorRuntime {
  preflight(selection: OmpRuntimeSelection): Promise<OmpPreflightResult>;
  prepare(runId: string, selection: OmpRuntimeSelection): Promise<PreparedOmpRuntime>;
}

/**
 * Structural child-process contract. Stdio is inherited for TUI so the real
 * user terminal/ConPTY is preserved; RPC uses private server-side pipes only.
 */
export interface OmpSupervisorChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}

export type OmpSupervisorSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => OmpSupervisorChild;

export interface OmpProcessSupervisorOptions {
  readonly runtime: OmpSupervisorRuntime;
  readonly runs: OmpRunRepository;
  readonly spawn?: OmpSupervisorSpawn;
  readonly initializationTimeoutMs?: number;
  readonly cancelGraceMs?: number;
  readonly rpcFrameLimitBytes?: number;
}

export type OmpSupervisorLaunchResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly runId: string; readonly diagnostic: OperationDiagnostic };

export class OmpProcessSupervisorError extends Error {
  constructor(readonly diagnostic: OperationDiagnostic) {
    super(diagnostic.message);
    this.name = "OmpProcessSupervisorError";
  }
}

interface TrackedRun {
  readonly runId: string;
  readonly mode: "tui" | "rpc";
  child: OmpSupervisorChild | undefined;
  chain: Promise<void>;
  cancelling: boolean;
  initialized: boolean;
  terminalQueued: boolean;
  exited: boolean;
  initTimer: NodeJS.Timeout | undefined;
  stateRequestId: string | undefined;
  readonly exitWaiters: (() => void)[];
}

const terminalStates: ReadonlySet<OmpRunState> =
  new Set(["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"]);

function defaultSpawn(
  command: string, args: readonly string[], options: SpawnOptions,
): OmpSupervisorChild {
  return spawnNodeProcess(command, args, options);
}

/**
 * Owns OMP process spawn and lifecycle. All persisted or returned data is a
 * safe run record/diagnostic: prepare() results, child environments, raw RPC
 * frames, and stderr text never cross this boundary.
 */
export class OmpProcessSupervisor {
  private readonly runtime: OmpSupervisorRuntime;
  private readonly runs: OmpRunRepository;
  private readonly spawnProcess: OmpSupervisorSpawn;
  private readonly initializationTimeoutMs: number;
  private readonly cancelGraceMs: number;
  private readonly rpcFrameLimitBytes: number;
  private readonly tracked = new Map<string, TrackedRun>();

  constructor(options: OmpProcessSupervisorOptions) {
    this.runtime = options.runtime;
    this.runs = options.runs;
    this.spawnProcess = options.spawn ?? defaultSpawn;
    this.initializationTimeoutMs = options.initializationTimeoutMs ?? 30_000;
    this.cancelGraceMs = options.cancelGraceMs ?? 10_000;
    this.rpcFrameLimitBytes = options.rpcFrameLimitBytes ?? 2 * 1024 * 1024;
  }

  async start(selection: OmpRuntimeSelection): Promise<OmpSupervisorLaunchResult> {
    const model = selection.route.models[0];
    if ((selection.mode !== "tui" && selection.mode !== "rpc") ||
      typeof model?.id !== "string") {
      throw new OmpProcessSupervisorError(
        createOperationDiagnostic({ code: "OMP_CONFIG_INVALID", stage: "validation" }));
    }
    const record = await this.runs.create({
      providerId: selection.route.profile.id,
      accountId: selection.route.accountId,
      modelId: model.id,
      projectDirectory: selection.projectDirectory,
      mode: selection.mode,
    });
    const entry: TrackedRun = {
      runId: record.runId, mode: selection.mode, child: undefined,
      chain: Promise.resolve(), cancelling: false, initialized: false,
      terminalQueued: false, exited: false, initTimer: undefined,
      stateRequestId: undefined, exitWaiters: [],
    };
    this.tracked.set(entry.runId, entry);

    const preflight = await this.runtime.preflight(selection);
    if (!preflight.ok) {
      await this.queueFailure(entry, preflight.diagnostic);
      return { ok: false, runId: record.runId, diagnostic: preflight.diagnostic };
    }
    await this.runs.transition(record.runId, "STARTING");

    let prepared: PreparedOmpRuntime;
    try {
      prepared = await this.runtime.prepare(record.runId, selection);
    } catch (error) {
      const diagnostic = error instanceof OmpRuntimeError ? error.diagnostic
        : createOperationDiagnostic({ code: "OPERATION_FAILED", stage: "validation" });
      await this.queueFailure(entry, diagnostic);
      return { ok: false, runId: record.runId, diagnostic };
    }

    let child: OmpSupervisorChild;
    try {
      child = this.spawnProcess(prepared.executable, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.environment,
        stdio: selection.mode === "rpc" ? ["pipe", "pipe", "pipe"] : "inherit",
        windowsHide: selection.mode === "rpc",
      });
    } catch {
      const diagnostic = createOperationDiagnostic({ code: "OMP_SPAWN_FAILED", stage: "process-spawn" });
      await this.queueFailure(entry, diagnostic);
      return { ok: false, runId: record.runId, diagnostic };
    }
    this.track(entry, child, prepared);
    return { ok: true, runId: record.runId };
  }

  async cancel(runId: string): Promise<OmpRunRecord | undefined> {
    const entry = this.tracked.get(runId);
    const child = entry?.child;
    if (!entry || !child) return this.runs.get(runId);
    entry.cancelling = true;
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (entry.mode === "rpc") {
      const stdin = child.stdin;
      if (stdin !== null && !stdin.writableEnded) {
        try {
          stdin.write(JSON.stringify({ id: randomUUID(), type: "abort" }) + "\n");
          stdin.end();
        } catch {
          // The close/termination paths below still own the outcome.
        }
      }
      await this.waitForExit(entry, this.cancelGraceMs);
    }
    if (!entry.exited) {
      // Stop only this run's child, never unrelated processes.
      child.kill();
      await this.waitForExit(entry, this.cancelGraceMs);
    }
    return this.runs.get(runId);
  }

  async getRun(runId: string): Promise<OmpRunRecord | undefined> {
    return this.runs.get(runId);
  }

  async listRuns(): Promise<readonly OmpRunRecord[]> {
    return this.runs.list();
  }

  /** Called by a restarted dashboard before showing run state. */
  async reconcileAfterRestart(): Promise<readonly OmpRunRecord[]> {
    const records = await this.runs.list();
    const interrupted: OmpRunRecord[] = [];
    for (const record of records) {
      if (terminalStates.has(record.state) || this.tracked.has(record.runId)) continue;
      try {
        interrupted.push(await this.runs.transition(record.runId, "INTERRUPTED", {
          diagnostic: createOperationDiagnostic({
            code: "OMP_SUPERVISOR_OWNERSHIP_LOST", stage: "shutdown",
          }),
        }));
      } catch {
        // Another writer changed the record; list() state remains authoritative.
      }
    }
    return interrupted;
  }

  private track(
    entry: TrackedRun, child: OmpSupervisorChild, prepared: PreparedOmpRuntime,
  ): void {
    entry.child = child;
    child.on("error", (error) => { void this.handleChildError(entry, error); });
    child.on("close", (code, signal) => { void this.handleChildClose(entry, code, signal); });
    if (entry.mode === "tui") {
      // A pid means the process started; it is still not agent readiness.
      if (child.pid !== undefined) {
        void this.queueTransition(entry, "TERMINAL_OPEN", { pid: child.pid })
          .catch(() => undefined);
      }
      return;
    }
    this.driveRpc(entry, child, prepared);
  }

  private driveRpc(
    entry: TrackedRun, child: OmpSupervisorChild, prepared: PreparedOmpRuntime,
  ): void {
    const stdout = child.stdout;
    const stdin = child.stdin;
    if (stdout === null || stdin === null) {
      void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
      return;
    }
    stdin.on("error", () => {
      if (entry.cancelling || entry.terminalQueued) return;
      void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
    });
    if (child.stderr !== null) {
      // Drain the private pipe so the child cannot block; content is never kept.
      child.stderr.on("data", () => undefined);
    }
    entry.initTimer = setTimeout(() => {
      entry.initTimer = undefined;
      if (entry.initialized || entry.terminalQueued) return;
      void this.failAndStop(entry, child, "OMP_INITIALIZATION_TIMEOUT", "agent-init");
    }, this.initializationTimeoutMs);
    entry.initTimer.unref?.();

    const expected = {
      providerId: prepared.rpcModel.providerId,
      modelId: prepared.rpcModel.modelId,
    };
    stdout.setEncoding("utf8");
    let buffer = "";
    stdout.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > this.rpcFrameLimitBytes) {
        void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
        return;
      }
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line !== "") {
          let frame: unknown;
          try { frame = JSON.parse(line); }
          catch {
            void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
            return;
          }
          this.handleRpcFrame(entry, child, frame, expected);
          if (entry.terminalQueued) return;
        }
        newline = buffer.indexOf("\n");
      }
    });
  }

  private handleRpcFrame(
    entry: TrackedRun, child: OmpSupervisorChild, frame: unknown,
    expected: { providerId: string; modelId: string },
  ): void {
    // Raw frames stay in this private handler only. The projection allowlists
    // lifecycle fields and drops model headers, prompts, and arbitrary text.
    const event = projectOmpRpcControlFrame(frame, {
      ...expected,
      requestId: entry.stateRequestId ?? "supervisor-unmatched",
    });
    if (event === undefined) return;
    if (event.type === "ready") {
      entry.initialized = true;
      if (entry.initTimer !== undefined) {
        clearTimeout(entry.initTimer);
        entry.initTimer = undefined;
      }
      void this.queueTransition(entry, "READY",
        child.pid === undefined ? {} : { pid: child.pid }).catch(() => undefined);
      const stdin = child.stdin;
      if (stdin !== null && !stdin.writableEnded && !entry.cancelling) {
        entry.stateRequestId = randomUUID();
        try {
          stdin.write(JSON.stringify({ id: entry.stateRequestId, type: "get_state" }) + "\n");
        } catch {
          void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
        }
      }
      return;
    }
    if (event.type === "state") {
      void this.queueTransition(entry, "RUNNING", {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        sessionId: event.sessionId,
      }).catch(() => undefined);
      return;
    }
    if (event.type === "aborted") return; // The close path settles CANCELLED.
    if (entry.cancelling) return;
    void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
  }

  private async handleChildError(entry: TrackedRun, _error: Error): Promise<void> {
    entry.exited = true;
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (!entry.terminalQueued) {
      entry.terminalQueued = true;
      // The raw error (paths, argv, environment) is deliberately discarded.
      const diagnostic = createOperationDiagnostic({
        code: entry.initialized ? "PROCESS_EXIT_UNKNOWN" : "OMP_SPAWN_FAILED",
        stage: entry.initialized ? "shutdown" : "process-spawn",
      });
      await this.queueTransition(entry, "FAILED", { diagnostic }).catch(() => undefined);
    }
    await entry.chain;
    for (const waiter of entry.exitWaiters.splice(0)) waiter();
    this.tracked.delete(entry.runId);
  }

  private async handleChildClose(
    entry: TrackedRun, code: number | null, signal: NodeJS.Signals | null,
  ): Promise<void> {
    entry.exited = true;
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (!entry.terminalQueued) {
    entry.terminalQueued = true;
    try {
      if (entry.cancelling) {
        await this.queueTransition(entry, "CANCELLED", {
          diagnostic: createOperationDiagnostic({ code: "OPERATION_CANCELLED", stage: "shutdown" }),
        });
      } else if (code === 0) {
        await this.queueTransition(entry, "SUCCEEDED");
      } else if (code !== null) {
        await this.queueTransition(entry, "FAILED", {
          diagnostic: createOperationDiagnostic({
            code: "PROCESS_EXIT_NONZERO",
            stage: entry.initialized ? "shutdown" : "agent-init",
            exitCode: code,
          }),
        });
      } else if (signal !== null) {
        await this.queueTransition(entry, "FAILED", {
          diagnostic: createOperationDiagnostic({
            code: "PROCESS_SIGNALLED",
            stage: entry.initialized ? "shutdown" : "agent-init",
          }),
        });
      } else {
        await this.queueTransition(entry, "FAILED", {
          diagnostic: createOperationDiagnostic({ code: "PROCESS_EXIT_UNKNOWN", stage: "shutdown" }),
        });
      }
    } catch {
      // The repository already reached a terminal state (for example after a
      // dashboard restart); persisted evidence remains authoritative.
    }
    }
    await entry.chain;
    for (const waiter of entry.exitWaiters.splice(0)) waiter();
    this.tracked.delete(entry.runId);
  }

  private async failAndStop(
    entry: TrackedRun, child: OmpSupervisorChild, code: string, stage: OperationStage,
  ): Promise<void> {
    if (entry.terminalQueued) return;
    await this.queueFailure(entry, createOperationDiagnostic({ code, stage }))
      .catch(() => undefined);
    child.kill();
  }

  private async queueFailure(entry: TrackedRun, diagnostic: OperationDiagnostic): Promise<OmpRunRecord> {
    entry.terminalQueued = true;
    return this.queueTransition(entry, "FAILED", { diagnostic });
  }

  private queueTransition(
    entry: TrackedRun, state: OmpRunState, details: OmpRunTransitionDetails = {},
  ): Promise<OmpRunRecord> {
    // Serialize intent order per run; the repository additionally serializes
    // and validates every successor transition under its writer lock.
    const task = entry.chain.then(() => this.runs.transition(entry.runId, state, details));
    entry.chain = task.then(() => undefined, () => undefined);
    return task;
  }

  private waitForExit(entry: TrackedRun, timeoutMs: number): Promise<void> {
    if (entry.exited) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        clearTimeout(timer);
        resolve();
      }, timeoutMs);
      timer.unref?.();
      const waiter = () => {
        clearTimeout(timer);
        resolve();
      };
      entry.exitWaiters.push(waiter);
    });
  }
}
