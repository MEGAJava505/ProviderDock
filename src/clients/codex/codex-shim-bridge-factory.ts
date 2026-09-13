import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { FallbackNotification } from "../../core/fallback/fallback-session-router.js";
import type { ProviderRuntimeHealthSignalSink } from "../../core/health/provider-runtime-health.js";
import type { ModelAccessCheck } from "../../core/providers/model-access.js";
import type { ModelProtocolResolver } from "../../core/providers/model-protocol.js";
import type { ProviderAdapterRegistry } from "../../core/providers/provider-adapter-registry.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import {
  ChainedSecretStore,
  MemorySecretStore,
  type SecretStore,
} from "../../core/security/secret-store.js";
import type { UsageEventSink } from "../../core/usage/usage-event.js";
import type {
  ResponsesBridgeAddress,
  ResponsesBridgeFallbackConfiguration,
} from "../../bridge/responses/responses-bridge-server.js";
import type { CodexProcessExit } from "./codex-launcher.js";
import {
  ResponsesCodexBridgeFactory,
  type CreateCodexBridgeInput,
  type ManagedCodexBridge,
  type ResponsesCodexBridgeFactoryOptions,
} from "./codex-bridge-factory.js";

export const CODEX_SHIM_AUTH_HEADER = "x-providerdock-shim-token";

export interface CodexShimProcessStartRequest {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly startupTimeoutMs: number;
}

export interface CodexShimProcessReady {
  readonly port: number;
}

export interface RunningCodexShimProcess {
  readonly pid: number;
  ready(): Promise<CodexShimProcessReady>;
  wait(): Promise<CodexProcessExit>;
  isRunning(): boolean;
  stop(): Promise<void>;
}

export interface CodexShimProcessRunner {
  start(request: CodexShimProcessStartRequest): RunningCodexShimProcess;
}

/** Starts an isolated codex-shim child and reports its bound loopback port. */
export class NodeCodexShimProcessRunner implements CodexShimProcessRunner {
  start(request: CodexShimProcessStartRequest): RunningCodexShimProcess {
    const child = spawn(request.executable, request.args, {
      cwd: request.cwd,
      env: request.environment,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let exited = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    const exit = new Promise<CodexProcessExit>((resolve) => {
      child.once("close", (code, signal) => {
        exited = true;
        exitCode = code;
        exitSignal = signal;
        resolve({ exitCode: code, signal });
      });
    });

    let output = "";
    let diagnosticOutput = "";
    let readySettled = false;
    let stopTask: Promise<void> | undefined;
    const ready = new Promise<CodexShimProcessReady>((resolve, reject) => {
      const diagnosticSuffix = (): string => {
        const detail = diagnosticOutput.trim().replace(/\s+/g, " ");
        return detail === "" ? "" : ` ${detail.slice(-1_000)}`;
      };
      const finish = (error?: Error, port?: number): void => {
        if (readySettled) return;
        readySettled = true;
        clearTimeout(timer);
        child.off("error", onError);
        child.stdout?.off("data", onData);
        child.stderr?.off("data", onStderrData);
        if (error !== undefined || port === undefined) {
          reject(error ?? new Error("codex-shim did not report a bound port."));
        } else {
          resolve({ port });
        }
      };

      const onError = (error: Error): void => {
        const detail =
          (error as NodeJS.ErrnoException).code === "ENOENT"
            ? "The configured Python executable was not found."
            : "The codex-shim process could not be started.";
        finish(new Error(`${detail} (${error.message})`));
      };
      const onData = (chunk: Buffer | string): void => {
        output = (output + chunk.toString("utf8")).slice(-8_192);
        const match = /PROVIDERDOCK_SHIM_READY:\s*(\{[^\r\n]*\})/.exec(output);
        if (!match?.[1]) return;
        try {
          const payload = JSON.parse(match[1]) as { port?: unknown };
          const port = Number(payload.port);
          if (Number.isInteger(port) && port >= 1 && port <= 65_535) {
            finish(undefined, port);
          } else {
            finish(new Error("codex-shim reported an invalid loopback port."));
          }
        } catch {
          finish(new Error("codex-shim returned an invalid readiness payload."));
        }
      };
      const onStderrData = (chunk: Buffer | string): void => {
        diagnosticOutput = (diagnosticOutput + chunk.toString("utf8")).slice(-8_192);
      };
      const timer = setTimeout(() => {
        finish(
          new Error(
            `codex-shim did not report readiness within ${request.startupTimeoutMs}ms.${diagnosticSuffix()}`,
          ),
        );
      }, request.startupTimeoutMs);

      child.once("error", onError);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onStderrData);
      child.once("close", () => {
        finish(
          new Error(
            `codex-shim exited before readiness (${exitSignal ?? `code ${exitCode ?? "unknown"}`}).${diagnosticSuffix()}`,
          ),
        );
      });
    });

    const stopProcess = async (): Promise<void> => {
      if (exited) return;
      // The wrapper treats stdin EOF and parent disappearance as shutdown signals.
      child.stdin?.end();
      await Promise.race([exit, delay(2_000)]);
      if (exited) return;

      child.kill();
      await Promise.race([exit, delay(2_000)]);
      if (exited) return;

      if (process.platform === "win32" && child.pid !== undefined) {
        await new Promise<void>((resolve) => {
          const killer = spawn(
            "taskkill.exe",
            ["/PID", String(child.pid), "/T", "/F"],
            { windowsHide: true, stdio: "ignore" },
          );
          killer.once("error", () => resolve());
          killer.once("exit", () => resolve());
        });
      } else {
        child.kill("SIGKILL");
      }
      await exit;
    };

    const pid = child.pid;
    if (pid === undefined) {
      ready.catch(() => undefined);
      child.kill();
      throw new Error("codex-shim started without a PID.");
    }

    return {
      pid,
      ready: () => ready,
      wait: () => exit,
      isRunning: () => !exited,
      stop: () => {
        stopTask ??= stopProcess().finally(() => {
          stopTask = undefined;
        });
        return stopTask;
      },
    };
  }
}

export interface CodexShimBridgeFactoryOptions
  extends ResponsesCodexBridgeFactoryOptions {
  readonly pythonExecutable?: string;
  readonly shimSourceDirectory?: string;
  readonly shimModule?: string;
  readonly processRunner?: CodexShimProcessRunner;
  readonly startupTimeoutMs?: number;
  readonly healthPollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

interface PreparedShimRoute {
  readonly originalProfile: ProviderProfile;
  readonly syntheticProfile: ProviderProfile;
  readonly process: RunningCodexShimProcess;
  readonly settingsPath: string;
}

/**
 * Adds a fail-closed Anthropic Messages compatibility route in front of the
 * normal managed Responses bridge. The codex-shim process is private to one
 * Codex runtime session and is never the global daemon on a fixed port.
 */
export class CodexShimCompatibilityBridgeFactory {
  private readonly pythonExecutable: string;
  private readonly shimSourceDirectory: string | undefined;
  private readonly shimModule: string;
  private readonly processes: CodexShimProcessRunner;
  private readonly startupTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly options: CodexShimBridgeFactoryOptions) {
    this.pythonExecutable =
      options.pythonExecutable ?? (process.platform === "win32" ? "python" : "python3");
    this.shimSourceDirectory = options.shimSourceDirectory;
    this.shimModule = options.shimModule ?? "codex_shim.server";
    this.processes = options.processRunner ?? new NodeCodexShimProcessRunner();
    this.startupTimeoutMs = positiveInteger(options.startupTimeoutMs, 15_000, "startupTimeoutMs");
    this.healthPollIntervalMs = positiveInteger(
      options.healthPollIntervalMs,
      100,
      "healthPollIntervalMs",
    );
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
  }

  supportsProfile(profile: ProviderProfile): boolean {
    return isResponsesCodexProfile(profile) || isSupportedAnthropicShimProfile(profile);
  }

  create(input: CreateCodexBridgeInput): ManagedCodexBridge {
    return new CodexShimCompatibilityBridge(
      input,
      {
        secretStore: this.options.secretStore,
        ...(this.options.modelAccessCheck === undefined
          ? {}
          : { modelAccessCheck: this.options.modelAccessCheck }),
        ...(this.options.protocolResolver === undefined
          ? {}
          : { protocolResolver: this.options.protocolResolver }),
        ...(this.options.adapterRegistry === undefined
          ? {}
          : { adapterRegistry: this.options.adapterRegistry }),
        ...(this.options.fetchImpl === undefined ? {} : { fetchImpl: this.options.fetchImpl }),
        ...(this.options.runtimeRoot === undefined ? {} : { runtimeRoot: this.options.runtimeRoot }),
        ...(this.options.usageSink === undefined ? {} : { usageSink: this.options.usageSink }),
        ...(this.options.healthSignalSink === undefined
          ? {}
          : { healthSignalSink: this.options.healthSignalSink }),
      },
      {
        pythonExecutable: this.pythonExecutable,
        ...(this.shimSourceDirectory === undefined
          ? {}
          : { shimSourceDirectory: this.shimSourceDirectory }),
        shimModule: this.shimModule,
        processRunner: this.processes,
        startupTimeoutMs: this.startupTimeoutMs,
        healthPollIntervalMs: this.healthPollIntervalMs,
        sleep: this.sleep,
      },
    );
  }
}

class CodexShimCompatibilityBridge implements ManagedCodexBridge {
  private startTask: Promise<ResponsesBridgeAddress> | undefined;
  private stopTask: Promise<void> | undefined;
  private inner: ManagedCodexBridge | undefined;
  private routes: readonly PreparedShimRoute[] = [];
  private directory: string | undefined;

  constructor(
    private readonly input: CreateCodexBridgeInput,
    private readonly bridgeOptions: ResponsesCodexBridgeFactoryOptions,
    private readonly shimOptions: {
      readonly pythonExecutable: string;
      readonly shimSourceDirectory?: string;
      readonly shimModule: string;
      readonly processRunner: CodexShimProcessRunner;
      readonly startupTimeoutMs: number;
      readonly healthPollIntervalMs: number;
      readonly sleep: (milliseconds: number) => Promise<void>;
    },
  ) {}

  start(): Promise<ResponsesBridgeAddress> {
    if (this.startTask !== undefined) return this.startTask;
    if (this.stopTask !== undefined) {
      this.startTask = this.stopTask.then(() => this.start());
      return this.startTask;
    }
    this.startTask = this.startInternal().finally(() => {
      this.startTask = undefined;
    });
    return this.startTask;
  }

  stop(): Promise<void> {
    if (this.stopTask !== undefined) return this.stopTask;
    this.stopTask = (async () => {
      if (this.startTask !== undefined) await this.startTask.catch(() => undefined);
      await this.stopInternal();
    })().finally(() => {
      this.stopTask = undefined;
    });
    return this.stopTask;
  }

  private async startInternal(): Promise<ResponsesBridgeAddress> {
    const anthropicProfiles = this.activeAnthropicProfiles();
    if (anthropicProfiles.length === 0) {
      this.inner = new ResponsesCodexBridgeFactory(this.bridgeOptions).create(this.input);
      try {
        return await this.inner.start();
      } catch (error) {
        await this.inner.stop().catch(() => undefined);
        throw error;
      }
    }

    const unsupported = anthropicProfiles.find(
      (profile) => !isSupportedAnthropicShimProfile(profile),
    );
    if (unsupported !== undefined) {
      throw new Error(
        `Provider '${unsupported.id}' must use generic Anthropic x-api-key header authentication for the managed codex-shim route.`,
      );
    }

    this.directory =
      this.bridgeOptions.runtimeRoot === undefined
        ? await mkdtemp(join(tmpdir(), "provider-dock-codex-shim-"))
        : join(this.bridgeOptions.runtimeRoot, "codex-shim", this.input.sessionId);
    await mkdir(this.directory, { recursive: true });

    const tokenSecrets: Record<string, string> = {};
    const syntheticById = new Map<string, ProviderProfile>();
    const started: PreparedShimRoute[] = [];
    this.routes = started;

    try {
      for (const profile of anthropicProfiles) {
        const modelIds = this.physicalModelIds(profile);
        if (modelIds.length === 0) {
          throw new Error(`Provider '${profile.id}' has no enabled model route for this session.`);
        }
        const auth = profile.auth;
        if (auth.kind !== "header") {
          throw new Error(`Provider '${profile.id}' must use x-api-key header authentication.`);
        }
        const secret = await this.requireSecret(auth.secretRef);
        const randomId = randomBytes(24).toString("hex");
        const apiKeyEnvironmentName = `PROVIDER_DOCK_SHIM_API_KEY_${randomId}`;
        const token = randomBytes(32).toString("base64url");
        const tokenReference = `providerdock.shim.token.${randomId}`;
        tokenSecrets[tokenReference] = token;

        const settingsPath = join(this.directory, `${profile.id}.models.json`);
        await writeFile(
          settingsPath,
          `${JSON.stringify(
            {
              models: modelIds.map((modelId) => ({
                model: modelId,
                provider: "anthropic",
                base_url: profile.baseUrl,
                api_key_env: apiKeyEnvironmentName,
                display_name: `${profile.displayName} ${modelId}`,
                ...(Object.keys(profile.staticHeaders).length === 0
                  ? {}
                  : { extra_headers: profile.staticHeaders }),
              })),
            },
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        );

        const wrapperPath = join(this.directory, `${profile.id}.server.py`);
        await writeFile(wrapperPath, CODEX_SHIM_WRAPPER_SOURCE, {
          encoding: "utf8",
          mode: 0o600,
        });

        const shimProcess = this.shimOptions.processRunner.start({
          executable: this.shimOptions.pythonExecutable,
          args: [
            wrapperPath,
            "--settings",
            settingsPath,
            "--host",
            "127.0.0.1",
            "--port",
            "0",
            "--parent-pid",
            String(process.pid),
          ],
          cwd: this.directory,
          environment: buildShimEnvironment({
            apiKeyEnvironmentName,
            apiKey: secret,
            authToken: token,
            home: this.directory,
            ...(this.shimOptions.shimSourceDirectory === undefined
              ? {}
              : { shimSourceDirectory: this.shimOptions.shimSourceDirectory }),
            shimModule: this.shimOptions.shimModule,
          }),
          startupTimeoutMs: this.shimOptions.startupTimeoutMs,
        });
        started.push({
          originalProfile: profile,
          process: shimProcess,
          settingsPath,
          syntheticProfile: profile,
        });

        const ready = await shimProcess.ready();
        await this.awaitShimHealth(shimProcess, ready.port, modelIds.length);
        const syntheticProfile: ProviderProfile = {
          ...profile,
          baseUrl: `http://127.0.0.1:${ready.port}/v1`,
          apiType: "openai-responses",
          adapterId: "generic-openai",
          auth: { kind: "header", headerName: CODEX_SHIM_AUTH_HEADER, secretRef: tokenReference },
          manualModelIds: [...modelIds],
          staticHeaders: {},
          secretHeaders: {},
          queryParameters: {},
        };
        syntheticById.set(profile.id, syntheticProfile);
        started[started.length - 1] = {
          originalProfile: profile,
          process: shimProcess,
          settingsPath,
          syntheticProfile,
        };
      }

      const replaceProfile = (profile: ProviderProfile): ProviderProfile =>
        syntheticById.get(profile.id) ?? profile;
      const innerInput: CreateCodexBridgeInput = {
        ...this.input,
        profile: replaceProfile(this.input.profile),
        ...(this.input.fallback === undefined
          ? {}
          : {
              fallback: {
                ...this.input.fallback,
                profiles: this.input.fallback.profiles.map(replaceProfile),
              },
            }),
      };
      const innerSecretStore: SecretStore = new ChainedSecretStore([
        new MemorySecretStore(tokenSecrets),
        this.bridgeOptions.secretStore,
      ]);
      this.inner = new ResponsesCodexBridgeFactory({
        ...this.bridgeOptions,
        secretStore: innerSecretStore,
      }).create(innerInput);
      return await this.inner.start();
    } catch (error) {
      await this.stopInternal();
      throw error;
    }
  }

  private async stopInternal(): Promise<void> {
    if (this.inner !== undefined) {
      await this.inner.stop().catch(() => undefined);
      this.inner = undefined;
    }
    const routes = this.routes;
    this.routes = [];
    await Promise.all(routes.map((route) => route.process.stop().catch(() => undefined)));

    const directory = this.directory;
    this.directory = undefined;
    if (directory !== undefined) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  private activeAnthropicProfiles(): readonly ProviderProfile[] {
    const profiles =
      this.input.fallback?.profiles.filter((profile) =>
        this.input.fallback?.logicalModel.routes.some(
          (route) => route.enabled && route.providerId === profile.id,
        ),
      ) ?? [this.input.profile];
    const unique = new Map<string, ProviderProfile>();
    for (const profile of profiles) {
      if (profile.apiType === "anthropic-messages") unique.set(profile.id, profile);
    }
    return [...unique.values()];
  }

  private physicalModelIds(profile: ProviderProfile): readonly string[] {
    if (this.input.fallback === undefined) return [this.input.modelId];
    return [
      ...new Set(
        this.input.fallback.logicalModel.routes
          .filter((route) => route.enabled && route.providerId === profile.id)
          .map((route) => route.modelId),
      ),
    ];
  }

  private async requireSecret(reference: string): Promise<string> {
    const secret = await this.bridgeOptions.secretStore.get(reference);
    if (secret === undefined || secret.length === 0) {
      throw new Error(`Required Anthropic API key reference '${reference}' is not available.`);
    }
    return secret;
  }

  private async awaitShimHealth(
    process: RunningCodexShimProcess,
    port: number,
    expectedModels: number,
  ): Promise<void> {
    const deadline = Date.now() + this.shimOptions.startupTimeoutMs;
    const fetchImpl = this.bridgeOptions.fetchImpl ?? fetch;
    let lastError: unknown;

    while (Date.now() < deadline) {
      if (!process.isRunning()) {
        throw new Error("codex-shim exited before its health endpoint became ready.");
      }
      const controller = new AbortController();
      const timer = setTimeout(
        () => controller.abort(new Error("codex-shim health check timed out.")),
        Math.max(1, Math.min(1_000, deadline - Date.now())),
      );
      timer.unref?.();
      try {
        const response = await fetchImpl(`http://127.0.0.1:${port}/health`, {
          signal: controller.signal,
        });
        if (!response.ok) {
          lastError = new Error(`codex-shim health returned HTTP ${response.status}.`);
        } else {
          const payload = await response.json();
          if (!isSafeShimHealth(payload, expectedModels)) {
            throw new Error(
              "codex-shim health did not report the isolated BYOK configuration.",
            );
          }
          return;
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes("isolated BYOK configuration")) {
          throw error;
        }
        lastError = error;
      } finally {
        clearTimeout(timer);
      }
      await this.shimOptions.sleep(
        Math.min(this.shimOptions.healthPollIntervalMs, Math.max(1, deadline - Date.now())),
      );
    }

    throw new Error(
      `codex-shim health did not become ready within ${this.shimOptions.startupTimeoutMs}ms. ${
        lastError instanceof Error ? lastError.message : ""
      }`.trim(),
    );
  }
}

export function isResponsesCodexProfile(profile: ProviderProfile): boolean {
  return ["auto", "openai-responses", "openai-chat-completions"].includes(profile.apiType);
}

export function isSupportedAnthropicShimProfile(profile: ProviderProfile): boolean {
  if (
    !profile.enabled ||
    profile.apiType !== "anthropic-messages" ||
    !["auto", "generic-anthropic"].includes(profile.adapterId) ||
    profile.auth.kind !== "header" ||
    profile.auth.headerName.toLowerCase() !== "x-api-key" ||
    Object.keys(profile.secretHeaders).length > 0 ||
    Object.keys(profile.queryParameters).length > 0
  ) {
    return false;
  }

  let url: URL;
  try {
    url = new URL(profile.baseUrl);
  } catch {
    return false;
  }
  if (url.username !== "" || url.password !== "") return false;
  return Object.keys(profile.staticHeaders).every(
    (name) => name.toLowerCase() !== CODEX_SHIM_AUTH_HEADER,
  );
}

interface BuildShimEnvironmentInput {
  readonly apiKeyEnvironmentName: string;
  readonly apiKey: string;
  readonly authToken: string;
  readonly home: string;
  readonly shimSourceDirectory?: string;
  readonly shimModule: string;
}

function buildShimEnvironment(input: BuildShimEnvironmentInput): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const inheritedNames = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "ComSpec",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ];
  for (const name of inheritedNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }

  environment.HOME = input.home;
  if (process.platform === "win32") environment.USERPROFILE = input.home;
  environment.CODEX_HOME = input.home;
  environment.PYTHONIOENCODING = "utf-8";
  environment.CODEX_SHIM_DISABLE_CHATGPT = "1";
  environment.CODEX_SHIM_DISABLE_CURSOR = "1";
  environment.CODEX_SHIM_DISABLE_ROUTER = "1";
  environment.PROVIDER_DOCK_CODEX_SHIM_MODULE = input.shimModule;
  environment.PROVIDER_DOCK_SHIM_AUTH_TOKEN = input.authToken;
  environment[input.apiKeyEnvironmentName] = input.apiKey;

  if (input.shimSourceDirectory !== undefined) {
    const existing = environment.PYTHONPATH;
    environment.PYTHONPATH =
      existing === undefined || existing.trim() === ""
        ? input.shimSourceDirectory
        : `${input.shimSourceDirectory}${delimiter}${existing}`;
  }
  return environment;
}

interface CodexShimHealthPayload {
  readonly ok: boolean;
  readonly models: number;
  readonly chatgpt_passthrough: boolean;
  readonly cursor_passthrough: boolean;
  readonly auto_router: boolean;
}

function isSafeShimHealth(value: unknown, expectedModels: number): value is CodexShimHealthPayload {
  if (typeof value !== "object" || value === null) return false;
  const payload = value as Partial<CodexShimHealthPayload>;
  return (
    payload.ok === true &&
    payload.models === expectedModels &&
    payload.chatgpt_passthrough === false &&
    payload.cursor_passthrough === false &&
    payload.auto_router === false
  );
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new TypeError(`${name} must be a positive integer.`);
  }
  return resolved;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

const CODEX_SHIM_WRAPPER_SOURCE = String.raw`from __future__ import annotations

import argparse
import asyncio
import ctypes
import importlib
import json
import os
import secrets
import signal
import sys
import threading
from pathlib import Path

MODULE_NAME = os.environ.get("PROVIDER_DOCK_CODEX_SHIM_MODULE", "codex_shim.server")
server = importlib.import_module(MODULE_NAME)
web = server.web

if not hasattr(server, "ShimServer"):
    raise RuntimeError("codex-shim module does not expose ShimServer")
if not hasattr(server, "_dump_debug_request"):
    raise RuntimeError("codex-shim module does not expose the debug-dump hook")
if not hasattr(server, "_log_incoming_request"):
    raise RuntimeError("codex-shim module does not expose the request-log hook")

server._dump_debug_request = lambda *args, **kwargs: None
server._log_incoming_request = lambda *args, **kwargs: None
server.ShimServer._needs_image_gen = lambda self, body: False
server.ShimServer._needs_image_followup = lambda self, body: False

AUTH_HEADER = "x-providerdock-shim-token"
ALLOWED_ROUTES = {("GET", "/health"), ("POST", "/v1/responses")}


def parent_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.OpenProcess(0x00100000, False, pid)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == 258
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


async def run(args: argparse.Namespace) -> None:
    auth_token = os.environ.get("PROVIDER_DOCK_SHIM_AUTH_TOKEN", "")
    if not auth_token:
        raise RuntimeError("The managed codex-shim auth token is missing.")
    expected_token = auth_token.encode("utf-8")

    shim = server.ShimServer(args.settings, host=args.host)
    app = shim.app()

    @web.middleware
    async def providerdock_guard(request, handler):
        if (request.method, request.path) not in ALLOWED_ROUTES:
            raise web.HTTPNotFound
        if request.path != "/health":
            supplied = request.headers.get(AUTH_HEADER, "").encode("utf-8")
            if not secrets.compare_digest(supplied, expected_token):
                raise web.HTTPUnauthorized
        return await handler(request)

    app.middlewares.insert(0, providerdock_guard)

    runner = web.AppRunner(app, access_log=None)
    await runner.setup()
    site = web.TCPSite(runner, args.host, args.port, shutdown_timeout=1)
    await site.start()

    bound_port = args.port
    if bound_port == 0:
        addresses = list(getattr(runner, "addresses", []))
        for address in addresses:
            if isinstance(address, tuple) and len(address) >= 2:
                bound_port = int(address[1])
                break
    if not isinstance(bound_port, int) or bound_port <= 0:
        await runner.cleanup()
        raise RuntimeError("codex-shim did not expose its bound loopback port.")

    print("PROVIDERDOCK_SHIM_READY:" + json.dumps({"port": bound_port}), flush=True)

    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def request_stop() -> None:
        if stop_event.is_set():
            return
        loop.call_soon_threadsafe(stop_event.set)

    def watch_stdin() -> None:
        try:
            while True:
                if not sys.stdin.buffer.read(1):
                    break
        except Exception:
            pass
        try:
            request_stop()
        except RuntimeError:
            pass

    threading.Thread(target=watch_stdin, name="providerdock-parent-watch", daemon=True).start()

    for received_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            loop.add_signal_handler(received_signal, stop_event.set)
        except (NotImplementedError, AttributeError):
            signal.signal(received_signal, lambda *_: stop_event.set())

    async def watch_parent() -> None:
        while not stop_event.is_set():
            if not parent_alive(args.parent_pid):
                stop_event.set()
                return
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=0.25)
            except asyncio.TimeoutError:
                continue

    parent_task = asyncio.create_task(watch_parent())
    try:
        await stop_event.wait()
    finally:
        parent_task.cancel()
        try:
            await parent_task
        except asyncio.CancelledError:
            pass
        await runner.cleanup()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--settings", type=Path, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--parent-pid", type=int, default=0)
    args = parser.parse_args()
    try:
        asyncio.run(run(args))
    except Exception as exc:
        print(f"providerdock codex-shim wrapper failed: {exc}", file=sys.stderr, flush=True)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
`;
