import { parseArgs } from "node:util";
import { z } from "zod";
import type { ProviderDockApplication } from "../application/provider-dock-application.js";
import { ProviderNotFoundError } from "../application/provider-dock-application.js";
import {
  preferredClients,
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
    return await execute(argv, options.application, io);
  } catch (error) {
    if (error instanceof CliUsageError || error instanceof ProviderNotFoundError) {
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
): Promise<number> {
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.stdout(helpText);
    return 0;
  }

  if (command === "providers") return executeProviders(rest, application, io);
  if (command === "probe") return executeProbe(rest, application, io);

  throw new CliUsageError(`Unknown command '${command}'. Run 'providerdock help'.`);
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
    ["ID", "NAME", "API", "ENABLED", "BASE URL"],
    profiles.map((profile) => [
      profile.id,
      profile.displayName,
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

Authentication options for providers set:
  --auth-kind none|bearer|header|query
  --secret-ref ENVIRONMENT_VARIABLE
  --auth-name HEADER_OR_QUERY_NAME

Additional repeatable options:
  --manual-model MODEL_ID
  --header NAME=VALUE                  (non-secret values only)
  --secret-header NAME=ENVIRONMENT_VARIABLE
  --query NAME=VALUE

Actual secret values are never accepted as provider profile fields.`;
