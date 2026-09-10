import { assertModelEnabled } from "../../core/providers/model-access.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { FallbackNotification } from "../../core/fallback/fallback-session-router.js";
import type { ResponsesBridgeFallbackConfiguration } from "../../bridge/responses/responses-bridge-server.js";
import { spawnAgentTerminalProcess } from "../agent-terminal-process.js";
import { codexApprovalArgs, type AgentApprovalLevel } from "../agent-approval.js";
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
    const terminal = spawnAgentTerminalProcess(request);
    const exit = new Promise<CodexProcessExit>((resolveExit) => {
      terminal.child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    const pid = await terminal.ready();
    return { pid, wait: () => exit };
  }
}

export interface LaunchCodexInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly route: CodexLaunchRoute;
  readonly executable?: string;
  readonly additionalArgs?: readonly string[];
  /** Pre-launch action-confirmation level passed to the client CLI. */
  readonly approvalLevel?: AgentApprovalLevel;
  readonly parentEnvironment?: NodeJS.ProcessEnv;
  readonly fallback?: ResponsesBridgeFallbackConfiguration;
  readonly onFallback?: (notification: FallbackNotification) => void;
  readonly onStarted?: (client: "codex") => void;
  readonly sessionInstructions?: string;
  readonly defaultReasoningLevel?: string;
  /** Forces the managed bridge even when the physical provider supports direct Responses. */
  readonly forceManagedBridge?: boolean;
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
    if (!input.fallback) assertModelEnabled(input.profile, input.modelId);
    for (const route of input.fallback?.logicalModel.routes ?? []) {
      const profile = input.fallback?.profiles.find(item => item.id === route.providerId);
      if (route.enabled && profile) assertModelEnabled(profile, route.modelId);
    }
    const disabledFallbackProfile = input.fallback?.profiles.find(
      (profile) => !profile.enabled,
    );
    if (disabledFallbackProfile !== undefined) {
      throw new CodexRuntimeConfigurationError(
        `Fallback provider '${disabledFallbackProfile.id}' is disabled and cannot be launched.`,
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
          ...codexApprovalArgs(input.approvalLevel),
          ...(input.additionalArgs ?? []),
        ],
        cwd: runtime.projectDirectory,
        environment: {
          ...(input.parentEnvironment ?? process.env),
          ...runtime.environment,
          CODEX_HOME: runtime.codexHome,
        },
      });
      await this.sessions.markActive(runtime, processHandle.pid);
      input.onStarted?.("codex");
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
    if (input.fallback !== undefined && input.route.kind !== "auto") {
      throw new CodexRuntimeConfigurationError(
        "Logical-model fallback requires the managed ProviderDock bridge (route kind 'auto').",
      );
    }
    if (input.route.kind === "direct") {
      return { kind: "direct", route: input.route };
    }
    if (input.route.kind === "bridge") {
      return { kind: "external", route: input.route };
    }

    const routingProfiles = input.fallback?.profiles ?? [input.profile];
    const unsupportedProfile = routingProfiles.find(
      (profile) =>
        !["auto", "openai-responses", "openai-chat-completions"].includes(
          profile.apiType,
        ),
    );
    if (unsupportedProfile !== undefined) {
      throw new CodexRuntimeConfigurationError(
        `Automatic Codex routing cannot translate provider API type '${unsupportedProfile.apiType}' yet. ` +
          "Configure a compatible external bridge explicitly.",
      );
    }

    // Automatic launches always receive normalization and persistent replay protection.
    // Explicit direct/external routes were handled above.
    if (this.bridges === undefined) {
      throw new CodexRuntimeConfigurationError(
        `Provider '${input.profile.id}' requires a managed Responses bridge, but no bridge factory is configured.`,
      );
    }

    const bridge = this.bridges.create({
      profile: input.profile,
      modelId: input.modelId,
      sessionId,
      ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
      ...(input.onFallback === undefined ? {} : { onFallback: input.onFallback }),
      ...(input.sessionInstructions === undefined
        ? {}
        : { sessionInstructions: input.sessionInstructions }),
      ...(input.defaultReasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: input.defaultReasoningLevel }),
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
