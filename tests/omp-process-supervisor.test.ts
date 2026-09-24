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
  commands: { id: string; type: string }[];
  respondToControlCommands: () => void;
}

async function fixture(mode: "tui" | "rpc", child = new FakeChildProcess()): Promise<Fixture> {
  const root = await fs.mkdtemp(join(tmpdir(), "omp-supervisor-"));
  roots.push(root);
  const projectDirectory = join(root, "project");
  await fs.mkdir(projectDirectory);
  const runs: OmpRunRepository = new FileOmpRunRepository(join(root, "runs"));
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
  const spawn = vi.fn(
    (_command: string, _args: readonly string[], _options: SpawnOptions) => child,
  );
  const supervisor = new OmpProcessSupervisor({
    runtime: runtime as OmpSupervisorRuntime,
    runs,
    spawn: spawn as unknown as OmpSupervisorSpawn,
    // File-repository transitions can take hundreds of milliseconds while the
    // full Vitest matrix is contending for Windows I/O. Keep the fake lifecycle
    // deadlines short but comfortably above scheduler and disk jitter.
    initializationTimeoutMs: 500,
    cancelGraceMs: 1_000,
  });
  return {
    root, runs, selection, runtime, spawn, supervisor, child, commands,
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
    const f = await fixture("rpc", new FakeChildProcess(undefined));
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
});
