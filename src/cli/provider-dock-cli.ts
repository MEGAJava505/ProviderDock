import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { ProviderDockApplication } from "../application/provider-dock-application.js";
import {
  AutomaticClientResolutionError,
  LogicalModelInUseByPromptProfileError,
  LogicalModelNotFoundError,
  PromptProfileLaunchConfigurationError,
  PromptProfileInUseByProjectProfileError,
  PromptProfileNotFoundError,
  ProfileBundleConflictError,
  ProfileBundleImportError,
  ProfileBundleValidationError,
  ProjectProfileNotFoundError,
  ProviderHealthNotFoundError,
  ProviderInUseByLogicalModelError,
  ProviderInUseByPromptProfileError,
  ProviderNotFoundError,
  SecretVaultUnavailableError,
} from "../application/provider-dock-application.js";
import { SecretProtectionError } from "../core/security/dpapi-secret-vault.js";
import { CodexRuntimeConfigurationError } from "../clients/codex/codex-runtime-config.js";
import { agentApprovalLevels, type AgentApprovalLevel } from "../clients/agent-approval.js";
import {
  preferredClients,
  parseProviderAdapterId,
  providerAdapterIds,
  providerApiTypes,
  type ProviderAuth,
  type ModelTokenPricing,
  type ProviderProfile,
} from "../core/providers/provider-profile.js";
import type { ProviderProbeResult } from "../core/health/provider-probe-service.js";
import type {
  ModelCapabilitySnapshot,
  ProviderHealthRecord,
} from "../core/health/provider-health-repository.js";
import type {
  LogicalModelGroup,
  LogicalModelRoute,
} from "../core/fallback/logical-model.js";
import type { FallbackNotification } from "../core/fallback/fallback-session-router.js";
import {
  promptFallbackPolicies,
  type PromptProfile,
} from "../core/profiles/prompt-profile.js";
import type { DoctorLevel, DoctorReport } from "../diagnostics/provider-doctor.js";
import { usageClients } from "../core/usage/usage-event.js";
import type {
  UsageFilter,
  UsageSummaryRow,
} from "../core/usage/usage-repository.js";
import {
  ProviderPluginExecutionError,
  ProviderPluginValidationError,
  type ProviderPluginDescriptor,
} from "../core/plugins/provider-plugin-sdk.js";
import { ProviderDashboardServer } from "../ui/provider-dashboard-server.js";
import { openDashboardInBrowser } from "../ui/open-dashboard-browser.js";
import { providerErrorGuidance } from "../core/errors/provider-error.js";

export interface CliIo {
  readonly stdout: (message: string) => void;
  readonly stderr: (message: string) => void;
}

export interface RunProviderDockCliOptions {
  readonly application: ProviderDockApplication;
  readonly io?: CliIo;
  readonly environment?: NodeJS.ProcessEnv;
}

const consoleIo: CliIo = {
  stdout: (message) => console.log(message),
  stderr: (message) => console.error(message),
};

export async function runProviderDockCli(
  argv: readonly string[],
  options: RunProviderDockCliOptions,
): Promise<number> {
  const io = options.io ?? consoleIo;

  try {
    return await execute(argv, options.application, io, options.environment ?? process.env);
  } catch (error) {
    if (
      error instanceof CliUsageError ||
      error instanceof AutomaticClientResolutionError ||
      error instanceof LogicalModelInUseByPromptProfileError ||
      error instanceof LogicalModelNotFoundError ||
      error instanceof PromptProfileLaunchConfigurationError ||
      error instanceof PromptProfileInUseByProjectProfileError ||
      error instanceof PromptProfileNotFoundError ||
      error instanceof ProfileBundleConflictError ||
      error instanceof ProfileBundleImportError ||
      error instanceof ProfileBundleValidationError ||
      error instanceof ProjectProfileNotFoundError ||
      error instanceof ProviderHealthNotFoundError ||
      error instanceof ProviderInUseByLogicalModelError ||
      error instanceof ProviderInUseByPromptProfileError ||
      error instanceof ProviderNotFoundError ||
      error instanceof ProviderPluginExecutionError ||
      error instanceof ProviderPluginValidationError ||
      error instanceof SecretVaultUnavailableError ||
      error instanceof SecretProtectionError ||
      error instanceof CodexRuntimeConfigurationError
    ) {
      io.stderr(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof z.ZodError) {
      io.stderr(`Error: invalid configuration\n${error.issues.map(formatZodIssue).join("\n")}`);
      return 1;
    }
    if (isParseArgsError(error)) {
      io.stderr(`Error: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function execute(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(helpText);
    return 0;
  }

  if (command === "providers") return executeProviders(rest, application, io);
  if (command === "plugins") return executePlugins(rest, application, io);
  if (command === "logical-models") return executeLogicalModels(rest, application, io);
  if (command === "prompt-profiles") return executePromptProfiles(rest, application, io);
  if (command === "project-profiles") return executeProjectProfiles(rest, application, io);
  if (command === "profiles") return executeProfileBundles(rest, application, io);
  if (command === "probe") return executeProbe(rest, application, io);
  if (command === "health") return executeHealth(rest, application, io);
  if (command === "doctor") return executeDoctor(rest, application, io);
  if (command === "usage") return executeUsage(rest, application, io);
  if (command === "dashboard") return executeDashboard(rest, application, io);
  if (command === "secrets") return executeSecrets(rest, application, io, environment);
  if (command === "launch") return executeLaunch(rest, application, io, environment);
  if (command === "recover") return executeRecovery(rest, application, io);

  throw new CliUsageError(`Unknown command '${command}'. Run 'providerdock help'.`);
}

async function executeDashboard(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      port: { type: "string", default: "0" },
      open: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const port = parseInteger(values.port, "--port");
  if (port > 65_535) {
    throw new CliUsageError("--port must be between 0 and 65535.");
  }

  let server: ProviderDashboardServer;
  try {
    server = new ProviderDashboardServer({ application, port });
  } catch (error) {
    throw new CliUsageError(
      error instanceof Error
        ? `Dashboard configuration is invalid: ${error.message}`
        : "Dashboard configuration is invalid.",
    );
  }

  try {
    let address;
    try {
      address = await server.start();
    } catch (error) {
      throw new CliUsageError(
        error instanceof Error
          ? `Dashboard could not start: ${error.message}`
          : "Dashboard could not start.",
      );
    }
    io.stdout(
      `ProviderDock dashboard: ${address.url}\nKeep this URL private; it contains the local dashboard session token.\nPress Ctrl+C to stop the dashboard.`,
    );
    if (values.open) {
      try {
        await openDashboardInBrowser(address.url);
      } catch (error) {
        io.stderr(
          `Warning: the browser could not be opened automatically: ${
            error instanceof Error ? error.message : "unknown error"
          }. Open the dashboard URL shown above.`,
        );
      }
    }
    await waitForDashboardTerminationSignal();
    return 0;
  } finally {
    await server.stop().catch(() => undefined);
  }
}

function waitForDashboardTerminationSignal(): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      process.off("SIGINT", finish);
      process.off("SIGTERM", finish);
      resolve();
    };
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
  });
}

async function executePlugins(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "list") {
    throw new CliUsageError("Expected plugins subcommand: list.");
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const plugins = application.listProviderPlugins();
  if (values.json) io.stdout(JSON.stringify(plugins, null, 2));
  else if (plugins.length === 0) io.stdout("No provider plugins loaded.");
  else io.stdout(renderProviderPluginTable(plugins));
  return 0;
}

async function executeUsage(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "list" && command !== "summary") {
    throw new CliUsageError("Expected usage subcommand: list or summary.");
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      client: { type: "string" },
      since: { type: "string" },
      until: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const filter: UsageFilter = {
    ...(typeof values.provider === "string"
      ? { providerId: values.provider }
      : {}),
    ...(typeof values.model === "string" ? { modelId: values.model } : {}),
    ...(typeof values.client === "string"
      ? {
          client: parseEnum(
            values.client,
            usageClients,
            "--client",
          ),
        }
      : {}),
    ...(typeof values.since === "string"
      ? { since: parseIsoTimestamp(values.since, "--since") }
      : {}),
    ...(typeof values.until === "string"
      ? { until: parseIsoTimestamp(values.until, "--until") }
      : {}),
  };

  if (command === "list") {
    const events = await application.listUsage(filter);
    if (values.json) io.stdout(JSON.stringify(events, null, 2));
    else if (events.length === 0) io.stdout("No usage telemetry recorded.");
    else {
      io.stdout(
        renderTable(
          [
            "RECORDED",
            "PROVIDER",
            "MODEL",
            "CLIENT",
            "PROTOCOL",
            "OUTCOME",
            "INPUT",
            "CACHE R",
            "CACHE W",
            "OUTPUT",
            "TOTAL",
            "COST",
          ],
          events.map((event) => [
            event.recordedAt,
            event.providerId,
            event.modelId,
            event.client,
            event.protocol,
            event.outcome,
            String(event.usage.uncachedInputTokens),
            String(event.usage.cacheReadInputTokens),
            String(event.usage.cacheWriteInputTokens),
            String(event.usage.outputTokens),
            String(event.usage.totalTokens),
            event.cost === undefined
              ? "-"
              : formatMicrounits(
                  event.cost.currency,
                  event.cost.microunits,
                ),
          ]),
        ),
      );
    }
    return 0;
  }

  const rows = await application.summarizeUsage(filter);
  if (values.json) io.stdout(JSON.stringify(rows, null, 2));
  else if (rows.length === 0) io.stdout("No usage telemetry recorded.");
  else io.stdout(renderUsageSummary(rows));
  return 0;
}

async function executeProfileBundles(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "export": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          file: { type: "string" },
          force: { type: "boolean", default: false },
        },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const filePath = resolve(requireString(values.file, "--file"));
      const bundle = await application.exportProfileBundle();
      await mkdir(dirname(filePath), { recursive: true });
      try {
        await writeFile(filePath, `${JSON.stringify(bundle, null, 2)}\n`, {
          encoding: "utf8",
          flag: values.force ? "w" : "wx",
        });
      } catch (error) {
        if (isNodeError(error) && error.code === "EEXIST") {
          throw new CliUsageError(
            `Export file '${filePath}' already exists. Use --force to replace it.`,
          );
        }
        throw error;
      }
      io.stdout(
        `Exported ${bundle.providers.length} provider(s), ${bundle.logicalModels.length} logical model(s), ` +
          `${bundle.promptProfiles.length} prompt profile(s), and ${bundle.projectProfiles.length} project profile(s) to '${filePath}'.`,
      );
      return 0;
    }
    case "import": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          file: { type: "string" },
          overwrite: { type: "boolean", default: false },
        },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const filePath = resolve(requireString(values.file, "--file"));
      const contents = await readFile(filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > 16 * 1024 * 1024) {
        throw new CliUsageError("Profile bundle exceeds 16777216 bytes.");
      }
      let input: unknown;
      try {
        input = JSON.parse(contents);
      } catch {
        throw new CliUsageError(`Profile bundle '${filePath}' is not valid JSON.`);
      }
      const imported = await application.importProfileBundle(input, {
        overwrite: values.overwrite,
      });
      io.stdout(
        `Imported profiles from '${filePath}': ` +
          `${formatImportCounts("providers", imported.providers)}, ` +
          `${formatImportCounts("logical models", imported.logicalModels)}, ` +
          `${formatImportCounts("prompt profiles", imported.promptProfiles)}, ` +
          `${formatImportCounts("project profiles", imported.projectProfiles)}.`,
      );
      return 0;
    }
    default:
      throw new CliUsageError("Expected profiles subcommand: export or import.");
  }
}

async function executeLogicalModels(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "list": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const logicalModels = await application.listLogicalModels();
      if (values.json) io.stdout(JSON.stringify(logicalModels, null, 2));
      else if (logicalModels.length === 0) io.stdout("No logical models configured.");
      else io.stdout(renderLogicalModelTable(logicalModels));
      return 0;
    }
    case "show": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      const id = requireSinglePositional(positionals, "logical-models show <logical-model-id>");
      io.stdout(JSON.stringify(await application.getLogicalModel(id), null, 2));
      return 0;
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          id: { type: "string" },
          route: { type: "string", multiple: true },
          "disabled-route": { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const routes = [
        ...(values.route ?? []).map((value) => parseLogicalModelRoute(value, true)),
        ...(values["disabled-route"] ?? []).map((value) =>
          parseLogicalModelRoute(value, false),
        ),
      ];
      if (routes.length === 0) {
        throw new CliUsageError("At least one --route is required.");
      }
      const logicalModel = await application.setLogicalModel({
        id: requireString(values.id, "--id"),
        routes,
      });
      io.stdout(`Saved logical model '${logicalModel.id}'.`);
      return 0;
    }
    case "remove": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      const id = requireSinglePositional(positionals, "logical-models remove <logical-model-id>");
      await application.removeLogicalModel(id);
      io.stdout(`Removed logical model '${id}'.`);
      return 0;
    }
    default:
      throw new CliUsageError(
        "Expected logical-models subcommand: list, show, set, or remove.",
      );
  }
}

async function executePromptProfiles(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "list": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const profiles = await application.listPromptProfiles();
      if (values.json) io.stdout(JSON.stringify(profiles, null, 2));
      else if (profiles.length === 0) io.stdout("No prompt profiles configured.");
      else io.stdout(renderPromptProfileTable(profiles));
      return 0;
    }
    case "show": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      const id = requireSinglePositional(
        positionals,
        "prompt-profiles show <prompt-profile-id>",
      );
      io.stdout(JSON.stringify(await application.getPromptProfile(id), null, 2));
      return 0;
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          "instructions-file": { type: "string" },
          provider: { type: "string" },
          "preferred-model": { type: "string" },
          "logical-model": { type: "string" },
          client: { type: "string" },
          reasoning: { type: "string" },
          fallback: { type: "string" },
          "codex-flag": { type: "string", multiple: true },
          "claude-flag": { type: "string", multiple: true },
        },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const profile = await application.setPromptProfile({
        id: requireString(values.id, "--id"),
        name: requireString(values.name, "--name"),
        description:
          typeof values.description === "string" ? values.description : "",
        instructions: await readPromptInstructions(
          requireString(values["instructions-file"], "--instructions-file"),
        ),
        ...(typeof values.provider === "string"
          ? { preferredProviderId: values.provider }
          : {}),
        ...(typeof values["preferred-model"] === "string"
          ? { preferredModelId: values["preferred-model"] }
          : {}),
        ...(typeof values["logical-model"] === "string"
          ? { preferredLogicalModelId: values["logical-model"] }
          : {}),
        preferredClient: parseEnum(
          typeof values.client === "string" ? values.client : "auto",
          preferredClients,
          "--client",
        ),
        ...(typeof values.reasoning === "string"
          ? { reasoningLevel: values.reasoning }
          : {}),
        fallbackPolicy: parseEnum(
          typeof values.fallback === "string" ? values.fallback : "disabled",
          promptFallbackPolicies,
          "--fallback",
        ),
        clientFlags: {
          codex: values["codex-flag"] ?? [],
          claudeCode: values["claude-flag"] ?? [],
        },
      });
      io.stdout(`Saved prompt profile '${profile.id}'.`);
      return 0;
    }
    case "remove": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      const id = requireSinglePositional(
        positionals,
        "prompt-profiles remove <prompt-profile-id>",
      );
      await application.removePromptProfile(id);
      io.stdout(`Removed prompt profile '${id}'.`);
      return 0;
    }
    default:
      throw new CliUsageError(
        "Expected prompt-profiles subcommand: list, show, set, or remove.",
      );
  }
}

async function executeProjectProfiles(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "list": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const profiles = await application.listProjectProfiles();
      if (values.json) io.stdout(JSON.stringify(profiles, null, 2));
      else if (profiles.length === 0) io.stdout("No project profiles configured.");
      else {
        io.stdout(
          renderTable(
            ["PROJECT DIRECTORY", "PROMPT PROFILE"],
            profiles.map((profile) => [
              profile.projectDirectory,
              profile.promptProfileId,
            ]),
          ),
        );
      }
      return 0;
    }
    case "show": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { project: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      io.stdout(
        JSON.stringify(
          await application.getProjectProfile(
            requireString(values.project, "--project"),
          ),
          null,
          2,
        ),
      );
      return 0;
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: {
          project: { type: "string" },
          "prompt-profile": { type: "string" },
        },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const profile = await application.setProjectProfile({
        projectDirectory: requireString(values.project, "--project"),
        promptProfileId: requireString(
          values["prompt-profile"],
          "--prompt-profile",
        ),
      });
      io.stdout(`Saved project profile '${profile.projectDirectory}'.`);
      return 0;
    }
    case "remove": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { project: { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const projectDirectory = requireString(values.project, "--project");
      await application.removeProjectProfile(projectDirectory);
      io.stdout(`Removed project profile '${projectDirectory}'.`);
      return 0;
    }
    default:
      throw new CliUsageError(
        "Expected project-profiles subcommand: list, show, set, or remove.",
      );
  }
}

function approvalOption(value: string | undefined): { approvalLevel?: AgentApprovalLevel } {
  if (value === undefined) return {};
  if (!(agentApprovalLevels as readonly string[]).includes(value)) {
    throw new CliUsageError("--approval must be one of: ask, auto, full-auto.");
  }
  return { approvalLevel: value as AgentApprovalLevel };
}

async function executeLaunch(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const [client, ...rest] = argv;
  if (client === "auto") return executeLaunchAuto(rest, application, io, environment);
  if (client === "claude") return executeLaunchClaude(rest, application, io, environment);
  if (client !== "codex") {
    throw new CliUsageError("Usage: providerdock launch <auto|codex|claude> [options]");
  }
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "logical-model": { type: "string" },
      "prompt-profile": { type: "string" },
      project: { type: "string" },
      "bridge-url": { type: "string" },
      executable: { type: "string" },
      approval: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const bridgeUrl = values["bridge-url"];
  const logicalModelId = values["logical-model"];
  const promptProfileId = values["prompt-profile"];
  let exit;
  if (typeof promptProfileId === "string") {
    if (
      values.provider !== undefined ||
      values.model !== undefined ||
      logicalModelId !== undefined ||
      bridgeUrl !== undefined
    ) {
      throw new CliUsageError(
        "--prompt-profile cannot be combined with --provider, --model, --logical-model, or --bridge-url.",
      );
    }
    exit = await application.launchCodexPromptProfile({
      promptProfileId,
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else if (typeof logicalModelId === "string") {
    if (values.provider !== undefined || values.model !== undefined || bridgeUrl !== undefined) {
      throw new CliUsageError(
        "--logical-model cannot be combined with --provider, --model, or --bridge-url.",
      );
    }
    exit = await application.launchCodexLogicalModel({
      logicalModelId,
      projectDirectory: requireString(values.project, "--project"),
      route: { kind: "auto" },
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else if (
    values.provider === undefined &&
    values.model === undefined &&
    bridgeUrl === undefined
  ) {
    exit = await application.launchCodexProjectProfile({
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else {
    exit = await application.launchCodex({
      providerId: requireString(values.provider, "--provider"),
      modelId: requireString(values.model, "--model"),
      projectDirectory: requireString(values.project, "--project"),
      route: bridgeUrl ? { kind: "bridge", baseUrl: bridgeUrl } : { kind: "auto" },
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
    });
  }
  const status = exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `exit code ${exit.exitCode}`;
  io.stdout(`Codex session finished with ${status}.`);
  return exit.exitCode ?? 1;
}

async function executeLaunchAuto(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "logical-model": { type: "string" },
      "prompt-profile": { type: "string" },
      project: { type: "string" },
      executable: { type: "string" },
      approval: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const projectDirectory = requireString(values.project, "--project");
  const common = {
    projectDirectory,
    ...(values.executable ? { executable: values.executable } : {}),
    ...approvalOption(values.approval),
    parentEnvironment: environment,
    onFallback: (notification: FallbackNotification) => {
      io.stderr(
        `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
          `${notification.to.providerId}/${notification.to.modelId}` +
          `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
      );
    },
  };
  const promptProfileId = values["prompt-profile"];
  const logicalModelId = values["logical-model"];
  let result;
  if (typeof promptProfileId === "string") {
    if (
      values.provider !== undefined ||
      values.model !== undefined ||
      logicalModelId !== undefined
    ) {
      throw new CliUsageError(
        "--prompt-profile cannot be combined with --provider, --model, or --logical-model.",
      );
    }
    result = await application.launchPromptProfileAutomatic({
      ...common,
      promptProfileId,
    });
  } else if (typeof logicalModelId === "string") {
    if (values.provider !== undefined || values.model !== undefined) {
      throw new CliUsageError(
        "--logical-model cannot be combined with --provider or --model.",
      );
    }
    result = await application.launchLogicalModelAutomatic({
      ...common,
      logicalModelId,
    });
  } else if (values.provider !== undefined || values.model !== undefined) {
    result = await application.launchProviderAutomatic({
      ...common,
      providerId: requireString(values.provider, "--provider"),
      modelId: requireString(values.model, "--model"),
    });
  } else {
    result = await application.launchProjectProfileAutomatic(common);
  }

  const status =
    result.exit.exitCode === null
      ? `signal ${result.exit.signal ?? "unknown"}`
      : `exit code ${result.exit.exitCode}`;
  io.stdout(
    `${result.client === "codex" ? "Codex" : "Claude Code"} session finished with ${status}.`,
  );
  return result.exit.exitCode ?? 1;
}

async function executeLaunchClaude(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      "logical-model": { type: "string" },
      "prompt-profile": { type: "string" },
      project: { type: "string" },
      executable: { type: "string" },
      approval: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const logicalModelId = values["logical-model"];
  const promptProfileId = values["prompt-profile"];
  let exit;
  if (typeof promptProfileId === "string") {
    if (
      values.provider !== undefined ||
      values.model !== undefined ||
      logicalModelId !== undefined
    ) {
      throw new CliUsageError(
        "--prompt-profile cannot be combined with --provider, --model, or --logical-model.",
      );
    }
    exit = await application.launchClaudePromptProfile({
      promptProfileId,
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else if (typeof logicalModelId === "string") {
    if (values.provider !== undefined || values.model !== undefined) {
      throw new CliUsageError(
        "--logical-model cannot be combined with --provider or --model.",
      );
    }
    exit = await application.launchClaudeLogicalModel({
      logicalModelId,
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else if (values.provider === undefined && values.model === undefined) {
    exit = await application.launchClaudeProjectProfile({
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
      onFallback: (notification) => {
        io.stderr(
          `ProviderDock fallback: ${notification.from.providerId}/${notification.from.modelId} -> ` +
            `${notification.to.providerId}/${notification.to.modelId}` +
            `${notification.errorType === undefined ? "" : ` (${notification.errorType})`}.`,
        );
      },
    });
  } else {
    exit = await application.launchClaude({
      providerId: requireString(values.provider, "--provider"),
      modelId: requireString(values.model, "--model"),
      projectDirectory: requireString(values.project, "--project"),
      ...(values.executable ? { executable: values.executable } : {}),
      ...approvalOption(values.approval),
      parentEnvironment: environment,
    });
  }
  const status =
    exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `exit code ${exit.exitCode}`;
  io.stdout(`Claude Code session finished with ${status}.`);
  return exit.exitCode ?? 1;
}

async function executeRecovery(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [client, ...rest] = argv;
  if (client !== "codex") throw new CliUsageError("Usage: providerdock recover codex [--json]");
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const outcomes = await application.recoverCodexSessions();
  if (values.json) io.stdout(JSON.stringify(outcomes, null, 2));
  else if (outcomes.length === 0) io.stdout("No stale Codex sessions found.");
  else {
    io.stdout(
      renderTable(
        ["SESSION", "STATUS", "DETAILS"],
        outcomes.map((outcome) => [
          outcome.sessionId,
          outcome.status,
          outcome.status === "ACTIVE"
            ? `PID ${outcome.pid}${
                outcome.bridge === undefined
                  ? ""
                  : `; bridge ${outcome.bridge.ownership}/${outcome.bridge.state} ${outcome.bridge.baseUrl}`
              }`
            : outcome.status === "CONFLICT" || outcome.status === "INVALID"
              ? outcome.message
              : "temporary profile removed",
        ]),
      ),
    );
  }
  return outcomes.some(
    (outcome) => outcome.status === "CONFLICT" || outcome.status === "INVALID",
  )
    ? 2
    : 0;
}

async function executeSecrets(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "list": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const references = await application.listSecretReferences();
      io.stdout(references.length > 0 ? references.join("\n") : "No secrets stored.");
      return 0;
    }
    case "set": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { "from-env": { type: "string" } },
        allowPositionals: true,
        strict: true,
      });
      const reference = requireSinglePositional(
        positionals,
        "secrets set <reference> --from-env VARIABLE",
      );
      const environmentName = requireString(values["from-env"], "--from-env");
      const value = environment[environmentName];
      if (!value) {
        throw new CliUsageError(`Environment variable '${environmentName}' is not set or empty.`);
      }
      await application.setSecret(reference, value);
      io.stdout(`Stored secret '${reference}' in the OS-protected vault.`);
      return 0;
    }
    case "remove": {
      const { positionals } = parseArgs({
        args: [...rest],
        allowPositionals: true,
        strict: true,
      });
      const reference = requireSinglePositional(positionals, "secrets remove <reference>");
      const removed = await application.removeSecret(reference);
      if (!removed) throw new CliUsageError(`Secret '${reference}' is not stored.`);
      io.stdout(`Removed secret '${reference}'.`);
      return 0;
    }
    default:
      throw new CliUsageError("Expected secrets subcommand: list, set, or remove.");
  }
}

async function executeProviders(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;

  switch (command) {
    case "list":
      return listProviders(rest, application, io);
    case "show":
      return showProvider(rest, application, io);
    case "set":
      return setProvider(rest, application, io);
    case "remove":
      return removeProvider(rest, application, io);
    default:
      throw new CliUsageError(
        "Expected providers subcommand: list, show, set, or remove.",
      );
  }
}

async function listProviders(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const profiles = await application.listProviders();

  if (values.json) io.stdout(JSON.stringify(profiles, null, 2));
  else if (profiles.length === 0) io.stdout("No providers configured.");
  else io.stdout(renderProviderTable(profiles));
  return 0;
}

async function showProvider(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true });
  const id = requireSinglePositional(positionals, "providers show <provider-id>");
  io.stdout(JSON.stringify(await application.getProvider(id), null, 2));
  return 0;
}

async function setProvider(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      id: { type: "string" },
      name: { type: "string" },
      "base-url": { type: "string" },
      "api-type": { type: "string" },
      adapter: { type: "string" },
      "models-endpoint": { type: "string" },
      "manual-model": { type: "string", multiple: true },
      pricing: { type: "string", multiple: true },
      "preferred-client": { type: "string" },
      "timeout-ms": { type: "string" },
      "auth-kind": { type: "string" },
      "secret-ref": { type: "string" },
      "auth-name": { type: "string" },
      header: { type: "string", multiple: true },
      "secret-header": { type: "string", multiple: true },
      query: { type: "string", multiple: true },
      disabled: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);

  const id = requireString(values.id, "--id");
  const profile = await application.setProvider({
    id,
    displayName: requireString(values.name, "--name"),
    baseUrl: requireString(values["base-url"], "--base-url"),
    apiType: parseEnum(values["api-type"] ?? "auto", providerApiTypes, "--api-type"),
    adapterId: parseProviderAdapterOption(values.adapter ?? "auto"),
    auth: parseAuth(values),
    enabled: !values.disabled,
    staticHeaders: parseAssignments(values.header, "--header"),
    secretHeaders: parseAssignments(values["secret-header"], "--secret-header"),
    queryParameters: parseAssignments(values.query, "--query"),
    modelsEndpoint: values["models-endpoint"] ?? "models",
    manualModelIds: values["manual-model"] ?? [],
    modelPricing: parseModelPricing(values.pricing ?? []),
    preferredClient: parseEnum(
      values["preferred-client"] ?? "auto",
      preferredClients,
      "--preferred-client",
    ),
    timeoutMs: parseInteger(values["timeout-ms"] ?? "120000", "--timeout-ms"),
  });

  io.stdout(`Saved provider '${profile.id}'.`);
  return 0;
}

async function removeProvider(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { positionals } = parseArgs({ args: [...argv], allowPositionals: true, strict: true });
  const id = requireSinglePositional(positionals, "providers remove <provider-id>");
  await application.removeProvider(id);
  io.stdout(`Removed provider '${id}'.`);
  return 0;
}

async function executeProbe(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: { json: { type: "boolean", default: false } },
    allowPositionals: true,
    strict: true,
  });
  const id = requireSinglePositional(positionals, "probe <provider-id> [--json]");
  const result = await application.probeProvider(id);
  io.stdout(values.json ? JSON.stringify(result, null, 2) : renderProbe(result));
  return result.health.status === "ONLINE" ? 0 : 2;
}

async function executeHealth(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case "list": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      assertNoPositionals(positionals);
      const records = await application.listProviderHealth();
      if (values.json) io.stdout(JSON.stringify(records, null, 2));
      else if (records.length === 0) io.stdout("No persisted health snapshots.");
      else {
        io.stdout(
          renderTable(
            [
              "PROVIDER",
              "STATUS",
              "CHECKED",
              "LATENCY",
              "MODELS",
              "DIAGNOSTICS",
              "TRAFFIC",
              "LAST ERROR",
            ],
            records.map((record) => {
              const latest = record.latest;
              const effective = effectiveHealth(record);
              return [
                record.providerId,
                effective?.status ?? "NO_PROBE",
                effective?.checkedAt ?? "-",
                latest === undefined ? "-" : `${latest.health.latencyMs} ms`,
                latest === undefined ? "-" : String(latest.models.length),
                String(record.diagnostics.length),
                String(record.runtimeSignals.length),
                effective?.errorType ??
                  latestDiagnosticError(record.diagnostics) ??
                  "-",
              ];
            }),
          ),
        );
      }
      return 0;
    }
    case "show": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      const providerId = requireSinglePositional(
        positionals,
        "health show <provider-id> [--json]",
      );
      const record = await application.getProviderHealth(providerId);
      io.stdout(
        values.json
          ? JSON.stringify(record, null, 2)
          : renderHealthRecord(record),
      );
      return 0;
    }
    case "history": {
      const { values, positionals } = parseArgs({
        args: [...rest],
        options: { json: { type: "boolean", default: false } },
        allowPositionals: true,
        strict: true,
      });
      const providerId = requireSinglePositional(
        positionals,
        "health history <provider-id> [--json]",
      );
      const record = await application.getProviderHealth(providerId);
      if (values.json) io.stdout(JSON.stringify(record.history, null, 2));
      else if (record.history.length === 0) {
        io.stdout(`No persisted probe history for provider '${providerId}'.`);
      }
      else {
        io.stdout(
          renderTable(
            ["CHECKED", "STATUS", "LATENCY", "DISCOVERED", "ERROR"],
            record.history.map((snapshot) => [
              snapshot.checkedAt,
              snapshot.status,
              `${snapshot.latencyMs} ms`,
              String(snapshot.discoveredModelCount),
              snapshot.errorType ?? "-",
            ]),
          ),
        );
      }
      return 0;
    }
    default:
      throw new CliUsageError("Expected health subcommand: list, show, or history.");
  }
}

async function executeDoctor(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
): Promise<number> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      model: { type: "string" },
      level: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: true,
    strict: true,
  });
  const id = requireSinglePositional(
    positionals,
    "doctor <provider-id> [--model MODEL] [--level 0|1|2|3] [--json]",
  );
  const level = parseDoctorLevel(values.level ?? "1");
  const report = await application.diagnoseProvider(id, {
    level,
    ...(typeof values.model === "string" ? { modelId: values.model } : {}),
  });
  io.stdout(values.json ? JSON.stringify(report, null, 2) : renderDoctorReport(report));
  return report.verdict === "FAIL" ? 2 : 0;
}

function parseDoctorLevel(value: string | boolean | string[]): DoctorLevel {
  if (typeof value !== "string" || !/^[0-3]$/.test(value)) {
    throw new CliUsageError("--level must be 0, 1, 2, or 3.");
  }
  return Number(value) as DoctorLevel;
}

function renderDoctorReport(report: DoctorReport): string {
  const header = [
    `Provider: ${report.providerId}`,
    ...(report.modelId === undefined ? [] : [`Model: ${report.modelId}`]),
    ...(report.protocol === undefined ? [] : [`Protocol: ${report.protocol}`]),
    `Level: ${report.level}`,
  ];
  const table = renderTable(
    ["CHECK", "STATUS", "LATENCY", "DETAILS"],
    report.checks.map((check) => [
      check.name,
      check.status,
      check.latencyMs === undefined ? "-" : `${check.latencyMs} ms`,
      check.details ?? "",
    ]),
  );
  return `${header.join("\n")}\n\n${table}\n\nVerdict: ${report.verdict}`;
}

function parseAuth(values: Record<string, string | boolean | string[] | undefined>): ProviderAuth {
  const kind = parseEnum(
    typeof values["auth-kind"] === "string" ? values["auth-kind"] : "none",
    ["none", "bearer", "header", "query"] as const,
    "--auth-kind",
  );
  const secretRef = typeof values["secret-ref"] === "string" ? values["secret-ref"] : undefined;
  const authName = typeof values["auth-name"] === "string" ? values["auth-name"] : undefined;

  if (kind === "none") {
    if (secretRef || authName) {
      throw new CliUsageError("--secret-ref and --auth-name require a non-none --auth-kind.");
    }
    return { kind: "none" };
  }

  const requiredSecretRef = requireString(secretRef, "--secret-ref");
  if (kind === "bearer") {
    if (authName) throw new CliUsageError("--auth-name is not used with bearer authentication.");
    return { kind, secretRef: requiredSecretRef };
  }

  const requiredName = requireString(authName, "--auth-name");
  return kind === "header"
    ? { kind, headerName: requiredName, secretRef: requiredSecretRef }
    : { kind, parameterName: requiredName, secretRef: requiredSecretRef };
}

function parseAssignments(
  assignments: string | readonly string[] | undefined,
  optionName: string,
): Readonly<Record<string, string>> {
  if (!assignments) return {};
  const values = typeof assignments === "string" ? [assignments] : assignments;
  const result: Record<string, string> = {};

  for (const assignment of values) {
    const separator = assignment.indexOf("=");
    if (separator <= 0) {
      throw new CliUsageError(`${optionName} expects NAME=VALUE.`);
    }
    result[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  return result;
}

function parseEnum<const T extends readonly string[]>(
  value: string | boolean | string[],
  allowed: T,
  optionName: string,
): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new CliUsageError(`${optionName} must be one of: ${allowed.join(", ")}.`);
  }
  return value;
}

function parseProviderAdapterOption(
  value: string | boolean | string[],
): string {
  if (typeof value !== "string") {
    throw new CliUsageError(
      `--adapter must be one of: ${providerAdapterIds.join(", ")}, or plugin:PLUGIN_ID/ADAPTER_ID.`,
    );
  }
  try {
    return parseProviderAdapterId(value);
  } catch {
    throw new CliUsageError(
      `--adapter must be one of: ${providerAdapterIds.join(", ")}, or plugin:PLUGIN_ID/ADAPTER_ID.`,
    );
  }
}

function parseInteger(value: string | boolean | string[], optionName: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CliUsageError(`${optionName} must be an integer.`);
  }
  return Number(value);
}

function parseModelPricing(
  entries: readonly string[],
): Readonly<Record<string, ModelTokenPricing>> {
  const result: Record<string, ModelTokenPricing> = {};
  for (const entry of entries) {
    const separator = entry.indexOf("=");
    if (separator <= 0 || separator === entry.length - 1) {
      throw new CliUsageError(
        "--pricing expects MODEL=INPUT,OUTPUT[,CACHE_READ[,CACHE_WRITE[,WEB_SEARCH]]][@CURRENCY].",
      );
    }
    const modelId = entry.slice(0, separator);
    if (result[modelId] !== undefined) {
      throw new CliUsageError(`Duplicate --pricing entry for model '${modelId}'.`);
    }
    let ratesText = entry.slice(separator + 1);
    let currency = "USD";
    const currencySeparator = ratesText.lastIndexOf("@");
    if (currencySeparator >= 0) {
      currency = ratesText.slice(currencySeparator + 1);
      ratesText = ratesText.slice(0, currencySeparator);
      if (!/^[A-Z]{3}$/.test(currency)) {
        throw new CliUsageError(
          "--pricing currency must be a three-letter uppercase code.",
        );
      }
    }
    const rates = ratesText.split(",");
    if (rates.length < 2 || rates.length > 5) {
      throw new CliUsageError(
        "--pricing requires INPUT and OUTPUT rates, with optional CACHE_READ, CACHE_WRITE, and WEB_SEARCH rates.",
      );
    }
    const [input, output, cacheRead, cacheWrite, webSearch] = rates.map(
      (rate, index) =>
        parseNonNegativeNumber(
          rate ?? "",
          `--pricing rate ${index + 1} for '${modelId}'`,
        ),
    );
    result[modelId] = {
      currency,
      inputPerMillion: input as number,
      outputPerMillion: output as number,
      ...(cacheRead === undefined
        ? {}
        : { cacheReadInputPerMillion: cacheRead }),
      ...(cacheWrite === undefined
        ? {}
        : { cacheWriteInputPerMillion: cacheWrite }),
      ...(webSearch === undefined
        ? {}
        : { webSearchPerThousand: webSearch }),
    };
  }
  return result;
}

function parseNonNegativeNumber(value: string, optionName: string): number {
  if (value.trim() === "") {
    throw new CliUsageError(`${optionName} must be a non-negative number.`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new CliUsageError(`${optionName} must be a non-negative number.`);
  }
  return parsed;
}

function parseIsoTimestamp(value: string, optionName: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) {
    throw new CliUsageError(`${optionName} must be an ISO date/time.`);
  }
  return new Date(timestamp).toISOString();
}

async function readPromptInstructions(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(
      `Unable to read --instructions-file '${filePath}': ${details}`,
    );
  }
}

function parseLogicalModelRoute(value: string, enabled: boolean): LogicalModelRoute {
  const providerSeparator = value.indexOf("=");
  if (providerSeparator <= 0 || providerSeparator === value.length - 1) {
    throw new CliUsageError(
      "--route expects PROVIDER=MODEL[@PRIORITY], for example primary=gpt-x@100.",
    );
  }

  const providerId = value.slice(0, providerSeparator);
  let modelId = value.slice(providerSeparator + 1);
  let priority = 0;
  const prioritySeparator = modelId.lastIndexOf("@");
  if (prioritySeparator > 0) {
    const priorityText = modelId.slice(prioritySeparator + 1);
    if (/^-?\d+$/.test(priorityText)) {
      priority = Number(priorityText);
      if (!Number.isSafeInteger(priority)) {
        throw new CliUsageError("Route priority must be a safe integer.");
      }
      modelId = modelId.slice(0, prioritySeparator);
    }
  }

  return { providerId, modelId, priority, enabled };
}

function requireString(value: string | boolean | string[] | undefined, optionName: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliUsageError(`${optionName} is required.`);
  }
  return value;
}

function assertNoPositionals(positionals: readonly string[]): void {
  if (positionals.length > 0) {
    throw new CliUsageError(`Unexpected argument '${positionals[0]}'.`);
  }
}

function requireSinglePositional(positionals: readonly string[], usage: string): string {
  if (positionals.length !== 1) throw new CliUsageError(`Usage: providerdock ${usage}`);
  return positionals[0] as string;
}

function renderProviderTable(profiles: readonly ProviderProfile[]): string {
  return renderTable(
    ["ID", "NAME", "ADAPTER", "API", "ENABLED", "BASE URL"],
    profiles.map((profile) => [
      profile.id,
      profile.displayName,
      profile.adapterId,
      profile.apiType,
      profile.enabled ? "yes" : "no",
      profile.baseUrl,
    ]),
  );
}

function renderProviderPluginTable(
  plugins: readonly ProviderPluginDescriptor[],
): string {
  return renderTable(
    ["ID", "NAME", "VERSION", "ADAPTERS", "MODULE"],
    plugins.map((plugin) => [
      plugin.id,
      plugin.name,
      plugin.version,
      plugin.adapterIds.join(", "),
      plugin.modulePath,
    ]),
  );
}

function renderLogicalModelTable(logicalModels: readonly LogicalModelGroup[]): string {
  return renderTable(
    ["LOGICAL MODEL", "ROUTES (HIGH TO LOW PRIORITY)"],
    logicalModels.map((logicalModel) => [
      logicalModel.id,
      [...logicalModel.routes]
        .sort(
          (left, right) =>
            right.priority - left.priority ||
            left.providerId.localeCompare(right.providerId) ||
            left.modelId.localeCompare(right.modelId),
        )
        .map(
          (route) =>
            `${route.providerId}=${route.modelId}@${route.priority}${
              route.enabled ? "" : " (disabled)"
            }`,
        )
        .join(", "),
    ]),
  );
}

function renderPromptProfileTable(profiles: readonly PromptProfile[]): string {
  return renderTable(
    ["PROFILE", "CLIENT", "PROVIDER", "LOGICAL MODEL", "FALLBACK", "REASONING"],
    profiles.map((profile) => [
      `${profile.id} (${profile.name})`,
      profile.preferredClient,
      profile.preferredProviderId ?? "-",
      profile.preferredLogicalModelId ?? "-",
      profile.fallbackPolicy,
      profile.reasoningLevel ?? "-",
    ]),
  );
}

function renderProbe(result: ProviderProbeResult): string {
  const summary = [
    `Provider: ${result.health.providerId}`,
    `Status: ${result.health.status}`,
    `Latency: ${result.health.latencyMs} ms`,
    `Checked: ${result.health.checkedAt}`,
  ];
  if (result.health.errorType) {
    const guidance = providerErrorGuidance(result.health.errorType);
    summary.push(
      `Error: ${result.health.errorType}`,
      `Explanation: ${guidance.explanation}`,
      `Suggested action: ${guidance.suggestedAction}`,
    );
  }
  if (result.health.errorMessage) summary.push(`Details: ${result.health.errorMessage}`);
  if (result.health.appliedFixes.length > 0) {
    summary.push(`Fixes: ${result.health.appliedFixes.join(", ")}`);
  }

  if (result.models.length === 0) return `${summary.join("\n")}\nModels: none`;
  return `${summary.join("\n")}\n\n${renderTable(
    ["MODEL", "SOURCE", "HEALTH", "CODEX", "CLAUDE"],
    result.models.map((model) => [
      model.modelId,
      model.source,
      model.healthStatus,
      model.codexCompatibility,
      model.claudeCompatibility,
    ]),
  )}`;
}

function renderHealthRecord(record: ProviderHealthRecord): string {
  const probe =
    record.latest === undefined
      ? `Provider: ${record.providerId}\nProbe: no persisted probe snapshot.`
      : renderProbe(record.latest);
  const diagnostics =
    record.diagnostics.length === 0
      ? "Capability diagnostics: none"
      : `Capability diagnostics:\n${renderCapabilityMatrix(record.diagnostics)}`;
  const traffic =
    record.runtimeSignals.length === 0
      ? "Managed traffic: none"
      : `Managed traffic (latest ${Math.min(20, record.runtimeSignals.length)}):\n${renderRuntimeSignals(record)}`;
  return `${probe}\n\n${diagnostics}\n\n${traffic}`;
}

function effectiveHealth(record: ProviderHealthRecord): {
  readonly status: string;
  readonly checkedAt: string;
  readonly errorType?: string;
} | undefined {
  const runtime = latestRuntimeSignal(record);
  const probe = record.latest?.health;
  if (runtime !== undefined && (probe === undefined || runtime.observedAt >= probe.checkedAt)) {
    return {
      status: runtime.healthStatus,
      checkedAt: runtime.observedAt,
      ...(runtime.errorType === undefined ? {} : { errorType: runtime.errorType }),
    };
  }
  return probe;
}

function latestRuntimeSignal(
  record: ProviderHealthRecord,
): ProviderHealthRecord["runtimeSignals"][number] | undefined {
  return record.runtimeSignals.reduce<
    ProviderHealthRecord["runtimeSignals"][number] | undefined
  >(
    (latest, signal) =>
      latest === undefined || signal.observedAt > latest.observedAt
        ? signal
        : latest,
    undefined,
  );
}

function renderRuntimeSignals(record: ProviderHealthRecord): string {
  return renderTable(
    ["OBSERVED", "MODEL", "CLIENT", "OUTCOME", "STATUS", "ERROR", "SESSION"],
    record.runtimeSignals.slice(-20).reverse().map((signal) => [
      signal.observedAt,
      signal.modelId,
      signal.client,
      signal.outcome,
      signal.healthStatus,
      signal.errorType ?? "-",
      signal.sessionId?.slice(0, 12) ?? "-",
    ]),
  );
}

function renderCapabilityMatrix(
  diagnostics: readonly ModelCapabilitySnapshot[],
): string {
  return renderTable(
    [
      "MODEL",
      "CHECKED",
      "LEVEL",
      "VERDICT",
      "PROTOCOL",
      "TEXT",
      "STREAM",
      "TOOLS",
      "DISCOVERY",
      "CODEX",
      "CLAUDE",
      "LAST ERROR",
    ],
    diagnostics.map((snapshot) => [
      snapshot.modelId,
      snapshot.checkedAt,
      String(snapshot.doctorLevel),
      snapshot.verdict,
      snapshot.protocol ?? "-",
      snapshot.capabilities.text,
      snapshot.capabilities.streaming,
      snapshot.capabilities.tools,
      snapshot.capabilities.model_discovery,
      snapshot.codexCompatibility,
      snapshot.claudeCompatibility,
      snapshot.lastErrorType ?? "-",
    ]),
  );
}

function renderUsageSummary(rows: readonly UsageSummaryRow[]): string {
  return renderTable(
    [
      "PROVIDER",
      "MODEL",
      "CLIENT",
      "REQUESTS",
      "COMPLETE",
      "INCOMPLETE",
      "INPUT",
      "CACHE R",
      "CACHE W",
      "OUTPUT",
      "TOTAL",
      "COST",
    ],
    rows.map((row) => [
      row.providerId,
      row.modelId,
      row.client,
      String(row.requestCount),
      String(row.completedCount),
      String(row.incompleteCount),
      String(row.uncachedInputTokens),
      String(row.cacheReadInputTokens),
      String(row.cacheWriteInputTokens),
      String(row.outputTokens),
      String(row.totalTokens),
      Object.entries(row.costs).length === 0
        ? "-"
        : Object.entries(row.costs)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([currency, microunits]) =>
              formatMicrounits(currency, microunits),
            )
            .join(", "),
    ]),
  );
}

function formatMicrounits(currency: string, microunits: number): string {
  const whole = Math.floor(microunits / 1_000_000);
  const fractional = String(microunits % 1_000_000).padStart(6, "0");
  return `${currency} ${whole}.${fractional}`;
}

function latestDiagnosticError(
  diagnostics: readonly ModelCapabilitySnapshot[],
): string | undefined {
  return [...diagnostics]
    .sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))
    .find((snapshot) => snapshot.lastErrorType !== undefined)?.lastErrorType;
}

function formatImportCounts(
  label: string,
  counts: { readonly created: number; readonly updated: number },
): string {
  return `${label} ${counts.created} created/${counts.updated} updated`;
}

function renderTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const renderRow = (row: readonly string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column] ?? cell.length)).join("  ").trimEnd();
  return [renderRow(headers), renderRow(widths.map((width) => "-".repeat(width))), ...rows.map(renderRow)].join("\n");
}

function formatZodIssue(issue: z.ZodIssue): string {
  return `- ${issue.path.join(".") || "profile"}: ${issue.message}`;
}

function isParseArgsError(error: unknown): error is TypeError & { readonly code: string } {
  return (
    error instanceof TypeError &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("ERR_PARSE_ARGS_")
  );
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

const helpText = `ProviderDock management CLI

Usage:
  providerdock providers list [--json]
  providerdock providers show <provider-id>
  providerdock providers set --id ID --name NAME --base-url URL [options]
  providerdock providers remove <provider-id>
  providerdock plugins list [--json]
  providerdock logical-models list [--json]
  providerdock logical-models show <logical-model-id>
  providerdock logical-models set --id ID --route PROVIDER=MODEL@PRIORITY [--route ...]
  providerdock logical-models remove <logical-model-id>
  providerdock prompt-profiles list [--json]
  providerdock prompt-profiles show <prompt-profile-id>
  providerdock prompt-profiles set --id ID --name NAME --instructions-file FILE [options]
  providerdock prompt-profiles remove <prompt-profile-id>
  providerdock project-profiles list [--json]
  providerdock project-profiles show --project DIRECTORY
  providerdock project-profiles set --project DIRECTORY --prompt-profile ID
  providerdock project-profiles remove --project DIRECTORY
  providerdock profiles export --file FILE [--force]
  providerdock profiles import --file FILE [--overwrite]
  providerdock probe <provider-id> [--json]
  providerdock health list [--json]
  providerdock health show <provider-id> [--json]
  providerdock health history <provider-id> [--json]
  providerdock doctor <provider-id> [--model MODEL] [--level 0|1|2|3] [--json]
  providerdock usage list [--provider ID] [--model MODEL] [--client codex|claude-code] [--since ISO] [--until ISO] [--json]
  providerdock usage summary [--provider ID] [--model MODEL] [--client codex|claude-code] [--since ISO] [--until ISO] [--json]
  providerdock dashboard [--port PORT] [--open]
  providerdock secrets list
  providerdock secrets set <reference> --from-env VARIABLE
  providerdock secrets remove <reference>
  providerdock launch codex --provider ID --model MODEL --project DIRECTORY [--bridge-url URL] [--approval LEVEL]
  providerdock launch codex --logical-model ID --project DIRECTORY [--approval LEVEL]
  providerdock launch codex --prompt-profile ID --project DIRECTORY [--approval LEVEL]
  providerdock launch claude --provider ID --model MODEL --project DIRECTORY [--approval LEVEL]
  providerdock launch claude --logical-model ID --project DIRECTORY [--approval LEVEL]
  providerdock launch claude --prompt-profile ID --project DIRECTORY [--approval LEVEL]
  providerdock launch auto --provider ID --model MODEL --project DIRECTORY [--approval LEVEL]
  providerdock launch auto --logical-model ID --project DIRECTORY [--approval LEVEL]
  providerdock launch auto --prompt-profile ID --project DIRECTORY [--approval LEVEL]
  providerdock launch auto --project DIRECTORY [--approval LEVEL]
  providerdock recover codex [--json]

Doctor levels (run manually; deeper levels send real inference requests):
  0  metadata and model discovery only
  1  plus one minimal inference request (default)
  2  plus a streaming check
  3  plus a synthetic side-effect-free tool round-trip

Launch approval levels (--approval):
  ask        confirm actions before changes (default)
  auto       automatic edits inside the project directory only
  full-auto  no approval prompts and no sandbox (dangerous)

Codex launch routing:
  Without --bridge-url, ProviderDock selects direct or managed compatibility bridge mode.
  --bridge-url selects an externally managed compatibility bridge and never stops it.
  --logical-model always uses the managed bridge and applies configured safe fallback.
  With no route selector, the exact project-directory profile is used.

Claude launch routing:
  Claude Code always runs against a managed loopback Anthropic Messages bridge.
  --logical-model applies route-specific protocol translation and safe fallback.
  With no route selector, the exact project-directory profile is used.
  ANTHROPIC_* variables are set only inside the child process environment.

Automatic client selection:
  Explicit prompt/provider preferredClient wins.
  Otherwise the latest exact provider/model Doctor compatibility is preferred.
  Without a measurement, Anthropic Messages selects Claude Code; Responses/Chat selects Codex.
  With only --project, the exact project profile supplies the prompt and route.

Authentication options for providers set:
  --auth-kind none|bearer|header|query
  --secret-ref ENVIRONMENT_VARIABLE
  --auth-name HEADER_OR_QUERY_NAME
  --adapter auto|generic-openai|generic-anthropic|agentrouter|gorouter|custom
            or plugin:PLUGIN_ID/ADAPTER_ID

Provider plugins:
  PROVIDER_DOCK_PLUGINS is a path-delimiter-separated list of explicit local module paths.
  Relative paths must start with ./ or ../. Directories are never scanned automatically.
  Plugin modules are trusted local JavaScript and execute with the same process privileges.

Additional repeatable options:
  --manual-model MODEL_ID
  --pricing MODEL=INPUT,OUTPUT[,CACHE_READ[,CACHE_WRITE[,WEB_SEARCH]]][@CURRENCY]
  --header NAME=VALUE                  (non-secret values only)
  --secret-header NAME=ENVIRONMENT_VARIABLE
  --query NAME=VALUE

Logical-model routes:
  --route PROVIDER=MODEL[@PRIORITY]
  --disabled-route PROVIDER=MODEL[@PRIORITY]
  Higher priorities are attempted first; ties use provider/model lexical order.

Prompt-profile options:
  --provider ID
  --preferred-model MODEL
  --logical-model ID
  --client auto|codex|claude-code
  --reasoning LEVEL
  --fallback disabled|logical-model
  --codex-flag=ARG                    repeatable
  --claude-flag=ARG                   repeatable
  Instructions are read from a file so multiline prompts are not flattened by the shell.
  Profile launch injects instructions through the managed bridge instead of project files.

Profile bundles:
  Export contains provider, logical-model, prompt, and project profiles.
  Secret references are exported; secret values and health/diagnostic data are never exported.
  Import validates all references before writing and rejects collisions unless --overwrite is set.

Usage dashboard:
  Managed bridges record normalized terminal usage without prompts or response content.
  Cost is calculated only when the exact provider/model has explicit --pricing metadata.
  Direct Codex routes bypass the bridge and are not observable by ProviderDock.

Web dashboard:
  Binds only to 127.0.0.1 and uses an unguessable per-process URL path.
  Provides provider/model health, provider CRUD, manual probes, and managed client launch.
  The URL contains a session token; keep it private and press Ctrl+C to stop the server.

Actual secret values are never accepted as provider profile fields.`;
