import { parseArgs } from "node:util";
import { z } from "zod";
import type { ProviderDockApplication } from "../application/provider-dock-application.js";
import {
  ProviderNotFoundError,
  SecretVaultUnavailableError,
} from "../application/provider-dock-application.js";
import { SecretProtectionError } from "../core/security/dpapi-secret-vault.js";
import { CodexRuntimeConfigurationError } from "../clients/codex/codex-runtime-config.js";
import {
  preferredClients,
  providerAdapterIds,
  providerApiTypes,
  type ProviderAuth,
  type ProviderProfile,
} from "../core/providers/provider-profile.js";
import type { ProviderProbeResult } from "../core/health/provider-probe-service.js";

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
      error instanceof ProviderNotFoundError ||
      error instanceof SecretVaultUnavailableError ||
      error instanceof SecretProtectionError ||
      error instanceof CodexRuntimeConfigurationError
    ) {
      io.stderr(`Error: ${error.message}`);
      return 1;
    }
    if (error instanceof z.ZodError) {
      io.stderr(`Error: invalid provider profile\n${error.issues.map(formatZodIssue).join("\n")}`);
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
  if (command === "probe") return executeProbe(rest, application, io);
  if (command === "secrets") return executeSecrets(rest, application, io, environment);
  if (command === "launch") return executeLaunch(rest, application, io, environment);
  if (command === "recover") return executeRecovery(rest, application, io);

  throw new CliUsageError(`Unknown command '${command}'. Run 'providerdock help'.`);
}

async function executeLaunch(
  argv: readonly string[],
  application: ProviderDockApplication,
  io: CliIo,
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  const [client, ...rest] = argv;
  if (client !== "codex") throw new CliUsageError("Usage: providerdock launch codex [options]");
  const { values, positionals } = parseArgs({
    args: [...rest],
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      project: { type: "string" },
      "bridge-url": { type: "string" },
      executable: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });
  assertNoPositionals(positionals);
  const bridgeUrl = values["bridge-url"];
  const exit = await application.launchCodex({
    providerId: requireString(values.provider, "--provider"),
    modelId: requireString(values.model, "--model"),
    projectDirectory: requireString(values.project, "--project"),
    route: bridgeUrl ? { kind: "bridge", baseUrl: bridgeUrl } : { kind: "auto" },
    ...(values.executable ? { executable: values.executable } : {}),
    parentEnvironment: environment,
  });
  const status = exit.exitCode === null ? `signal ${exit.signal ?? "unknown"}` : `exit code ${exit.exitCode}`;
  io.stdout(`Codex session finished with ${status}.`);
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
    adapterId: parseEnum(values.adapter ?? "auto", providerAdapterIds, "--adapter"),
    auth: parseAuth(values),
    enabled: !values.disabled,
    staticHeaders: parseAssignments(values.header, "--header"),
    secretHeaders: parseAssignments(values["secret-header"], "--secret-header"),
    queryParameters: parseAssignments(values.query, "--query"),
    modelsEndpoint: values["models-endpoint"] ?? "models",
    manualModelIds: values["manual-model"] ?? [],
    preferredClient: parseEnum(
      values["preferred-client"] ?? "auto",
      preferredClients,
      "--preferred-client",
    ),
    timeoutMs: parseInteger(values["timeout-ms"] ?? "10000", "--timeout-ms"),
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

function parseInteger(value: string | boolean | string[], optionName: string): number {
  if (typeof value !== "string" || !/^\d+$/.test(value)) {
    throw new CliUsageError(`${optionName} must be an integer.`);
  }
  return Number(value);
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

function renderProbe(result: ProviderProbeResult): string {
  const summary = [
    `Provider: ${result.health.providerId}`,
    `Status: ${result.health.status}`,
    `Latency: ${result.health.latencyMs} ms`,
    `Checked: ${result.health.checkedAt}`,
  ];
  if (result.health.errorType) summary.push(`Error: ${result.health.errorType}`);
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
  providerdock probe <provider-id> [--json]
  providerdock secrets list
  providerdock secrets set <reference> --from-env VARIABLE
  providerdock secrets remove <reference>
  providerdock launch codex --provider ID --model MODEL --project DIRECTORY [--bridge-url URL]
  providerdock recover codex [--json]

Codex launch routing:
  Without --bridge-url, ProviderDock selects direct or managed native Responses bridge mode.
  --bridge-url selects an externally managed compatibility bridge and never stops it.

Authentication options for providers set:
  --auth-kind none|bearer|header|query
  --secret-ref ENVIRONMENT_VARIABLE
  --auth-name HEADER_OR_QUERY_NAME
  --adapter auto|generic-openai|agentrouter|gorouter|custom

Additional repeatable options:
  --manual-model MODEL_ID
  --header NAME=VALUE                  (non-secret values only)
  --secret-header NAME=ENVIRONMENT_VARIABLE
  --query NAME=VALUE

Actual secret values are never accepted as provider profile fields.`;
