import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { ClaudeBridgeFactory, ManagedClaudeBridge } from "./claude-bridge-factory.js";

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
    return new Promise((resolve, reject) => {
      const child = spawn(request.executable, [...request.args], {
        cwd: request.cwd,
        env: request.environment,
        shell: false,
        stdio: "inherit",
      });
      const exit = new Promise<ClaudeProcessExit>((resolveExit) => {
        child.once("exit", (exitCode, signal) => resolveExit({ exitCode, signal }));
      });
      child.once("error", reject);
      child.once("spawn", () => {
        const pid = child.pid;
        if (!pid) {
          reject(new ClaudeRuntimeConfigurationError("Claude process started without a PID."));
          return;
        }
        resolve({ pid, wait: () => exit });
      });
    });
  }
}

export interface LaunchClaudeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly executable?: string;
  readonly additionalArgs?: readonly string[];
  readonly parentEnvironment?: NodeJS.ProcessEnv;
  /** Extra Anthropic headers to expose via ANTHROPIC_CUSTOM_HEADERS. */
  readonly customHeaders?: Readonly<Record<string, string>>;
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
 * per-session loopback token.
 */
export class ClaudeLauncher {
  constructor(
    private readonly bridges: ClaudeBridgeFactory,
    private readonly processes: ClaudeProcessRunner = new NodeClaudeProcessRunner(),
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

    let bridge: ManagedClaudeBridge | undefined;
    try {
      const sessionToken = `providerdock-${randomBytes(16).toString("hex")}`;
      bridge = this.bridges.create({
        profile: input.profile,
        modelId: input.modelId,
        clientToken: sessionToken,
      });
      const address = await bridge.start();
      const environment = buildClaudeChildEnvironment({
        parentEnvironment: input.parentEnvironment ?? process.env,
        bridgeBaseUrl: address.url,
        modelId: input.modelId,
        sessionToken,
        ...(input.customHeaders === undefined ? {} : { customHeaders: input.customHeaders }),
      });

      const processHandle = await this.processes.start({
        executable: input.executable ?? "claude",
        args: [...(input.additionalArgs ?? [])],
        cwd: input.projectDirectory,
        environment,
      });
      const exit = await processHandle.wait();
      await bridge.stop();
      bridge = undefined;
      return exit;
    } finally {
      if (bridge !== undefined) {
        await bridge.stop().catch(() => undefined);
      }
    }
  }
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
