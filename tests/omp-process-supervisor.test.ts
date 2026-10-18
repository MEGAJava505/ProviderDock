import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { PassThrough } from "node:stream";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OmpProcessSupervisor,
  OmpProcessSupervisorError,
  type OmpSupervisorChild,
  type OmpSupervisorRuntime,
  type OmpSupervisorSpawn,
} from "../src/clients/omp/omp-process-supervisor.js";
import {
  FileOmpRunRepository,
  type OmpRunRecord,
  type OmpRunRepository,
} from "../src/clients/omp/omp-run-repository.js";
import {
  OmpRuntimeError,
  type OmpPreflightResult,
  type OmpRuntimeSelection,
  type PreparedOmpRuntime,
} from "../src/clients/omp/omp-runtime.js";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import { createOperationDiagnostic } from "../src/core/errors/operation-diagnostic.js";
import { projectOmpRpcControlFrame } from "../src/clients/omp/omp-rpc-projection.js";

const secretValue = "fixture-secret-never-persist";
const sessionId = "01994b10-aaaa-7000-8000-aaaaaaaaaaaa";
const roots: string[] = [];
const waitForIo = { timeout: 15_000, interval: 20 };

afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

class FakeChildProcess extends EventEmitter implements OmpSupervisorChild {
  readonly pid: number | undefined;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killCalls: (string | undefined)[] = [];
  closed = false;

  constructor(pid = 4242) { super(); this.pid = pid; }

  override on(event: "error", listener: (error: Error) => void): this;
  override on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this;
  override on(event: string, listener: (...args: never[]) => void): this {
    super.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.killCalls.push(signal);
    if (!this.closed) setImmediate(() => this.close(null, signal ?? "SIGTERM"));
    return true;
  }

  close(code: number | null, signal: NodeJS.Signals | null): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close", code, signal);
  }

  fail(error: Error): void { this.emit("error", error); }

  frame(value: unknown): void { this.stdout.write(JSON.stringify(value) + "\n"); }
}

/**
 * Reconfigures a fake child so kill() models Node's undeliverable-signal path:
 * it records the attempt, synchronously emits an 'error' (code EPERM) and
 * returns false, and crucially never emits 'close'. The Node docs are explicit
 * that a spawned child which cannot be signalled is still alive and that 'close'
 * may or may not follow an 'error', so 'error' here is NOT proof of exit and the
 * child keeps its positive pid. The supervisor must not read either as death.
 */
function killEmitsUndeliverableError(child: FakeChildProcess): FakeChildProcess {
  child.kill = ((signal?: NodeJS.Signals): boolean => {
    child.killCalls.push(signal);
    child.emit("error", Object.assign(new Error("kill EPERM"), { code: "EPERM" }));
    return false;
  }) as typeof child.kill;
  return child;
}

/**
 * A child that models a genuine spawn failure (e.g. ENOENT): the OS never
 * assigns a pid, so child.pid stays undefined and Node emits 'error' with no
 * 'close'. This is the ONE case a supervisor may settle terminally from 'error'
 * alone — unlike a live child whose kill could not be delivered, it must never
 * linger in CANCELLING. (new FakeChildProcess(undefined) cannot express this:
 * the constructor's `pid = 4242` default replaces an explicit undefined.)
 */
function spawnFailedChild(): FakeChildProcess {
  const child = new FakeChildProcess();
  (child as { pid: number | undefined }).pid = undefined;
  return child;
}

/**
 * Wraps a repository with the run store's fail-fast writer-lock contract made
 * deterministic: a create/transition that begins while another write is still
 * in flight throws OMP_RUN_LOCKED, exactly as the real mkdir lock does (it is
 * never stolen or queued). The supervisor must serialize its own runs' writes
 * so a sibling run can never trip this lock and drop a transition such as a
 * cancel's CANCELLED. Reads never lock, matching the file repository.
 */
function withFailFastWriterLock(inner: OmpRunRepository): OmpRunRepository {
  let writing = false;
  const guard = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (writing) throw new Error("OMP_RUN_LOCKED");
    writing = true;
    try {
      await Promise.resolve(); // hold the lock across a turn so a racing write sees it
      return await operation();
    } finally {
      writing = false;
    }
  };
  return {
    create: (input) => guard(() => inner.create(input)),
    transition: (runId, state, details) => guard(() => inner.transition(runId, state, details)),
    get: (runId) => inner.get(runId),
    list: () => inner.list(),
  };
}

interface Fixture {
  readonly root: string;
  readonly runs: OmpRunRepository;
  readonly selection: OmpRuntimeSelection;
  readonly runtime: {
    preflight: ReturnType<typeof vi.fn>;
    prepare: ReturnType<typeof vi.fn>;
    prepared: PreparedOmpRuntime;
  };
  spawn: ReturnType<typeof vi.fn>;
  supervisor: OmpProcessSupervisor;
  child: FakeChildProcess;
  children: FakeChildProcess[];
  commands: { id: string; type: string }[];
  respondToControlCommands: () => void;
}

async function fixture(
  mode: "tui" | "rpc",
  child = new FakeChildProcess(),
  overrides: {
    readonly cancelGraceMs?: number;
    readonly initializationTimeoutMs?: number;
    readonly rpcFrameLimitBytes?: number;
    // Wraps the repository the SUPERVISOR sees (fixture.runs stays the inner store
    // so test reads never touch the wrapper). Used to model the publish->register
    // window by holding create()'s RETURN after the record is already written.
    readonly wrapRuns?: (inner: OmpRunRepository) => OmpRunRepository;
  } = {},
): Promise<Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "omp-supervisor-"));
  roots.push(root);
  const projectDirectory = join(root, "project");
  await fs.mkdir(projectDirectory);
  const runs: OmpRunRepository = new FileOmpRunRepository(join(root, "runs"));
  const supervisorRuns = overrides.wrapRuns ? overrides.wrapRuns(runs) : runs;
  const selection: OmpRuntimeSelection = {
    route: {
      profile: parseProviderProfile({
        id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1",
        apiType: "openai-chat-completions", auth: { kind: "bearer", secretRef: "fixture.key" },
      }),
      accountId: "chosen-account", allowedOrigins: ["https://fixture.invalid"],
      models: [{ id: "model-one", contextWindow: 8192, maxTokens: 256 }],
    },
    projectDirectory, mode, permissionAcknowledgement: "read-only-pilot-no-sandbox",
  };
  const prepared: PreparedOmpRuntime = {
    executable: join(root, "omp.exe"),
    args: ["--model", "dock-fixture-fingerprint/model-one", ...(mode === "rpc" ? ["--mode", "rpc"] : [])],
    cwd: projectDirectory,
    environment: { PROVIDERDOCK_OMP_FIXTURE_SECRET: secretValue },
    homeDirectory: join(root, "managed", "scope", "runs", "fixture"),
    agentDirectory: join(root, "managed", "scope", "runs", "fixture", "agent"),
    sessionsDirectory: join(root, "managed", "scope", "sessions"),
    rpcModel: { providerId: "dock-fixture-fingerprint", modelId: "model-one" },
  };
  const runtime = {
    preflight: vi.fn(async (): Promise<OmpPreflightResult> => ({
      ok: true, providerId: "fixture", accountId: "chosen-account",
      modelId: "model-one", api: "openai-completions" as const,
    })),
    prepare: vi.fn(async (): Promise<PreparedOmpRuntime> => prepared),
    prepared,
  };
  const commands: { id: string; type: string }[] = [];
  child.stdin.setEncoding("utf8");
  child.stdin.on("data", (chunk: string) => {
    for (const line of chunk.split("\n").filter(Boolean)) commands.push(JSON.parse(line));
  });
  // Extra children let a single supervisor drive more than one concurrent run;
  // the first spawn without a queued child falls back to the default one.
  const children: FakeChildProcess[] = [];
  const spawn = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions) => children.shift() ?? child,
  );
  const supervisor = new OmpProcessSupervisor({
    runtime: runtime as OmpSupervisorRuntime,
    runs: supervisorRuns,
    spawn: spawn as unknown as OmpSupervisorSpawn,
    // File-repository transitions can take hundreds of milliseconds while the
    // full Vitest matrix is contending for Windows I/O. Keep the fake lifecycle
    // deadlines short but comfortably above scheduler and disk jitter.
    initializationTimeoutMs: overrides.initializationTimeoutMs ?? 500,
    cancelGraceMs: overrides.cancelGraceMs ?? 1_000,
    ...(overrides.rpcFrameLimitBytes !== undefined
      ? { rpcFrameLimitBytes: overrides.rpcFrameLimitBytes }
      : {}),
  });
  return {
    root, runs, selection, runtime, spawn, supervisor, child, children, commands,
    respondToControlCommands: () => {
      for (const command of commands) {
        if (command.type === "get_state") {
          child.frame({
            type: "response", id: command.id, command: "get_state", success: true,
            data: {
              model: {
                id: "model-one", provider: "dock-fixture-fingerprint",
                headers: { Authorization: `Bearer ${secretValue}` },
              },
              sessionId, isStreaming: false,
            },
          });
        }
      }
    },
  };
}

async function waitForState(
  runs: OmpRunRepository, runId: string, state: OmpRunRecord["state"],
): Promise<OmpRunRecord> {
  return vi.waitFor(async () => {
    const record = await runs.get(runId);
    expect(record?.state).toBe(state);
    return record!;
  }, waitForIo);
}

async function waitForTerminal(
  runs: OmpRunRepository, runId: string,
): Promise<OmpRunRecord> {
  return vi.waitFor(async () => {
    const record = await runs.get(runId);
    expect(record !== undefined &&
      ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(record.state)).toBe(true);
    return record!;
  }, waitForIo);
}

async function startAndWaitForRunning(f: Fixture): Promise<OmpRunRecord> {
  const result = await f.supervisor.start(f.selection);
  expect(result).toEqual({ ok: true, runId: expect.any(String) });
  const runId = result.ok ? result.runId : "";
  setImmediate(() => f.child.frame({ type: "ready", protocolVersion: 1 }));
  await vi.waitFor(
    () => expect(f.commands.some((command) => command.type === "get_state")).toBe(true),
    waitForIo,
  );
  f.respondToControlCommands();
  return waitForState(f.runs, runId, "RUNNING");
}

// The three ways a live child can refuse a kill: emit an undeliverable 'error'
// (EPERM) and return false, plainly return false, or throw synchronously. None
// of them prove the process died and none emit 'close', so under every variant
// a fault-stopped run must stay non-terminal until the child's own close.
type KillVariant = "undeliverable-error" | "returns-false" | "throws";
function applyKillVariant(child: FakeChildProcess, variant: KillVariant): FakeChildProcess {
  if (variant === "undeliverable-error") return killEmitsUndeliverableError(child);
  child.kill = ((signal?: NodeJS.Signals): boolean => {
    child.killCalls.push(signal);
    if (variant === "throws") throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    return false; // signal refused; the child stays alive and never emits 'close'
  }) as typeof child.kill;
  return child;
}

// Shared contract for every "a detected fault is a REASON to stop, never proof
// of death" case. After the fault the still-live child is non-terminal
// CANCELLING carrying the ORIGINAL safe cause and has been signalled; only its
// own close then settles exactly one terminal FAILED with that same cause —
// even on a clean exit 0 (a stop must never be reported as SUCCEEDED/CANCELLED).
async function expectFaultDefersTerminalUntilClose(
  f: Fixture, live: FakeChildProcess, runId: string, expectedCode: string,
): Promise<OmpRunRecord> {
  const cancelling = await waitForState(f.runs, runId, "CANCELLING");
  expect(cancelling.state).not.toBe("FAILED");
  expect(cancelling.diagnostic).toMatchObject({ code: expectedCode, stage: "agent-init" });
  expect(live.closed).toBe(false);
  expect(live.killCalls.length).toBeGreaterThan(0);
  const listed = (await f.supervisor.listRuns()).find((run) => run.runId === runId);
  expect(listed?.state).toBe("CANCELLING");
  live.close(0, "SIGTERM"); // a clean exit 0 must NOT be mistaken for SUCCEEDED
  const settled = await waitForState(f.runs, runId, "FAILED");
  expect(settled.diagnostic).toMatchObject({ code: expectedCode, stage: "agent-init" });
  const states = settled.transitions.map((step) => step.state);
  expect(states.slice(-2)).toEqual(["CANCELLING", "FAILED"]);
  expect(states).not.toContain("CANCELLED");
  expect(states).not.toContain("SUCCEEDED");
  expect(states).not.toContain("RUNNING");
  expect(states.filter((state) =>
    ["SUCCEEDED", "FAILED", "CANCELLED", "INTERRUPTED"].includes(state))).toEqual(["FAILED"]);
  return settled;
}

// Existing RPC-failure inputs that all reach failAndStop on a live (pid) child.
// They share ONE contract (expectFaultDefersTerminalUntilClose), so a single
// table is legitimate here; the get_state-write and null-pipe rows legitimately
// pass through READY first, which the shared contract permits.
interface FaultInputRow {
  readonly name: string;
  readonly code: string;
  readonly overrides: {
    readonly cancelGraceMs: number;
    readonly rpcFrameLimitBytes?: number;
  };
  readonly makeChild: (pid: number) => FakeChildProcess;
  readonly trigger: (live: FakeChildProcess) => void;
}
const faultInputs: readonly FaultInputRow[] = [
  {
    name: "an invalid JSON frame",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40 },
    makeChild: (pid) => killEmitsUndeliverableError(new FakeChildProcess(pid)),
    trigger: (live) => { live.stdout.write("this-is-not-json\n"); },
  },
  {
    name: "a ready frame with an unsupported protocol version",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40 },
    makeChild: (pid) => killEmitsUndeliverableError(new FakeChildProcess(pid)),
    trigger: (live) => { live.frame({ type: "ready", protocolVersion: 999 }); },
  },
  {
    name: "a stdin stream error",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40 },
    makeChild: (pid) => killEmitsUndeliverableError(new FakeChildProcess(pid)),
    trigger: (live) =>
      { live.stdin.emit("error", Object.assign(new Error("EPIPE"), { code: "EPIPE" })); },
  },
  {
    name: "an oversized frame",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40, rpcFrameLimitBytes: 64 },
    makeChild: (pid) => killEmitsUndeliverableError(new FakeChildProcess(pid)),
    trigger: (live) => { live.stdout.write("x".repeat(128)); },
  },
  {
    name: "a get_state control write that throws after readiness",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40 },
    makeChild: (pid) => {
      const live = killEmitsUndeliverableError(new FakeChildProcess(pid));
      // The private control channel refuses the post-readiness get_state write.
      (live.stdin as unknown as { write: () => never }).write = () => {
        throw Object.assign(new Error("EPIPE"), { code: "EPIPE" });
      };
      return live;
    },
    trigger: (live) => { live.frame({ type: "ready", protocolVersion: 1 }); },
  },
  {
    name: "a missing stdout pipe",
    code: "OMP_RPC_PROTOCOL_ERROR",
    overrides: { cancelGraceMs: 40 },
    makeChild: (pid) => {
      const live = killEmitsUndeliverableError(new FakeChildProcess(pid));
      // A spawned child (real pid) whose stdout pipe never opened: driveRpc must
      // fault immediately, and because a pid exists it defers to the child close.
      (live as unknown as { stdout: null }).stdout = null;
      return live;
    },
    trigger: () => undefined,
  },
];

describe("OMP process supervisor lifecycle (fake children only)", { timeout: 30_000 }, () => {
  it("persistently fails when preflight rejects the route before spawn", async () => {
    const f = await fixture("rpc");
    const diagnostic = createOperationDiagnostic({ code: "CREDENTIAL_MISSING", stage: "credentials" });
    f.runtime.preflight.mockResolvedValue({ ok: false, diagnostic });
    const result = await f.supervisor.start(f.selection);
    expect(result).toEqual({ ok: false, runId: expect.any(String), diagnostic });
    const record = await f.runs.get(result.ok ? "" : result.runId);
    expect(record).toMatchObject({ state: "FAILED", diagnostic });
    expect(f.runtime.prepare).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("persistently fails when preparation fails and never spawns", async () => {
    const f = await fixture("rpc");
    const diagnostic = createOperationDiagnostic({ code: "OMP_RUNTIME_DIRECTORY_UNAVAILABLE", stage: "storage" });
    f.runtime.prepare.mockRejectedValue(new OmpRuntimeError(diagnostic));
    const result = await f.supervisor.start(f.selection);
    expect(result).toEqual({ ok: false, runId: expect.any(String), diagnostic });
    expect(await f.runs.get(result.ok ? "" : result.runId)).toMatchObject({ state: "FAILED", diagnostic });
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("rejects structurally invalid selections before creating a run", async () => {
    const f = await fixture("rpc");
    await expect(f.supervisor.start({
      ...f.selection, route: { ...f.selection.route, models: [] },
    })).rejects.toBeInstanceOf(OmpProcessSupervisorError);
    expect(await f.runs.list()).toEqual([]);
  });

  it("records spawn failure without exposing the raw error", async () => {
    // A genuine ENOENT spawn failure leaves child.pid undefined; that pid-less
    // 'error' is the only one that settles the run terminally (FAILED), never a
    // lingering CANCELLING.
    const f = await fixture("rpc", spawnFailedChild());
    const result = await f.supervisor.start(f.selection);
    setImmediate(() => f.child.fail(new Error(`spawn ENOENT ${secretValue}`)));
    const record = await waitForState(f.runs, result.ok ? result.runId : "", "FAILED");
    expect(record.diagnostic).toMatchObject({ code: "OMP_SPAWN_FAILED", stage: "process-spawn" });
    expect(JSON.stringify(record)).not.toContain(secretValue);
    expect(f.child.killCalls).toEqual([]);
  });

  it("records early exit before readiness as an initialization failure", async () => {
    const f = await fixture("rpc");
    const result = await f.supervisor.start(f.selection);
    setImmediate(() => f.child.close(1, null));
    const record = await waitForState(f.runs, result.ok ? result.runId : "", "FAILED");
    expect(record.diagnostic).toMatchObject({
      code: "PROCESS_EXIT_NONZERO", stage: "agent-init", exitCode: 1,
    });
    expect(record.transitions.map((step) => step.state)).not.toContain("READY");
  });

  it("does not treat an RPC exit code 0 before readiness as SUCCEEDED", async () => {
    const f = await fixture("rpc");
    const result = await f.supervisor.start(f.selection);
    // A zero exit code from a coding agent that never announced `ready` is not
    // evidence of a completed task; it must fail closed, never SUCCEEDED.
    setImmediate(() => f.child.close(0, null));
    const record = await waitForTerminal(f.runs, result.ok ? result.runId : "");
    expect(record.state).toBe("FAILED");
    const states = record.transitions.map((step) => step.state);
    expect(states).not.toContain("READY");
    expect(states).not.toContain("SUCCEEDED");
    expect(record.diagnostic).toMatchObject({
      code: "PROCESS_EXIT_UNKNOWN", stage: "agent-init", exitCode: 0,
    });
  });

  it("does not treat an RPC exit code 0 after readiness but before a running state as SUCCEEDED", async () => {
    const f = await fixture("rpc");
    const result = await f.supervisor.start(f.selection);
    const runId = result.ok ? result.runId : "";
    setImmediate(() => f.child.frame({ type: "ready", protocolVersion: 1 }));
    await vi.waitFor(
      () => expect(f.commands.some((command) => command.type === "get_state")).toBe(true),
      waitForIo,
    );
    await waitForState(f.runs, runId, "READY");
    // Readiness plus a clean exit is still not a confirmed running lifecycle: the
    // child never answered get_state, so the run outcome stays unverified.
    f.child.close(0, null);
    const record = await waitForTerminal(f.runs, runId);
    expect(record.state).toBe("FAILED");
    const states = record.transitions.map((step) => step.state);
    expect(states).toContain("READY");
    expect(states).not.toContain("RUNNING");
    expect(states).not.toContain("SUCCEEDED");
    expect(record.diagnostic).toMatchObject({
      code: "PROCESS_EXIT_UNKNOWN", stage: "agent-init", exitCode: 0,
    });
  });

  it("treats an RPC exit code 0 after a confirmed running state as SUCCEEDED", async () => {
    const f = await fixture("rpc");
    const running = await startAndWaitForRunning(f);
    f.child.close(0, null);
    const record = await waitForState(f.runs, running.runId, "SUCCEEDED");
    expect(record.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "READY", "RUNNING", "SUCCEEDED",
    ]);
  });


  it("fails closed and stops the child when RPC initialization times out", async () => {
    const f = await fixture("rpc");
    const result = await f.supervisor.start(f.selection);
    const record = await waitForState(f.runs, result.ok ? result.runId : "", "FAILED");
    expect(record.diagnostic).toMatchObject({ code: "OMP_INITIALIZATION_TIMEOUT", stage: "agent-init" });
    await vi.waitFor(
      () => expect(f.child.killCalls.length).toBeGreaterThan(0),
      waitForIo,
    );
    expect(record.transitions.map((step) => step.state)).not.toContain("READY");
  });

  it("reaches READY only from RPC evidence, then RUNNING with the projected session", async () => {
    const f = await fixture("rpc");
    const record = await startAndWaitForRunning(f);
    expect(record).toMatchObject({
      state: "RUNNING", pid: 4242, sessionId,
      providerId: "fixture", accountId: "chosen-account", modelId: "model-one", mode: "rpc",
    });
    expect(record.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "READY", "RUNNING",
    ]);
    expect(f.spawn).toHaveBeenCalledWith(f.runtime.prepared.executable, f.runtime.prepared.args, {
      cwd: f.selection.projectDirectory,
      env: { PROVIDERDOCK_OMP_FIXTURE_SECRET: secretValue },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    expect(JSON.stringify(record)).not.toContain(secretValue);
  });

  it("keeps TUI on the real terminal and never claims RPC readiness", async () => {
    const f = await fixture("tui");
    const result = await f.supervisor.start(f.selection);
    expect(result).toEqual({ ok: true, runId: expect.any(String) });
    const record = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    expect(record).toMatchObject({ state: "TERMINAL_OPEN", pid: 4242 });
    expect(f.spawn.mock.calls[0]![2]).toMatchObject({ stdio: "inherit" });
    expect(f.spawn.mock.calls[0]![2].windowsHide).toBeFalsy();
    f.child.close(0, null);
    await waitForState(f.runs, record.runId, "SUCCEEDED");
    expect((await f.runs.get(record.runId))!.transitions.map((step) => step.state))
      .toEqual(["VALIDATING", "STARTING", "TERMINAL_OPEN", "SUCCEEDED"]);
  });

  it("records late failure after a successful initialization", async () => {
    const f = await fixture("rpc");
    const running = await startAndWaitForRunning(f);
    f.child.close(1, null);
    const record = await waitForState(f.runs, running.runId, "FAILED");
    expect(record.diagnostic).toMatchObject({
      code: "PROCESS_EXIT_NONZERO", stage: "shutdown", exitCode: 1,
    });
    expect(record.sessionId).toBe(sessionId);
  });

  it("cancels an RPC run through the private abort command and records CANCELLED", async () => {
    const f = await fixture("rpc");
    const running = await startAndWaitForRunning(f);
    const child = f.child;
    child.stdin.on("data", (chunk: string) => {
      if (chunk.includes(`"type":"abort"`)) setImmediate(() => child.close(0, null));
    });
    const record = await f.supervisor.cancel(running.runId);
    expect(record).toMatchObject({ state: "CANCELLED" });
    expect(record?.diagnostic).toMatchObject({ code: "OPERATION_CANCELLED", stage: "shutdown" });
    expect(f.commands.some((command) => command.type === "abort")).toBe(true);
    expect(child.killCalls).toEqual([]);
  });

  it("cancels a TUI run by stopping only its own child process", async () => {
    const f = await fixture("tui");
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    const record = await f.supervisor.cancel(open.runId);
    expect(record).toMatchObject({ state: "CANCELLED" });
    expect(f.child.killCalls.length).toBeGreaterThan(0);
  });

  it("cancels a run requested before the child is spawned", async () => {
    const f = await fixture("rpc");
    let releasePrepare!: () => void;
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    f.runtime.prepare.mockImplementationOnce(async () => { await gate; return f.runtime.prepared; });
    const startPromise = f.supervisor.start(f.selection);
    const runId = await vi.waitFor(async () => {
      const [record] = await f.runs.list();
      expect(record?.state).toBe("STARTING");
      return record!.runId;
    }, waitForIo);
    // Cancel arrives while start() is still awaiting prepare: no child exists yet.
    const cancelPromise = f.supervisor.cancel(runId);
    releasePrepare();
    const [cancelled] = await Promise.all([cancelPromise, startPromise]);
    expect(cancelled?.state).toBe("CANCELLED");
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("holds a cancel as non-terminal CANCELLING while preflight outlives the grace, then settles CANCELLED on release", async () => {
    const f = await fixture("rpc", new FakeChildProcess(), { cancelGraceMs: 40 });
    let releasePreflight!: () => void;
    const gate = new Promise<void>((resolve) => { releasePreflight = resolve; });
    let signalPreflightEntered!: () => void;
    const preflightEntered = new Promise<void>((resolve) => { signalPreflightEntered = resolve; });
    f.runtime.preflight.mockImplementationOnce(async () => {
      // Firing from INSIDE preflight is a deterministic barrier: start() has already
      // returned from create() and cleared its pre-spawn ownership check, so the run
      // is published, tracked and now genuinely blocked here. Waiting on list()==
      // VALIDATING instead raced the publish->register window and flaked the gate.
      signalPreflightEntered();
      await gate;
      return {
        ok: true, providerId: "fixture", accountId: "chosen-account",
        modelId: "model-one", api: "openai-completions" as const,
      };
    });
    const startPromise = f.supervisor.start(f.selection);
    await preflightEntered;
    const [record] = await f.runs.list();
    const runId = record!.runId;
    // Cancel arrives while preflight is still running: no child exists and the grace
    // elapses before preflight returns. HTTP/UI must see an unconfirmed request, not
    // a confirmed CANCELLED that the operator cannot trust.
    const requested = await f.supervisor.cancel(runId);
    expect(requested?.state).toBe("CANCELLING");
    expect(requested?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    // Releasing preflight lets start() observe the cancel at its pre-spawn ownership
    // point and settle the run without ever preparing or spawning a process.
    releasePreflight();
    const result = await startPromise;
    expect(result.ok).toBe(false);
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "CANCELLING", "CANCELLED",
    ]);
    expect(f.runtime.prepare).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("does not lose a cancel of its own run published before ownership is registered", async () => {
    // The publish->register window: create() writes the record file (visible via
    // list()) before its promise resolves, and the supervisor must register
    // ownership before that record is visible. This barrier holds create()'s RETURN
    // open AFTER the write, then issues a cancel of the now-visible run. The cancel
    // must be honoured: the run must never spawn and must settle CANCELLED.
    let releaseCreate!: () => void;
    const createReturn = new Promise<void>((resolve) => { releaseCreate = resolve; });
    let signalPublished!: () => void;
    const published = new Promise<void>((resolve) => { signalPublished = resolve; });
    const wrapRuns = (inner: OmpRunRepository): OmpRunRepository => ({
      async create(input) {
        const created = await inner.create(input); // real write: record now visible
        signalPublished();
        await createReturn;                         // hold the RETURN, not the write
        return created;
      },
      get: (id) => inner.get(id),
      list: () => inner.list(),
      transition: (id, state, details) => inner.transition(id, state, details),
    });
    const f = await fixture("rpc", new FakeChildProcess(), { wrapRuns });
    const startPromise = f.supervisor.start(f.selection);
    await published;
    const [visible] = await f.runs.list();
    expect(visible?.state).toBe("VALIDATING"); // own pending run is publicly visible
    const runId = visible!.runId;
    // Order events without deadlocking: issue the cancel (its intent is recorded
    // synchronously on the tracked entry), THEN release create()'s return so start()
    // observes the intent. We never wait for the cancel to finish before releasing.
    const cancelPromise = f.supervisor.cancel(runId);
    releaseCreate();
    const [cancelled, result] = await Promise.all([cancelPromise, startPromise]);
    expect(result.ok).toBe(false);
    expect(cancelled?.state).toBe("CANCELLED");
    expect(f.runtime.prepare).not.toHaveBeenCalled();
    expect(f.spawn).not.toHaveBeenCalled();
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual(["VALIDATING", "CANCELLED"]);
    // Idempotent: a repeat cancel of the settled run stays CANCELLED and spawns nothing.
    const again = await f.supervisor.cancel(runId);
    expect(again?.state).toBe("CANCELLED");
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("holds a cancel as non-terminal CANCELLING while prepare outlives the grace, then settles CANCELLED on release", async () => {
    const f = await fixture("rpc", new FakeChildProcess(), { cancelGraceMs: 40 });
    let releasePrepare!: () => void;
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    f.runtime.prepare.mockImplementationOnce(async () => { await gate; return f.runtime.prepared; });
    const startPromise = f.supervisor.start(f.selection);
    const runId = await vi.waitFor(async () => {
      const [record] = await f.runs.list();
      expect(record?.state).toBe("STARTING");
      return record!.runId;
    }, waitForIo);
    // Cancel arrives while start() is still awaiting prepare, past the grace window.
    const requested = await f.supervisor.cancel(runId);
    expect(requested?.state).toBe("CANCELLING");
    expect(requested?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    releasePrepare();
    const result = await startPromise;
    expect(result.ok).toBe(false);
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "CANCELLED",
    ]);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("keeps repeated cancels during a pre-spawn hang non-terminal and settles CANCELLED exactly once", async () => {
    const f = await fixture("rpc", new FakeChildProcess(), { cancelGraceMs: 40 });
    let releasePrepare!: () => void;
    const gate = new Promise<void>((resolve) => { releasePrepare = resolve; });
    f.runtime.prepare.mockImplementationOnce(async () => { await gate; return f.runtime.prepared; });
    const startPromise = f.supervisor.start(f.selection);
    const runId = await vi.waitFor(async () => {
      const [record] = await f.runs.list();
      expect(record?.state).toBe("STARTING");
      return record!.runId;
    }, waitForIo);
    const first = await f.supervisor.cancel(runId);
    expect(first?.state).toBe("CANCELLING");
    // A second cancel while still unconfirmed neither claims CANCELLED nor emits a
    // duplicate CANCELLING transition (the state machine would reject that anyway).
    const second = await f.supervisor.cancel(runId);
    expect(second?.state).toBe("CANCELLING");
    releasePrepare();
    await startPromise;
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.filter((step) => step.state === "CANCELLING")).toHaveLength(1);
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "CANCELLED",
    ]);
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it("reports a non-terminal unconfirmed stop, keeps observing, and settles CANCELLED on the child's own close", async () => {
    const stubborn = new FakeChildProcess(4444);
    stubborn.kill = ((signal?: NodeJS.Signals): boolean => {
      stubborn.killCalls.push(signal);
      return false; // The OS refused (or could not confirm) the kill; no close follows.
    }) as typeof stubborn.kill;
    const f = await fixture("rpc", stubborn, { cancelGraceMs: 40 });
    const running = await startAndWaitForRunning(f);
    const record = await f.supervisor.cancel(running.runId);
    // The grace elapsed with the child still alive: this MUST NOT be reported as a
    // confirmed stop. A terminal FAILED here would hide a process that may still be
    // running inference or a tool side-effect, and CANCELLED would be an outright lie.
    expect(record?.state).not.toBe("CANCELLED");
    expect(record?.state).not.toBe("FAILED");
    expect(record?.state).toBe("CANCELLING");
    expect(record?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    // Deterministic proof the process is still alive at the moment we report it, and
    // that we signalled only our own tracked child (never a persisted/foreign PID).
    expect(stubborn.closed).toBe(false);
    expect(stubborn.killCalls.length).toBeGreaterThan(0);
    expect(f.commands.some((command) => command.type === "abort")).toBe(true);
    // The run stays non-terminal and visible so an operator can retry the stop.
    const listed = (await f.supervisor.listRuns()).find((run) => run.runId === running.runId);
    expect(listed?.state).toBe("CANCELLING");
    // Continued observation: because CANCELLING never queued a terminal transition,
    // the child's own eventual close still settles the authoritative CANCELLED.
    stubborn.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, running.runId, "CANCELLED");
    expect(settled.diagnostic).toMatchObject({ code: "OPERATION_CANCELLED", stage: "shutdown" });
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "READY", "RUNNING", "CANCELLING", "CANCELLED",
    ]);
  });

  it("keeps an undeliverable kill on a live TUI child non-terminal, then settles CANCELLED on its own close", async () => {
    // A TUI run at TERMINAL_OPEN is a real OS process. If kill() cannot be
    // delivered Node emits 'error' with no 'close' and the process is still
    // alive; declaring the run terminally FAILED here (the M3-R2 defect) would
    // hide that live child and drop it from the cancellable set.
    const live = killEmitsUndeliverableError(new FakeChildProcess(5252));
    const f = await fixture("tui", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    const record = await f.supervisor.cancel(open.runId);
    // A positive pid and prior readiness are NOT proof of death: stay non-terminal.
    expect(record?.state).not.toBe("FAILED");
    expect(record?.state).toBe("CANCELLING");
    expect(record?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    expect(live.closed).toBe(false);
    expect(live.killCalls.length).toBeGreaterThan(0);
    // Still owned and visible so an operator can retry the stop on this same child.
    const listed = (await f.supervisor.listRuns()).find((run) => run.runId === open.runId);
    expect(listed?.state).toBe("CANCELLING");
    const killsAfterFirst = live.killCalls.length;
    const again = await f.supervisor.cancel(open.runId);
    expect(again?.state).toBe("CANCELLING");
    expect(live.killCalls.length).toBeGreaterThan(killsAfterFirst); // re-signals only this child
    // Its own eventual close settles exactly one terminal CANCELLED.
    live.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, open.runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "TERMINAL_OPEN", "CANCELLING", "CANCELLED",
    ]);
  });

  it("keeps an undeliverable kill non-terminal when cancelling an RPC child before readiness", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5254));
    const f = await fixture("rpc", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const runId = result.ok ? result.runId : "";
    // Spawned (positive pid) but the agent never announced readiness.
    expect((await f.runs.get(runId))?.state).toBe("STARTING");
    const record = await f.supervisor.cancel(runId);
    expect(record?.state).not.toBe("FAILED");
    expect(record?.state).toBe("CANCELLING");
    expect(record?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    expect(live.closed).toBe(false);
    expect(live.killCalls.length).toBeGreaterThan(0);
    live.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "CANCELLED",
    ]);
  });

  it("keeps an undeliverable kill on a running RPC child non-terminal, then settles CANCELLED on its close", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5253));
    const f = await fixture("rpc", live, { cancelGraceMs: 40 });
    const running = await startAndWaitForRunning(f);
    const record = await f.supervisor.cancel(running.runId);
    expect(record?.state).not.toBe("FAILED");
    expect(record?.state).toBe("CANCELLING");
    expect(record?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    expect(live.closed).toBe(false);
    // We attempted the private abort on our own child and signalled only it.
    expect(f.commands.some((command) => command.type === "abort")).toBe(true);
    expect(live.killCalls.length).toBeGreaterThan(0);
    const listed = (await f.supervisor.listRuns()).find((run) => run.runId === running.runId);
    expect(listed?.state).toBe("CANCELLING");
    live.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, running.runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "READY", "RUNNING", "CANCELLING", "CANCELLED",
    ]);
  });

  it("keeps an initialization-timeout child stoppable until close", async () => {
    // The headline M3-FINAL defect: an init timeout used to write terminal FAILED
    // and only THEN kill. When the kill cannot be delivered (EPERM, no 'close')
    // that stranded a still-live child behind a terminal record the dashboard
    // hides and drops from the cancellable set. The run must instead stay
    // non-terminal with the ORIGINAL cause, keep the SAME child re-signalable,
    // and settle FAILED only on the child's own close — even on a clean exit 0.
    const live = killEmitsUndeliverableError(new FakeChildProcess(5258));
    const f = await fixture("rpc", live, { cancelGraceMs: 40, initializationTimeoutMs: 60 });
    const result = await f.supervisor.start(f.selection);
    const runId = result.ok ? result.runId : "";
    // After the timeout the persisted record is NON-terminal and still carries
    // the original cause. Asserting the old terminal FAILED here is the RED.
    const cancelling = await waitForState(f.runs, runId, "CANCELLING");
    expect(cancelling.state).not.toBe("FAILED");
    expect(cancelling.diagnostic).toMatchObject({
      code: "OMP_INITIALIZATION_TIMEOUT", stage: "agent-init",
    });
    expect(live.closed).toBe(false);
    const killsAfterTimeout = live.killCalls.length;
    expect(killsAfterTimeout).toBeGreaterThan(0);
    // A retry-cancel re-signals ONLY this same child and keeps the fault cause;
    // it must not overwrite the recorded init-timeout with a plain cancel code.
    const again = await f.supervisor.cancel(runId);
    expect(again?.state).toBe("CANCELLING");
    expect(again?.diagnostic).toMatchObject({
      code: "OMP_INITIALIZATION_TIMEOUT", stage: "agent-init",
    });
    expect(live.killCalls.length).toBeGreaterThan(killsAfterTimeout);
    // The child's own close settles exactly one terminal FAILED with the
    // original cause even on exit 0 — never CANCELLED despite the retry-cancel.
    live.close(0, "SIGTERM");
    const failed = await waitForState(f.runs, runId, "FAILED");
    expect(failed.diagnostic).toMatchObject({
      code: "OMP_INITIALIZATION_TIMEOUT", stage: "agent-init",
    });
    expect(failed.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "FAILED",
    ]);
    // A late frame and a late error after the terminal settle are ignored: no
    // second transition and no unhandled rejection.
    live.frame({ type: "ready", protocolVersion: 1 });
    live.emit("error", Object.assign(new Error("late EPERM"), { code: "EPERM" }));
    await new Promise((resolve) => setImmediate(resolve));
    const final = await f.runs.get(runId);
    expect(final?.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "FAILED",
    ]);
  });

  // Table across the remaining RPC-failure inputs (init timeout has its own
  // dedicated test above), each on a live child whose kill is undeliverable.
  faultInputs.forEach((input, index) => {
    it(`defers the terminal until close when a live RPC child faults on ${input.name}`, async () => {
      const live = input.makeChild(5270 + index);
      const f = await fixture("rpc", live, input.overrides);
      const result = await f.supervisor.start(f.selection);
      const runId = result.ok ? result.runId : "";
      input.trigger(live);
      await expectFaultDefersTerminalUntilClose(f, live, runId, input.code);
    });
  });

  // Table across the kill variants (undeliverable-error is covered by the
  // dedicated test and the input table), driven by an init timeout each time.
  (["returns-false", "throws"] as const).forEach((variant) => {
    it(`keeps an init-timeout child non-terminal when kill ${variant}, settling on its close`, async () => {
      const live = applyKillVariant(new FakeChildProcess(5290), variant);
      const f = await fixture("rpc", live, { cancelGraceMs: 40, initializationTimeoutMs: 60 });
      const result = await f.supervisor.start(f.selection);
      const runId = result.ok ? result.runId : "";
      await expectFaultDefersTerminalUntilClose(f, live, runId, "OMP_INITIALIZATION_TIMEOUT");
    });
  });

  it("keeps a cancel authoritative when late fault frames arrive after the cancel (RPC)", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5261));
    const f = await fixture("rpc", live, { cancelGraceMs: 40 });
    const running = await startAndWaitForRunning(f);
    // The user cancel is accepted first: a non-terminal unconfirmed cancel.
    const cancelling = await f.supervisor.cancel(running.runId);
    expect(cancelling?.state).toBe("CANCELLING");
    expect(cancelling?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    // Frames that would otherwise fault now arrive on the same child. Because a
    // stop already began they are dropped, never overwriting the cancel cause.
    live.frame({ type: "ready", protocolVersion: 999 });
    live.stdout.write("this-is-not-json\n");
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.runs.get(running.runId))?.state).toBe("CANCELLING");
    // The child's own close settles CANCELLED — the cancel stays authoritative.
    live.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, running.runId, "CANCELLED");
    expect(settled.diagnostic).toMatchObject({ code: "OPERATION_CANCELLED", stage: "shutdown" });
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "READY", "RUNNING", "CANCELLING", "CANCELLED",
    ]);
  });

  it("blocks a late READY/state frame from reviving a cancelling RPC run", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5262));
    const f = await fixture("rpc", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const runId = result.ok ? result.runId : "";
    await waitForState(f.runs, runId, "STARTING"); // spawned, not yet ready
    const cancelling = await f.supervisor.cancel(runId);
    expect(cancelling?.state).toBe("CANCELLING");
    const commandsAfterCancel = f.commands.length;
    // A late READY and its state frame arrive after the cancel; neither may move
    // the run to READY/RUNNING nor issue a new get_state control command.
    live.frame({ type: "ready", protocolVersion: 1 });
    live.frame({
      type: "response", id: "late", command: "get_state", success: true,
      data: { model: { id: "model-one", provider: "dock-fixture-fingerprint" }, sessionId, isStreaming: false },
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(f.commands.length).toBe(commandsAfterCancel);
    const during = await f.runs.get(runId);
    expect(during?.state).toBe("CANCELLING");
    expect(during?.transitions.map((step) => step.state)).not.toContain("READY");
    expect(during?.transitions.map((step) => step.state)).not.toContain("RUNNING");
    live.close(0, "SIGTERM");
    const settled = await waitForState(f.runs, runId, "CANCELLED");
    expect(settled.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "CANCELLING", "CANCELLED",
    ]);
  });

  it("reconciles a fault-triggered unconfirmed stop to INTERRUPTED after restart without signalling its pid", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5263));
    const f = await fixture("rpc", live, { cancelGraceMs: 40, initializationTimeoutMs: 60 });
    const result = await f.supervisor.start(f.selection);
    const runId = result.ok ? result.runId : "";
    // An init timeout with an undeliverable kill leaves a non-terminal fault-stop.
    const cancelling = await waitForState(f.runs, runId, "CANCELLING");
    expect(cancelling.diagnostic).toMatchObject({
      code: "OMP_INITIALIZATION_TIMEOUT", stage: "agent-init",
    });
    const killsBeforeRestart = live.killCalls.length;
    // A fresh supervisor over the same store owns none of these pids. It must
    // reconcile the non-terminal fault-stop to INTERRUPTED and NEVER signal 5263.
    const restart = new OmpProcessSupervisor({
      runtime: f.runtime as OmpSupervisorRuntime, runs: f.runs,
      initializationTimeoutMs: 500, cancelGraceMs: 1_000,
    });
    const interrupted = await restart.reconcileAfterRestart();
    expect(interrupted.map((record) => record.runId)).toEqual([runId]);
    expect(interrupted[0]).toMatchObject({
      state: "INTERRUPTED",
      diagnostic: { code: "OMP_SUPERVISOR_OWNERSHIP_LOST", stage: "shutdown" },
    });
    expect(live.killCalls.length).toBe(killsBeforeRestart);
  });

  it("treats errors on a live child as non-fatal and a post-close error as a no-op (one terminal only)", async () => {
    const live = new FakeChildProcess(5256);
    const f = await fixture("tui", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    // Two 'error' events arrive on the live child (no cancel in flight). Neither
    // proves exit, so the run stays TERMINAL_OPEN and tracked — never a premature
    // FAILED, and the second error never adds a duplicate terminal transition.
    live.emit("error", Object.assign(new Error("first EPERM"), { code: "EPERM" }));
    live.emit("error", Object.assign(new Error("second EPERM"), { code: "EPERM" }));
    await new Promise((resolve) => setImmediate(resolve));
    expect((await f.runs.get(open.runId))?.state).toBe("TERMINAL_OPEN");
    expect((await f.supervisor.listRuns()).some((run) => run.runId === open.runId)).toBe(true);
    // The real close is authoritative: exactly one terminal settle (SUCCEEDED).
    live.close(0, "SIGTERM");
    await waitForState(f.runs, open.runId, "SUCCEEDED");
    // An 'error' arriving AFTER close is ignored, never a second terminal write.
    live.emit("error", Object.assign(new Error("late EPERM"), { code: "EPERM" }));
    await new Promise((resolve) => setImmediate(resolve));
    const final = await f.runs.get(open.runId);
    expect(final?.state).toBe("SUCCEEDED");
    expect(final?.transitions.map((step) => step.state)).toEqual([
      "VALIDATING", "STARTING", "TERMINAL_OPEN", "SUCCEEDED",
    ]);
  });

  it("keeps a run tracked and non-terminal when kill() throws synchronously", async () => {
    const live = new FakeChildProcess(5255);
    live.kill = ((signal?: NodeJS.Signals): boolean => {
      live.killCalls.push(signal);
      // Some runtimes throw synchronously when a signal cannot be delivered.
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    }) as typeof live.kill;
    const f = await fixture("tui", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    // A synchronous throw from kill must not escape cancel() or orphan the child.
    const record = await f.supervisor.cancel(open.runId);
    expect(record?.state).toBe("CANCELLING");
    expect(record?.diagnostic).toMatchObject({ code: "OMP_CANCEL_UNCONFIRMED", stage: "shutdown" });
    expect(live.closed).toBe(false);
    expect(live.killCalls.length).toBeGreaterThan(0);
    const listed = (await f.supervisor.listRuns()).find((run) => run.runId === open.runId);
    expect(listed?.state).toBe("CANCELLING");
    live.close(0, "SIGTERM");
    await waitForState(f.runs, open.runId, "CANCELLED");
  });

  it("reconciles an unconfirmed CANCELLING run to INTERRUPTED after restart without signalling its pid", async () => {
    const live = killEmitsUndeliverableError(new FakeChildProcess(5257));
    const f = await fixture("tui", live, { cancelGraceMs: 40 });
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    const cancelling = await f.supervisor.cancel(open.runId);
    expect(cancelling?.state).toBe("CANCELLING");
    const killsBeforeRestart = live.killCalls.length;
    // A dashboard restart loses ownership of a still-live child. The non-terminal
    // CANCELLING run reconciles to INTERRUPTED, and the restarted supervisor must
    // NEVER signal the persisted pid of a process it does not own.
    const restart = new OmpProcessSupervisor({
      runtime: f.runtime as OmpSupervisorRuntime, runs: f.runs,
      initializationTimeoutMs: 500, cancelGraceMs: 1_000,
    });
    const interrupted = await restart.reconcileAfterRestart();
    expect(interrupted.map((record) => record.runId)).toEqual([open.runId]);
    expect(interrupted[0]).toMatchObject({
      state: "INTERRUPTED",
      diagnostic: { code: "OMP_SUPERVISOR_OWNERSHIP_LOST", stage: "shutdown" },
    });
    expect(live.killCalls.length).toBe(killsBeforeRestart); // restart signalled nothing
  });

  it("keeps failure evidence across a dashboard restart and never resurrects terminal runs", async () => {
    const f = await fixture("rpc");
    const running = await startAndWaitForRunning(f);
    const restart = new OmpProcessSupervisor({
      runtime: f.runtime as OmpSupervisorRuntime,
      runs: f.runs,
      initializationTimeoutMs: 500,
      cancelGraceMs: 1_000,
    });
    const interrupted = await restart.reconcileAfterRestart();
    expect(interrupted.map((record) => record.runId)).toEqual([running.runId]);
    expect(interrupted[0]).toMatchObject({
      state: "INTERRUPTED",
      diagnostic: { code: "OMP_SUPERVISOR_OWNERSHIP_LOST", stage: "shutdown" },
    });
    f.child.close(0, null);
    await vi.waitFor(async () => {
      expect(((await f.runs.get(running.runId))!).transitions.map((step) => step.state))
        .toEqual(["VALIDATING", "STARTING", "READY", "RUNNING", "INTERRUPTED"]);
    }, waitForIo);
    const failed = await f.runs.get(running.runId);
    expect(failed?.state).toBe("INTERRUPTED");
    expect(failed?.diagnostic?.code).toBe("OMP_SUPERVISOR_OWNERSHIP_LOST");
    expect(await restart.reconcileAfterRestart()).toEqual([]);
  });

  it("returns the terminal record for a repeated cancel without re-signalling", async () => {
    const f = await fixture("tui");
    const result = await f.supervisor.start(f.selection);
    const open = await waitForState(f.runs, result.ok ? result.runId : "", "TERMINAL_OPEN");
    const first = await f.supervisor.cancel(open.runId);
    expect(first?.state).toBe("CANCELLED");
    const killsAfterFirst = f.child.killCalls.length;
    const second = await f.supervisor.cancel(open.runId);
    expect(second?.state).toBe("CANCELLED");
    // A post-terminal cancel reads the persisted record; it never signals again.
    expect(f.child.killCalls.length).toBe(killsAfterFirst);
  });

  it("cancels one live run without disturbing another concurrent run", async () => {
    const f = await fixture("tui");
    const childB = new FakeChildProcess(4343);
    f.children.push(f.child, childB); // run A -> f.child, run B -> childB
    // Drive each run fully to TERMINAL_OPEN before launching the next. The run
    // store's writer lock is fail-fast by design; the supervisor serializes its
    // own runs' writes, so a second start() waits its turn rather than racing.
    const a = await f.supervisor.start(f.selection);
    const openA = await waitForState(f.runs, a.ok ? a.runId : "", "TERMINAL_OPEN");
    const b = await f.supervisor.start(f.selection);
    expect(b.ok).toBe(true);
    const openB = await waitForState(f.runs, b.ok ? b.runId : "", "TERMINAL_OPEN");
    expect(openA.runId).not.toBe(openB.runId);
    // Both runs are now simultaneously live and tracked; cancel exactly one.
    const cancelledA = await f.supervisor.cancel(openA.runId);
    expect(cancelledA?.state).toBe("CANCELLED");
    expect(f.child.killCalls.length).toBeGreaterThan(0);
    // The second run's child is never signalled and the run stays live.
    expect(childB.killCalls).toEqual([]);
    expect((await f.runs.get(openB.runId))?.state).toBe("TERMINAL_OPEN");
  });

  it("serializes sibling run-store writes so a fail-fast lock never drops a cancel", async () => {
    // Two runs share one supervisor and one fail-fast writer lock. If the
    // supervisor lets two of its runs write at the same instant, the loser's
    // transition throws OMP_RUN_LOCKED; handleChildClose swallows that throw, so
    // a cancel's CANCELLED write can vanish and cancel() returns a stale
    // non-terminal record as if the stop never happened. Cancelling both runs at
    // once forces the contention; neither cancel may be silently dropped.
    const f = await fixture("tui");
    const childB = new FakeChildProcess(4343);
    f.children.push(f.child, childB);
    const supervisor = new OmpProcessSupervisor({
      runtime: f.runtime as OmpSupervisorRuntime,
      runs: withFailFastWriterLock(f.runs),
      spawn: f.spawn as unknown as OmpSupervisorSpawn,
      initializationTimeoutMs: 500,
      cancelGraceMs: 1_000,
    });
    const a = await supervisor.start(f.selection);
    const openA = await waitForState(f.runs, a.ok ? a.runId : "", "TERMINAL_OPEN");
    const b = await supervisor.start(f.selection);
    const openB = await waitForState(f.runs, b.ok ? b.runId : "", "TERMINAL_OPEN");
    expect(openA.runId).not.toBe(openB.runId);
    // Both children close in the same turn, so both terminal writes contend the
    // single lock. With per-run-only ordering the loser's CANCELLED is dropped.
    const [resultA, resultB] = await Promise.all([
      supervisor.cancel(openA.runId),
      supervisor.cancel(openB.runId),
    ]);
    expect(resultA?.state).toBe("CANCELLED");
    expect(resultB?.state).toBe("CANCELLED");
    expect((await f.runs.get(openA.runId))?.state).toBe("CANCELLED");
    expect((await f.runs.get(openB.runId))?.state).toBe("CANCELLED");
  });

  it("interrupts every orphaned non-terminal run and preserves terminal runs after restart", async () => {
    const f = await fixture("rpc");
    const dir = f.selection.projectDirectory;
    const make = async (path: OmpRunRecord["state"][]): Promise<string> => {
      const created = await f.runs.create({
        providerId: "fixture", accountId: "chosen-account", modelId: "model-one",
        projectDirectory: dir, mode: "rpc",
      });
      for (const state of path) await f.runs.transition(created.runId, state);
      return created.runId;
    };
    const starting = await make(["STARTING"]);
    const ready = await make(["STARTING", "READY"]);
    const running = await make(["STARTING", "READY", "RUNNING"]);
    const succeeded = await make(["STARTING", "READY", "RUNNING", "SUCCEEDED"]);
    const cancelled = await make(["STARTING", "CANCELLED"]);
    const restart = new OmpProcessSupervisor({
      runtime: f.runtime as OmpSupervisorRuntime, runs: f.runs,
      initializationTimeoutMs: 500, cancelGraceMs: 1_000,
    });
    const interrupted = await restart.reconcileAfterRestart();
    expect([...interrupted.map((record) => record.runId)].sort())
      .toEqual([starting, ready, running].sort());
    for (const id of [starting, ready, running]) {
      expect((await f.runs.get(id))?.state).toBe("INTERRUPTED");
    }
    expect((await f.runs.get(succeeded))?.state).toBe("SUCCEEDED");
    expect((await f.runs.get(cancelled))?.state).toBe("CANCELLED");
  });
});

describe("OMP private RPC -> public lifecycle boundary", () => {
  const expected = { requestId: "ours", providerId: "fixture", modelId: "model" };
  const sessionId = "01994b10-aaaa-7000-8000-aaaaaaaaaaaa";
  it("keeps only verified lifecycle fields, never model headers or arbitrary text", () => {
    const frame = {
      type: "response", command: "get_state", id: "ours", success: true,
      data: {
        model: { id: "model", provider: "fixture", headers: { Authorization: "Bearer fixture-secret" } },
        sessionId, isStreaming: false, systemPrompt: ["fixture-secret"], sessionName: "fixture-secret",
        dumpTools: [{ description: "fixture-secret" }], sessionFile: "private/path", messageCount: 0,
      },
    };
    expect(projectOmpRpcControlFrame(frame, expected)).toEqual({
      type: "state", sessionId, providerId: "fixture", modelId: "model", isStreaming: false,
    });
  });
  it("does not trust unsolicited, wrong-route, or malformed state", () => {
    const frame = {
      type: "response", command: "get_state", id: "ours", success: true,
      data: { model: { id: "model", provider: "fixture" }, sessionId, isStreaming: false },
    };
    expect(projectOmpRpcControlFrame({ ...frame, id: "another-request" }, expected)).toBeUndefined();
    expect(projectOmpRpcControlFrame({ ...frame, data: { ...frame.data, model: { id: "another-model", provider: "fixture" } } }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_MODEL_MISMATCH" });
    expect(projectOmpRpcControlFrame({ ...frame, data: { ...frame.data, sessionId: "not-a-session" } }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_INVALID_FRAME" });
  });
  it("does not expose upstream failure strings and ignores non-control frames", () => {
    expect(projectOmpRpcControlFrame({ type: "response", id: "ours", command: "get_state", success: false, error: "fixture-secret" }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_COMMAND_FAILED" });
    expect(projectOmpRpcControlFrame({ type: "message_update", data: "fixture-secret" }, expected)).toBeUndefined();
    expect(projectOmpRpcControlFrame(null, expected)).toBeUndefined();
  });
  it("projects readiness and idle abort without echoing extra fields", () => {
    expect(projectOmpRpcControlFrame({ type: "ready", protocolVersion: 1, extra: "secret" }, expected))
      .toEqual({ type: "ready", protocolVersion: 1 });
    expect(projectOmpRpcControlFrame({ type: "ready", protocolVersion: 999 }, expected))
      .toEqual({ type: "failure", code: "OMP_RPC_INVALID_FRAME" });
    expect(projectOmpRpcControlFrame({ type: "response", id: "ours", command: "abort", success: true, extra: "secret" }, expected))
      .toEqual({ type: "aborted" });
  });
});
