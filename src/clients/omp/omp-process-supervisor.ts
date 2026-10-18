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
  cancelUnconfirmed: boolean;
  initialized: boolean;
  running: boolean;
  spawnConfirmed: boolean;
  terminalQueued: boolean;
  exited: boolean;
  // A fault (RPC/init failure) has been detected for a still-live child but its
  // terminal FAILED is deferred until the child's own close confirms it stopped.
  // Holding the ORIGINAL safe cause here keeps a possibly-live child visible and
  // cancellable instead of hiding it behind an immediate terminal FAILED.
  pendingFailure: OperationDiagnostic | undefined;
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
  // Serializes every run-store write this supervisor issues. The store's writer
  // lock is fail-fast (EEXIST -> OMP_RUN_LOCKED, never stolen), so two of our own
  // runs writing at the same instant would make one lose the lock and drop its
  // transition. Funnelling our writes through one chain keeps siblings from
  // contending; a foreign process still fails closed exactly as before.
  private storeWrite: Promise<unknown> = Promise.resolve();

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
    // Register ownership BEFORE the run record is published. create() writes the
    // record file (visible via list()/get()) before its promise resolves, so a
    // cancel for the now-visible run can arrive in the window between publishing
    // the record and registering the tracked entry. Pre-generating the runId and
    // tracking it first makes the run OURS the instant it becomes visible: a cancel
    // in that window lands on this entry (never a stale VALIDATING with no saved
    // intent) and is honoured at the ownership point below, before any spawn.
    const runId = randomUUID();
    const entry: TrackedRun = {
      runId, mode: selection.mode, child: undefined,
      chain: Promise.resolve(), cancelling: false, cancelUnconfirmed: false,
      initialized: false, running: false, spawnConfirmed: false,
      terminalQueued: false, exited: false, pendingFailure: undefined,
      initTimer: undefined, stateRequestId: undefined, exitWaiters: [],
    };
    this.tracked.set(runId, entry);

    let record: OmpRunRecord;
    try {
      record = await this.serializeWrite(() => this.runs.create({
        runId,
        providerId: selection.route.profile.id,
        accountId: selection.route.accountId,
        modelId: model.id,
        projectDirectory: selection.projectDirectory,
        mode: selection.mode,
      }));
    } catch (error) {
      // The record was never published, so nothing outside can own this runId.
      // Drop the speculative ownership and surface the create failure unchanged.
      this.tracked.delete(runId);
      throw error;
    }
    // Ownership point -1: a cancel may have arrived in the publish->register window
    // (record visible, create() not yet returned). The entry was already tracked,
    // so entry.cancelling is set; settle CANCELLED without ever spawning.
    if (entry.cancelling) return this.settleCancelBeforeSpawn(entry, record.runId);

    const preflight = await this.runtime.preflight(selection);
    if (!preflight.ok) {
      await this.queueFailure(entry, preflight.diagnostic);
      return { ok: false, runId: record.runId, diagnostic: preflight.diagnostic };
    }
    // Ownership point 0: a cancel that arrived during preflight settles here,
    // before the STARTING transition, so we never attempt an invalid
    // CANCELLING -> STARTING edge when preflight outlived the cancel grace.
    if (entry.cancelling) return this.settleCancelBeforeSpawn(entry, record.runId);
    await this.serializeWrite(() => this.runs.transition(record.runId, "STARTING"));

    let prepared: PreparedOmpRuntime;
    try {
      prepared = await this.runtime.prepare(record.runId, selection);
    } catch (error) {
      const diagnostic = error instanceof OmpRuntimeError ? error.diagnostic
        : createOperationDiagnostic({ code: "OPERATION_FAILED", stage: "validation" });
      await this.queueFailure(entry, diagnostic);
      return { ok: false, runId: record.runId, diagnostic };
    }

    // Ownership point 1: a cancel that arrived while preflight/prepare were still
    // running settles the run here, before any process is spawned.
    if (entry.cancelling) return this.settleCancelBeforeSpawn(entry, record.runId);

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
    if (entry.cancelling) {
      // A cancel raced in during spawn: stop only this child. handleChildClose
      // settles CANCELLED because entry.cancelling is already set.
      this.safeKill(child);
    }
    return { ok: true, runId: record.runId };
  }

  private async settleCancelBeforeSpawn(
    entry: TrackedRun, runId: string,
  ): Promise<OmpSupervisorLaunchResult> {
    const diagnostic = createOperationDiagnostic({ code: "OPERATION_CANCELLED", stage: "shutdown" });
    if (!entry.terminalQueued) {
      entry.terminalQueued = true;
      entry.exited = true; // No child was ever spawned; nothing is left to wait on.
      await this.queueTransition(entry, "CANCELLED", { diagnostic }).catch(() => undefined);
    }
    await entry.chain;
    for (const waiter of entry.exitWaiters.splice(0)) waiter();
    this.tracked.delete(entry.runId);
    return { ok: false, runId, diagnostic };
  }

  async cancel(runId: string): Promise<OmpRunRecord | undefined> {
    const entry = this.tracked.get(runId);
    // Untracked means the run is already terminal (or was never ours): return
    // the persisted record and never signal a process this supervisor lost.
    if (!entry) return this.runs.get(runId);
    entry.cancelling = true;
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (entry.child === undefined) {
      // No child exists yet. Normally start() observes entry.cancelling at an
      // ownership point and settles the run (without spawning, or by stopping a
      // child it just created). Wait for that rather than report a stale state.
      await this.waitForExit(entry, this.cancelGraceMs);
      if (entry.exited || entry.terminalQueued) return this.runs.get(runId);
      // A child may have been spawned during the wait; stop that child instead.
      if (entry.child === undefined) {
        // preflight/prepare is still running past the grace window: the request
        // is real but unconfirmed. Stay non-terminal so start() can still settle
        // CANCELLED, and never report a confirmed cancel the caller cannot trust.
        await this.markStopUnconfirmed(entry);
        return this.runs.get(runId);
      }
    }
    return this.stopTrackedChild(entry, runId);
  }

  private async stopTrackedChild(
    entry: TrackedRun, runId: string,
  ): Promise<OmpRunRecord | undefined> {
    const child = entry.child;
    if (child === undefined) return this.runs.get(runId);
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
      // Stop only this run's child, never unrelated processes. A synchronous
      // throw or an undeliverable signal is absorbed by safeKill; the run then
      // settles below via its own close or as an unconfirmed stop.
      this.safeKill(child);
      await this.waitForExit(entry, this.cancelGraceMs);
    }
    if (!entry.exited) await this.markStopUnconfirmed(entry);
    return this.runs.get(runId);
  }

  private async markStopUnconfirmed(entry: TrackedRun): Promise<void> {
    // Ownership honesty: the stop could not be confirmed inside the grace
    // window. The child may still be alive (inference or a tool side-effect),
    // so we NEVER claim CANCELLED and NEVER mark a terminal FAILED that would
    // hide a live child. Instead move to the non-terminal CANCELLING state:
    //   * terminalQueued stays false, so the child's own close still settles
    //     the run (CANCELLED for a plain cancel, FAILED with the original cause
    //     when a fault was recorded) and a dashboard restart still reconciles
    //     to INTERRUPTED;
    //   * the entry stays tracked, so its close listener keeps observing it;
    //   * the run stays visible and cancellable, so an operator can retry
    //     (which re-signals only this run's own child, never a foreign PID).
    // Guaranteed hard termination is not asserted here; that stays unproven.
    if (entry.exited || entry.terminalQueued || entry.cancelUnconfirmed) return;
    entry.cancelUnconfirmed = true;
    // A fault-triggered stop keeps its original cause visible while unconfirmed;
    // a plain user cancel reports the unconfirmed-cancel code.
    const diagnostic = entry.pendingFailure
      ?? createOperationDiagnostic({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    await this.queueTransition(entry, "CANCELLING", { diagnostic }).catch(() => undefined);
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
        interrupted.push(await this.serializeWrite(() => this.runs.transition(record.runId, "INTERRUPTED", {
          diagnostic: createOperationDiagnostic({
            code: "OMP_SUPERVISOR_OWNERSHIP_LOST", stage: "shutdown",
          }),
        })));
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
    // A spawned OS process is exactly the one the OS handed back a pid for. An
    // asynchronous spawn failure (e.g. ENOENT) leaves pid undefined and emits
    // 'error' with no following 'close'; that is the ONLY case handleChildError
    // may settle terminally. Once a pid exists a later 'error' (a signal that
    // could not be delivered) is never proof the process died.
    entry.spawnConfirmed = child.pid !== undefined;
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
      // Once a stop has begun (cancel or recorded fault) the run is settling on
      // the child's own close; stop consuming and interpreting further frames so
      // no late frame can revive it or trip another fault.
      if (entry.terminalQueued || entry.exited ||
        entry.cancelling || entry.pendingFailure !== undefined) return;
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
          if (entry.terminalQueued || entry.cancelling ||
            entry.pendingFailure !== undefined) return;
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
    // Once a stop has begun — a user cancel, or a recorded fault whose terminal
    // settle is deferred to the child's own close — late lifecycle frames must
    // NOT advance the run to READY/RUNNING or start new control I/O. The run is
    // already on its way to a terminal outcome owned by that close.
    const stopping =
      entry.cancelling || entry.pendingFailure !== undefined || entry.terminalQueued;
    if (event.type === "ready") {
      if (stopping) return;
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
      if (stopping) return;
      // A projected state frame is the only confirmation that the RPC agent is
      // actually running; a later clean exit may then be treated as SUCCEEDED.
      entry.running = true;
      void this.queueTransition(entry, "RUNNING", {
        ...(child.pid === undefined ? {} : { pid: child.pid }),
        sessionId: event.sessionId,
      }).catch(() => undefined);
      return;
    }
    if (event.type === "aborted") return; // The close path settles the run.
    if (stopping) return;
    void this.failAndStop(entry, child, "OMP_RPC_PROTOCOL_ERROR", "agent-init");
  }

  private async handleChildError(entry: TrackedRun, _error: Error): Promise<void> {
    // Node emits 'error' both when a process fails to SPAWN and when a signal
    // (e.g. a kill) cannot be DELIVERED to an already-running child, and the
    // docs are explicit that 'close' may or may not follow. So 'error' by
    // itself is never proof the process exited.
    if (entry.spawnConfirmed) {
      // A real OS process exists. This error does not prove it died, so we keep
      // ownership and the 'close' listener rather than hide a possibly-live
      // child behind a terminal FAILED. If a cancel is in flight,
      // stopTrackedChild now falls through to markCancelUnconfirmed (the
      // non-terminal CANCELLING state); the child's own eventual 'close' still
      // settles exactly one terminal, and a dashboard restart reconciles the
      // non-terminal run to INTERRUPTED. We never set exited, never release
      // exit waiters, and never drop tracking on the strength of 'error' alone.
      return;
    }
    // No pid was ever assigned: the spawn genuinely failed before any process
    // existed, so this run settles terminally and does not linger in CANCELLING.
    entry.exited = true;
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (!entry.terminalQueued) {
      entry.terminalQueued = true;
      // The raw error (paths, argv, environment) is deliberately discarded.
      await this.queueTransition(entry, "FAILED", {
        diagnostic: createOperationDiagnostic({ code: "OMP_SPAWN_FAILED", stage: "process-spawn" }),
      }).catch(() => undefined);
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
      if (entry.pendingFailure !== undefined) {
        // A fault was recorded before this close and has result priority: settle
        // FAILED with the ORIGINAL safe cause, even on a clean exit 0. A user
        // cancel that arrived after the fault does not erase the recorded cause.
        await this.queueTransition(entry, "FAILED", { diagnostic: entry.pendingFailure });
      } else if (entry.cancelling) {
        await this.queueTransition(entry, "CANCELLED", {
          diagnostic: createOperationDiagnostic({ code: "OPERATION_CANCELLED", stage: "shutdown" }),
        });
      } else if (code === 0 && (entry.mode === "tui" || entry.running)) {
        // TUI: a closed terminal is process completion. RPC: only trust exit 0
        // once a projected state frame confirmed the run was actually running.
        await this.queueTransition(entry, "SUCCEEDED");
      } else if (code === 0) {
        // RPC child exited cleanly before a confirmed running lifecycle. Exit 0
        // is not evidence the task ran, so fail closed rather than fail open;
        // the outcome is genuinely unknown, distinct from a nonzero error exit.
        await this.queueTransition(entry, "FAILED", {
          diagnostic: createOperationDiagnostic({
            code: "PROCESS_EXIT_UNKNOWN",
            stage: "agent-init",
            exitCode: 0,
          }),
        });
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

  private safeKill(child: OmpSupervisorChild): void {
    // kill() can throw synchronously (or return false, or emit 'error') when a
    // signal cannot be delivered. None of those prove the process stopped, so a
    // throw here must never escape and leave a live child untracked: swallow it
    // and let the close / unconfirmed-stop paths own the final outcome.
    try {
      child.kill();
    } catch {
      // Undeliverable signal: handled as an unconfirmed stop by the caller.
    }
  }

  private async failAndStop(
    entry: TrackedRun, child: OmpSupervisorChild, code: string, stage: OperationStage,
  ): Promise<void> {
    // A detected RPC/init fault is a REASON to stop, never proof the child died.
    // Writing terminal FAILED first and killing afterwards would, on an
    // undeliverable kill, strand a still-live child behind a terminal record the
    // dashboard hides. So we record the ORIGINAL safe cause and defer the
    // terminal settle to the child's own close.
    if (entry.terminalQueued || entry.exited) return;
    // A user cancel that already began owns the stop and keeps result priority
    // (a fault arriving after an accepted cancel stays a cancel); a fault already
    // recorded is not overwritten by a later one.
    if (entry.cancelling || entry.pendingFailure !== undefined) return;
    const diagnostic = createOperationDiagnostic({ code, stage });
    if (entry.initTimer !== undefined) {
      clearTimeout(entry.initTimer);
      entry.initTimer = undefined;
    }
    if (!entry.spawnConfirmed) {
      // No pid was ever assigned, so there is no owned OS process whose close we
      // could wait for; settle terminally now rather than linger in CANCELLING.
      // Should a 'close' still arrive afterwards, terminalQueued makes it a
      // no-op — we do not assert whether such a close can or cannot occur.
      await this.queueFailure(entry, diagnostic).catch(() => undefined);
      this.safeKill(child);
      return;
    }
    // Live child (pid confirmed): keep the cause pending, begin stopping WITHOUT
    // a terminal FAILED, and let handleChildClose settle FAILED with this cause
    // even on a clean exit 0. If the stop is not confirmed within grace, surface
    // a non-terminal unconfirmed stop (CANCELLING) that stays cancellable.
    entry.pendingFailure = diagnostic;
    this.safeKill(child);
    await this.waitForExit(entry, this.cancelGraceMs);
    if (!entry.exited) await this.markStopUnconfirmed(entry);
  }

  private async queueFailure(entry: TrackedRun, diagnostic: OperationDiagnostic): Promise<OmpRunRecord> {
    entry.terminalQueued = true;
    return this.queueTransition(entry, "FAILED", { diagnostic });
  }

  /**
   * Run one repository write after every earlier supervisor write has settled.
   * queueTransition orders writes within a single run; this additionally keeps
   * two different runs from writing at the same instant, which the store's
   * fail-fast writer lock would reject (silently dropping a transition such as a
   * cancel's CANCELLED). A foreign process still fails closed exactly as before.
   */
  private serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.storeWrite.then(operation, operation);
    this.storeWrite = task.then(() => undefined, () => undefined);
    return task;
  }

  private queueTransition(
    entry: TrackedRun, state: OmpRunState, details: OmpRunTransitionDetails = {},
  ): Promise<OmpRunRecord> {
    // Serialize intent order per run; serializeWrite additionally serializes
    // across runs, and the repository validates every successor under its lock.
    const task = entry.chain.then(
      () => this.serializeWrite(() => this.runs.transition(entry.runId, state, details)),
    );
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
