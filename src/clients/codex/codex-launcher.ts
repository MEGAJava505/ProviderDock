import { spawn } from "node:child_process";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import {
  CodexRuntimeConfigurationError,
  type CodexProviderRoute,
} from "./codex-runtime-config.js";
import {
  type CodexRecoveryOutcome,
  type CodexRuntimeSessionManager,
} from "./codex-runtime-session.js";

export interface CodexProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningCodexProcess {
  readonly pid: number;
  wait(): Promise<CodexProcessExit>;
}

export interface CodexProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface CodexProcessRunner {
  start(request: CodexProcessStartRequest): Promise<RunningCodexProcess>;
}

export class NodeCodexProcessRunner implements CodexProcessRunner {
  async start(request: CodexProcessStartRequest): Promise<RunningCodexProcess> {
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: "inherit",
      });
      const exit = new Promise<CodexProcessExit>((resolveExit) => {
        child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
      });
      child.once("error", reject);
      child.once("spawn", () => {
        const pid = child.pid;
        if (!pid) {
          reject(new CodexRuntimeConfigurationError("Codex process started without a PID."));
          return;
        }
        resolve({
          pid,
          wait: () => exit,
        });
      });
    });
  }
}

export interface LaunchCodexInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly route: CodexProviderRoute;
  readonly executable?: string;
  readonly additionalArgs?: readonly string[];
  readonly parentEnvironment?: NodeJS.ProcessEnv;
}

export class CodexLauncher {
  constructor(
    private readonly sessions: CodexRuntimeSessionManager,
    private readonly processes: CodexProcessRunner = new NodeCodexProcessRunner(),
  ) {}

  async launch(input: LaunchCodexInput): Promise<CodexProcessExit> {
    const recovery = await this.sessions.recoverStaleSessions();
    assertNoRecoveryConflicts(recovery);
    const runtime = await this.sessions.prepare(input);

    try {
      const processHandle = await this.processes.start({
        executable: input.executable ?? "codex",
        args: [
          "--strict-config",
          "--profile",
          runtime.profileName,
          ...(input.additionalArgs ?? []),
        ],
        cwd: runtime.projectDirectory,
        environment: {
          ...(input.parentEnvironment ?? process.env),
          ...runtime.environment,
          CODEX_HOME: this.sessions.codexHome,
        },
      });
      await this.sessions.markActive(runtime, processHandle.pid);
      const exit = await processHandle.wait();
      await this.sessions.cleanup(runtime);
      return exit;
    } catch (error) {
      await this.sessions.cleanup(runtime).catch(() => undefined);
      throw error;
    }
  }

  recover(): Promise<readonly CodexRecoveryOutcome[]> {
    return this.sessions.recoverStaleSessions();
  }
}

function assertNoRecoveryConflicts(outcomes: readonly CodexRecoveryOutcome[]): void {
  const unsafe = outcomes.filter(
    (outcome) => outcome.status === "CONFLICT" || outcome.status === "INVALID",
  );
  if (unsafe.length > 0) {
    throw new CodexRuntimeConfigurationError(
      `Codex runtime recovery requires attention for session(s): ${unsafe
        .map((outcome) => outcome.sessionId)
        .join(", ")}.`,
    );
  }
}
