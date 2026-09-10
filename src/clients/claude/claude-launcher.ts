import { assertModelEnabled } from "../../core/providers/model-access.js";
import { randomBytes } from "node:crypto";
import type { FallbackNotification } from "../../core/fallback/fallback-session-router.js";
import type { ProviderFallbackConfiguration } from "../../core/fallback/provider-fallback-configuration.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { ClaudeBridgeFactory, ManagedClaudeBridge } from "./claude-bridge-factory.js";
import { spawnAgentTerminalProcess } from "../agent-terminal-process.js";
import { claudeApprovalArgs, type AgentApprovalLevel } from "../agent-approval.js";
import type { AgentSessionHomeManager } from "../agent-session-home.js";

export class ClaudeRuntimeConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeRuntimeConfigurationError";
  }
}

export interface ClaudeProcessExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface RunningClaudeProcess {
  readonly pid: number;
  wait(): Promise<ClaudeProcessExit>;
}

export interface ClaudeProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}

export interface ClaudeProcessRunner {
  start(request: ClaudeProcessStartRequest): Promise<RunningClaudeProcess>;
}

export class NodeClaudeProcessRunner implements ClaudeProcessRunner {
  async start(request: ClaudeProcessStartRequest): Promise<RunningClaudeProcess> {
    const terminal = spawnAgentTerminalProcess(request);
    const exit = new Promise<ClaudeProcessExit>((resolveExit) => {
      terminal.child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
    });
    const pid = await terminal.ready();
    return { pid, wait: () => exit };
  }
}

export interface LaunchClaudeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly executable?: string;
  readonly additionalArgs?: readonly string[];
  /** Pre-launch action-confirmation level passed to the client CLI. */
  readonly approvalLevel?: AgentApprovalLevel;
  readonly parentEnvironment?: NodeJS.ProcessEnv;
  /** Extra Anthropic headers to expose via ANTHROPIC_CUSTOM_HEADERS. */
  readonly customHeaders?: Readonly<Record<string, string>>;
  readonly fallback?: ProviderFallbackConfiguration;
  readonly onFallback?: (notification: FallbackNotification) => void;
  readonly onStarted?: (client: "claude-code") => void;
  readonly sessionInstructions?: string;
}

/**
 * Environment variables that could redirect the Claude Code child away from
 * the managed bridge if inherited from the parent shell. They are always
 * replaced or removed inside the child environment (spec section 27).
 */
const managedAnthropicVariables = [
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "ANTHROPIC_CUSTOM_HEADERS",
] as const;

/**
 * Launches Claude Code against a managed loopback Anthropic bridge.
 *
 * The gateway configuration lives exclusively inside the child process
 * environment: the parent (global) environment is never mutated, and stale
 * Anthropic variables inherited from the shell are stripped so they cannot
 * bypass the bridge. Provider credentials never reach the child; the bridge
 * injects real authentication upstream while the child only holds a random
 * per-session loopback token. Claude Code also receives a provider-scoped
 * `CLAUDE_CONFIG_DIR`, and completed conversation history is retained per
 * provider with oldest sessions pruned first.
 */
export class ClaudeLauncher {
  constructor(
    private readonly bridges: ClaudeBridgeFactory,
    private readonly processes: ClaudeProcessRunner,
    private readonly sessionHomes: AgentSessionHomeManager,
  ) {}

  async launch(input: LaunchClaudeInput): Promise<ClaudeProcessExit> {
    if (!input.profile.enabled) {
      throw new ClaudeRuntimeConfigurationError(
        `Provider '${input.profile.id}' is disabled and cannot be launched.`,
      );
    }
    if (input.modelId.trim().length === 0) {
      throw new ClaudeRuntimeConfigurationError("A model id is required to launch Claude Code.");
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
      throw new ClaudeRuntimeConfigurationError(
        `Fallback provider '${disabledFallbackProfile.id}' is disabled and cannot be launched.`,
      );
    }

    let bridge: ManagedClaudeBridge | undefined;
    let sessionHome: string | undefined;
    try {
      sessionHome = await this.sessionHomes.beginSession(input.profile.id);
      const sessionToken = `providerdock-${randomBytes(16).toString("hex")}`;
      const sessionId = randomBytes(16).toString("hex");
      bridge = this.bridges.create({
        profile: input.profile,
        modelId: input.modelId,
        clientToken: sessionToken,
        sessionId,
        ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
        ...(input.onFallback === undefined ? {} : { onFallback: input.onFallback }),
        ...(input.sessionInstructions === undefined
          ? {}
          : { sessionInstructions: input.sessionInstructions }),
      });
      const address = await bridge.start();
      const environment = buildClaudeChildEnvironment({
        parentEnvironment: input.parentEnvironment ?? process.env,
        bridgeBaseUrl: address.url,
        modelId: input.modelId,
        sessionToken,
        ...(input.customHeaders === undefined ? {} : { customHeaders: input.customHeaders }),
      });
      environment["CLAUDE_CONFIG_DIR"] = sessionHome;

      const processHandle = await this.processes.start({
        executable: input.executable ?? "claude",
        args: [...claudeApprovalArgs(input.approvalLevel), ...(input.additionalArgs ?? [])],
        cwd: input.projectDirectory,
        environment,
      });
      input.onStarted?.("claude-code");
      const exit = await processHandle.wait();
      await disposeClaudeBridge(bridge);
      bridge = undefined;
      return exit;
    } finally {
      if (bridge !== undefined) {
        await disposeClaudeBridge(bridge).catch(() => undefined);
      }
      if (sessionHome !== undefined) {
        // Session retention is housekeeping; it must not turn an already-completed
        // Claude run into a launcher failure if the filesystem rejects deletion.
        await this.sessionHomes.endSession(input.profile.id).catch(() => undefined);
      }
    }
  }
}

async function disposeClaudeBridge(bridge: ManagedClaudeBridge): Promise<void> {
  if (bridge.dispose !== undefined) await bridge.dispose();
  else await bridge.stop();
}

export interface BuildClaudeChildEnvironmentInput {
  readonly parentEnvironment: NodeJS.ProcessEnv;
  readonly bridgeBaseUrl: string;
  readonly modelId: string;
  readonly customHeaders?: Readonly<Record<string, string>>;
  /** Overridable for tests; defaults to a random per-session token. */
  readonly sessionToken?: string;
}

/** Builds the child-only environment described in spec section 27. */
export function buildClaudeChildEnvironment(
  input: BuildClaudeChildEnvironmentInput,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...input.parentEnvironment };
  for (const variable of managedAnthropicVariables) {
    delete environment[variable];
  }
  environment["ANTHROPIC_BASE_URL"] = input.bridgeBaseUrl;
  environment["ANTHROPIC_AUTH_TOKEN"] =
    input.sessionToken ?? `providerdock-${randomBytes(16).toString("hex")}`;
  environment["ANTHROPIC_MODEL"] = input.modelId;

  const headerEntries = Object.entries(input.customHeaders ?? {});
  if (headerEntries.length > 0) {
    environment["ANTHROPIC_CUSTOM_HEADERS"] = headerEntries
      .map(([name, value]) => `${name}: ${value}`)
      .join("\n");
  }

  return environment;
}
