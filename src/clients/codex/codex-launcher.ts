import { spawn } from "node:child_process";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import {
  CodexRuntimeConfigurationError,
  type CodexLaunchRoute,
  type CodexProviderRoute,
} from "./codex-runtime-config.js";
import type {
  CodexBridgeFactory,
  ManagedCodexBridge,
} from "./codex-bridge-factory.js";
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
  readonly route: CodexLaunchRoute;
  readonly executable?: string;
  readonly additionalArgs?: readonly string[];
  readonly parentEnvironment?: NodeJS.ProcessEnv;
}

export class CodexLauncher {
  constructor(
    private readonly sessions: CodexRuntimeSessionManager,
    private readonly processes: CodexProcessRunner = new NodeCodexProcessRunner(),
    private readonly bridges?: CodexBridgeFactory,
  ) {}

  async launch(input: LaunchCodexInput): Promise<CodexProcessExit> {
    const recovery = await this.sessions.recoverStaleSessions();
    assertNoRecoveryConflicts(recovery);
    if (!input.profile.enabled) {
      throw new CodexRuntimeConfigurationError(
        `Provider '${input.profile.id}' is disabled and cannot be launched.`,
      );
    }

    let resolution: ResolvedCodexRoute | undefined;
    let runtime: Awaited<ReturnType<CodexRuntimeSessionManager["prepare"]>> | undefined;

    try {
      const sessionId = this.sessions.createSessionId();
      resolution = await this.resolveRoute(input, sessionId);
      runtime = await this.sessions.prepare({
        sessionId,
        profile: input.profile,
        modelId: input.modelId,
        projectDirectory: input.projectDirectory,
        route: resolution.route,
        ...(resolution.kind === "managed" ? { bridgeOwnership: "managed" as const } : {}),
      });
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
      if (resolution.kind === "managed") {
        await resolution.bridge.stop();
      }
      await this.sessions.cleanup(runtime);
      return exit;
    } catch (error) {
      if (resolution?.kind === "managed") {
        await resolution.bridge.stop().catch(() => undefined);
      }
      if (runtime !== undefined) {
        await this.sessions.cleanup(runtime).catch(() => undefined);
      }
      throw error;
    }
  }

  recover(): Promise<readonly CodexRecoveryOutcome[]> {
    return this.sessions.recoverStaleSessions();
  }

  private async resolveRoute(
    input: LaunchCodexInput,
    sessionId: string,
  ): Promise<ResolvedCodexRoute> {
    if (input.route.kind === "direct") {
      return { kind: "direct", route: input.route };
    }
    if (input.route.kind === "bridge") {
      return { kind: "external", route: input.route };
    }

    if (
      !["auto", "openai-responses", "openai-chat-completions"].includes(
        input.profile.apiType,
      )
    ) {
      throw new CodexRuntimeConfigurationError(
        `Automatic Codex routing cannot translate provider API type '${input.profile.apiType}' yet. ` +
          "Configure a compatible external bridge explicitly.",
      );
    }

    const requiresBridge =
      input.profile.apiType === "openai-chat-completions" ||
      input.profile.adapterId === "agentrouter" ||
      input.profile.auth.kind === "query" ||
      Object.keys(input.profile.queryParameters).length > 0;
    if (!requiresBridge) return { kind: "direct", route: { kind: "direct" } };
    if (this.bridges === undefined) {
      throw new CodexRuntimeConfigurationError(
        `Provider '${input.profile.id}' requires a managed Responses bridge, but no bridge factory is configured.`,
      );
    }

    const bridge = this.bridges.create({
      profile: input.profile,
      modelId: input.modelId,
      sessionId,
    });
    try {
      const address = await bridge.start();
      return {
        kind: "managed",
        route: { kind: "bridge", baseUrl: address.baseUrl },
        bridge,
      };
    } catch (error) {
      await bridge.stop().catch(() => undefined);
      throw error;
    }
  }
}

type ResolvedCodexRoute =
  | { readonly kind: "direct"; readonly route: CodexProviderRoute }
  | { readonly kind: "external"; readonly route: CodexProviderRoute }
  | {
      readonly kind: "managed";
      readonly route: CodexProviderRoute;
      readonly bridge: ManagedCodexBridge;
    };

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
