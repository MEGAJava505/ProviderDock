import {
  runProviderDockCli,
  type CliIo,
  type FallbackNotification,
  type LogicalModelRoute,
  type ProviderDockApplication,
} from "../../src/index.js";

export interface CliRunResult {
  readonly code: number;
  readonly stdout: string[];
  readonly stderr: string[];
}

/**
 * Drive the ProviderDock CLI against an in-memory application, capturing
 * stdout/stderr as string arrays. Every CLI suite (claude, codex, auto-client,
 * usage, profile-bundle, plugin-sdk, provider-dock) invoked an identical
 * harness; this is the shared definition.
 *
 * `credentialPassphraseReader` is only exercised by credential flows. It is
 * omitted from the CLI options when unset — rather than passed as `undefined` —
 * so the call shape stays byte-for-byte what the argument-free callers relied
 * on under `exactOptionalPropertyTypes`.
 */
export async function runCli(
  application: ProviderDockApplication,
  argv: string[],
  environment: NodeJS.ProcessEnv = {},
  credentialPassphraseReader?: () => Promise<string>,
): Promise<CliRunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const io: CliIo = {
    stdout: (message) => stdout.push(message),
    stderr: (message) => stderr.push(message),
  };
  const code = await runProviderDockCli(argv, {
    application,
    io,
    environment,
    ...(credentialPassphraseReader === undefined ? {} : { credentialPassphraseReader }),
  });
  return { code, stdout, stderr };
}

/**
 * Records the start request and reports a fixed pid with a clean (exitCode 0)
 * wait. The Claude, Codex and auto-client suites each defined a byte-identical
 * copy differing only in the pid, which is now supplied per instance.
 */
export class RecordingProcessRunner<Request> {
  request: Request | undefined;

  constructor(private readonly pid: number) {}

  async start(request: Request) {
    this.request = request;
    return { pid: this.pid, wait: async () => ({ exitCode: 0, signal: null }) };
  }
}

/**
 * The fallback-emitting Claude and Codex bridge factories shared an identical
 * block: given a two-route fallback config, fire `onFallback` with a synthetic
 * NETWORK_ERROR switch from the first route to the second. Only the returned
 * bridge address differed, so each factory still returns its own.
 */
export function emitConfiguredFallback(input: {
  readonly modelId: string;
  readonly fallback?: {
    readonly logicalModel: { readonly id: string; readonly routes: readonly LogicalModelRoute[] };
  };
  readonly onFallback?: (notification: FallbackNotification) => void;
}): void {
  const [from, to] = input.fallback?.logicalModel.routes ?? [];
  if (from !== undefined && to !== undefined) {
    input.onFallback?.({
      kind: "FALLBACK",
      logicalModelId: input.fallback?.logicalModel.id ?? input.modelId,
      from,
      to,
      errorType: "NETWORK_ERROR",
      phase: "connection-failed",
      message: "Primary connection failed.",
    });
  }
}
