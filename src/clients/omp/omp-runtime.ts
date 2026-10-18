import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { SecretStore } from "../../core/security/secret-store.js";
import { providerSecretRevisionFingerprint } from "../../core/security/secret-revision.js";
import { createOperationDiagnostic, type OperationDiagnostic, type OperationStage } from "../../core/errors/operation-diagnostic.js";
import {
  compileOmpConfig, ompConfigSchemaCommit, OmpConfigError,
  type OmpProtocolMapping, type OmpSelectedRoute, type OmpApi,
} from "./omp-config-compiler.js";
import { OmpCredentialError, resolveOmpChildEnvironment } from "./omp-credentials.js";
import { createOmpRuntimePaths } from "./omp-runtime-paths.js";

export interface OmpArtifact {
  readonly executable: string;
  readonly sha256: string;
  readonly sourceCommit: string;
}

export interface OmpRuntimeOptions {
  readonly rootDirectory: string;
  readonly artifact: OmpArtifact;
  readonly secretStore: SecretStore;
  /** Current profile identity; required when an accepted pilot selection pins it. */
  readonly currentProfileFingerprint?: (providerId: string) => Promise<string | undefined>;
  readonly ambientEnvironment?: Readonly<NodeJS.ProcessEnv>;
}

export interface OmpRuntimeSelection {
  readonly route: OmpSelectedRoute;
  readonly protocolMappings?: readonly OmpProtocolMapping[];
  readonly projectDirectory: string;
  readonly mode: "tui" | "rpc";
  readonly permissionAcknowledgement?: "read-only-pilot-no-sandbox" | undefined;
  readonly expectedCredentialFingerprint?: string | undefined;
  readonly expectedProfileSha256?: string | undefined;
}

export type OmpPreflightResult =
  | { readonly ok: true; readonly providerId: string; readonly accountId: string; readonly modelId: string; readonly api: OmpApi }
  | { readonly ok: false; readonly diagnostic: OperationDiagnostic };

/** Contains ephemeral credentials; never serialize this object or return it through HTTP. */
export interface PreparedOmpRuntime {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly homeDirectory: string;
  readonly agentDirectory: string;
  readonly sessionsDirectory: string;
  /** Non-secret route identity exactly as pinned OMP reports it in RPC control frames. */
  readonly rpcModel: { readonly providerId: string; readonly modelId: string };
}

export class OmpRuntimeError extends Error {
  constructor(readonly diagnostic: OperationDiagnostic) {
    super(diagnostic.message);
    this.name = "OmpRuntimeError";
  }
}
function failure(code: string, stage: OperationStage = "validation"): OmpRuntimeError {
  return new OmpRuntimeError(createOperationDiagnostic({ code, stage }));
}

function classify(error: unknown): OmpRuntimeError {
  if (error instanceof OmpRuntimeError) return error;
  if (error instanceof OmpCredentialError) return failure(error.code, "credentials");
  if (error instanceof OmpConfigError) {
    return failure(
      error.code === "PROTOCOL_UNRESOLVED" || error.code === "MODEL_DISABLED"
        ? error.code : "OMP_CONFIG_INVALID",
    );
  }
  return failure("OMP_CONFIG_INVALID");
}

/** These are discovery adapters, not the user-selected inference providers. */
export const ompDisabledDiscoveryProviders = [
  "native", "agents", "agents-md", "agent-plugins", "claude", "claude-plugins",
  "codex", "cline", "cursor", "gemini", "github", "mcp-json", "omp-plugins",
  "opencode", "ssh-json", "vscode", "windsurf", "ollama", "llama.cpp", "lm-studio",
] as const;

/** Read-only pilot, NOT an OS or network sandbox. No automatic retry/fallback. */
export function createOmpPilotPolicy(): Record<string, unknown> {
  return {
    disabledProviders: [...ompDisabledDiscoveryProviders],
    tools: {
      approvalMode: "always-ask",
      approval: { task: "deny", eval: "deny", browser: "deny", computer: "deny" },
    },
    fetch: { enabled: false },
    retry: { enabled: false }, mcp: { enableProjectConfig: false },
    // Exact pinned settings keys. "update.checkOnStartup" is NOT recognized.
    startup: { setupWizard: false, checkUpdate: false, showSplash: false },
    git: { enabled: false }, recap: { enabled: false },
  };
}

function validAbsolutePath(path: string): boolean {
  return typeof path === "string" && isAbsolute(path) && !/[\x00-\x1f\x7f]/.test(path) &&
    !path.split(/[\\/]/).some(part => part === "." || part === "..");
}

/**
 * Reject existing links/junctions in every ancestor. This is defense in depth
 * for a trusted same-user directory, not protection against a malicious local
 * actor replacing ancestors between checks (no OS sandbox is claimed).
 */
async function inspectPath(path: string, allowMissing: boolean): Promise<void> {
  if (!validAbsolutePath(path)) throw new Error("Invalid path.");
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
    cursor = join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error("Linked path.");
      if (cursor !== absolute && !info.isDirectory()) throw new Error("Non-directory ancestor.");
    } catch (error) {
      if (allowMissing && nodeCode(error) === "ENOENT") return;
      throw error;
    }
  }
}
function nodeCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}

async function ensureDirectory(path: string): Promise<void> {
  await inspectPath(path, true);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await inspectPath(path, false);
  if (!(await lstat(path)).isDirectory()) throw new Error("Not a directory.");
}

async function inspectDirectory(path: string): Promise<void> {
  await inspectPath(path, true);
  try {
    if (!(await lstat(path)).isDirectory()) throw new Error("Not a directory.");
  } catch (error) {
    if (nodeCode(error) !== "ENOENT") throw error;
  }
}

/**
 * The pin loads project settings BEFORE applying disabledProviders. Its overlay
 * deep-merges approvals; it may also quarantine malformed native YAML on start.
 * `env.ts` also parses `.env`, `.env.local`, `.env.${NODE_ENV}`, and
 * `.env.${NODE_ENV}.local` from cwd. Since NODE_ENV is runtime-controlled,
 * reject the exact top-level `.env` / `.env.<nonempty>` grammar rather than
 * pretending a finite list of modes covers it. Check presence without parsing,
 * reading, or renaming. All registered settings providers use cwd-local paths
 * at the pin.
 */
async function rejectUnreviewedProjectSettings(projectDirectory: string): Promise<void> {
  let dotenvInputs: string[];
  try {
    dotenvInputs = (await readdir(projectDirectory)).filter((name) =>
      name === ".env" || /^\.env\..+$/.test(name));
  } catch {
    throw failure("OMP_PROJECT_SETTINGS_UNREVIEWED");
  }
  const inputs = [
    ".omp/config.yml", ".omp/settings.json",
    ...dotenvInputs,
    ".claude/settings.json", ".claude/settings.local.json", ".codex/config.toml",
    ".cursor/settings.json", ".gemini/settings.json",
    "opencode.json", "opencode.jsonc", ".opencode/opencode.json", ".opencode/opencode.jsonc",
  ];
  for (const input of inputs) {
    const path = join(projectDirectory, input);
    try {
      await inspectPath(path, true);
      await lstat(path);
    } catch (error) {
      if (nodeCode(error) === "ENOENT") continue;
      throw failure("OMP_PROJECT_SETTINGS_UNREVIEWED");
    }
    throw failure("OMP_PROJECT_SETTINGS_UNREVIEWED");
  }
}

async function writeNewConfig(path: string, content: string): Promise<void> {
  const file = await open(path, "wx", 0o600);
  try {
    await file.writeFile(content, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

export class OmpRuntime {
  private readonly options: OmpRuntimeOptions;

  constructor(options: OmpRuntimeOptions) {
    this.options = {
      ...options, artifact: { ...options.artifact },
      ambientEnvironment: { ...options.ambientEnvironment },
    };
  }

  async preflight(selection: OmpRuntimeSelection): Promise<OmpPreflightResult> {
    try {
      const checked = await this.check(structuredClone(selection));
      await this.assertProfileCurrent(selection);
      await this.assertCredentialGeneration(selection);
      // Deliberately discard the ephemeral environment. This method may be exposed
      // to the dashboard; it never returns credentials or executes the artifact.
      await resolveOmpChildEnvironment(
        checked.compiled.requiredSecrets, this.options.secretStore, this.options.ambientEnvironment,
      );
      await this.assertCredentialGeneration(selection);
      await this.assertProfileCurrent(selection);
      const model = checked.compiled.selections[0]!;
      return { ok: true, providerId: model.providerId, accountId: model.accountId, modelId: model.modelId, api: model.api };
    } catch (error) {
      return { ok: false, diagnostic: classify(error).diagnostic };
    }
  }

  async prepare(runId: string, selection: OmpRuntimeSelection): Promise<PreparedOmpRuntime> {
    try {
      if (!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(runId)) {
        throw failure("OMP_CONFIG_INVALID");
      }
      const selected = structuredClone(selection);
      const checked = await this.check(selected);
      await this.assertProfileCurrent(selected);
      await this.assertCredentialGeneration(selected);
      const environment = await resolveOmpChildEnvironment(
        checked.compiled.requiredSecrets, this.options.secretStore, this.options.ambientEnvironment,
      );
      await this.assertCredentialGeneration(selected);
      await this.assertProfileCurrent(selected);
      const homeDirectory = join(checked.paths.scopeDirectory, "runs", runId);
      const agentDirectory = join(homeDirectory, "agent");
      const configPath = join(agentDirectory, "config.yml");
      try {
        await ensureDirectory(dirname(homeDirectory));
        // Fresh per-run homes prevent rewriting another running process's config.
        await mkdir(homeDirectory, { mode: 0o700 });
        await ensureDirectory(agentDirectory);
        await ensureDirectory(checked.paths.sessionsDirectory);
        for (const folder of ["config", "xdg-data/omp", "xdg-cache/omp", "xdg-state/omp", "appdata", "localappdata"]) {
          await ensureDirectory(join(homeDirectory, folder));
        }
        await writeNewConfig(join(agentDirectory, "models.yml"), checked.compiled.modelsYaml);
        await writeNewConfig(configPath, JSON.stringify(createOmpPilotPolicy(), null, 2) + "\n");
      } catch {
        // Preserve new artifacts for diagnosis. Never recurse-delete a shared home.
        throw failure("OMP_RUNTIME_DIRECTORY_UNAVAILABLE", "storage");
      }
      Object.assign(environment, {
        HOME: homeDirectory, USERPROFILE: homeDirectory, PI_CONFIG_DIR: "config",
        PI_CODING_AGENT_DIR: agentDirectory, PI_NATIVE_VARIANT: "baseline",
        XDG_DATA_HOME: join(homeDirectory, "xdg-data"), XDG_CACHE_HOME: join(homeDirectory, "xdg-cache"),
        XDG_STATE_HOME: join(homeDirectory, "xdg-state"), XDG_CONFIG_HOME: join(homeDirectory, "config"),
        APPDATA: join(homeDirectory, "appdata"), LOCALAPPDATA: join(homeDirectory, "localappdata"),
      });
      const args = [
        "--model", checked.compiled.selections[0]!.selector,
        "--config", configPath, "--session-dir", checked.paths.sessionsDirectory,
        "--tools", "read", "--no-lsp", "--no-extensions", "--no-skills", "--no-rules",
        "--no-title", "--approval-mode", "always-ask",
        ...(selected.mode === "rpc" ? ["--mode", "rpc"] : []),
      ];
      const model = checked.compiled.selections[0]!;
      await this.assertProfileCurrent(selected);
      return {
        executable: this.options.artifact.executable, args, cwd: selected.projectDirectory,
        environment, homeDirectory, agentDirectory, sessionsDirectory: checked.paths.sessionsDirectory,
        rpcModel: { providerId: model.ompProviderId, modelId: model.modelId },
      };
    } catch (error) {
      throw classify(error);
    }
  }

  private async check(selection: OmpRuntimeSelection) {
    if (selection.permissionAcknowledgement !== "read-only-pilot-no-sandbox") {
      throw failure("OMP_PERMISSION_CONFIRMATION_REQUIRED");
    }
    if (!["tui", "rpc"].includes(selection.mode) || selection.route.models.length !== 1) {
      throw failure("OMP_CONFIG_INVALID");
    }
    const compiled = compileOmpConfig({
      routes: [selection.route],
      ...(selection.protocolMappings ? { protocolMappings: selection.protocolMappings } : {}),
    });
    let paths;
    try {
      paths = createOmpRuntimePaths({
        rootDirectory: this.options.rootDirectory,
        providerId: selection.route.profile.id, accountId: selection.route.accountId,
      });
      for (const directory of [
        paths.scopeDirectory, join(paths.scopeDirectory, "runs"),
        paths.agentDirectory, paths.sessionsDirectory,
      ]) await inspectDirectory(directory);
    } catch {
      throw failure("OMP_RUNTIME_DIRECTORY_UNAVAILABLE", "storage");
    }
    try {
      await inspectPath(selection.projectDirectory, false);
      if (!(await lstat(selection.projectDirectory)).isDirectory()) throw new Error();
    } catch {
      throw failure("PROJECT_DIRECTORY_UNAVAILABLE");
    }
    await rejectUnreviewedProjectSettings(selection.projectDirectory);
    await this.verifyArtifact();
    return { compiled, paths };
  }

  private async assertCredentialGeneration(selection: OmpRuntimeSelection): Promise<void> {
    if (selection.expectedCredentialFingerprint === undefined) return;
    const current = await providerSecretRevisionFingerprint(selection.route.profile, this.options.secretStore);
    if (current !== selection.expectedCredentialFingerprint) throw failure("OMP_ROUTE_NOT_ACCEPTED");
  }

  private async assertProfileCurrent(selection: OmpRuntimeSelection): Promise<void> {
    if (selection.expectedProfileSha256 === undefined) return;
    let current: string | undefined;
    try { current = await this.options.currentProfileFingerprint?.(selection.route.profile.id); } catch { current = undefined; }
    if (current !== selection.expectedProfileSha256) throw failure("OMP_ROUTE_NOT_ACCEPTED");
  }

  private async verifyArtifact(): Promise<void> {
    const artifact = this.options.artifact;
    if (artifact.sourceCommit !== ompConfigSchemaCommit || !/^[a-f0-9]{64}$/.test(artifact.sha256)) {
      throw failure("OMP_ARTIFACT_MISMATCH");
    }
    try {
      await inspectPath(artifact.executable, false);
      const before = await lstat(artifact.executable);
      if (!before.isFile()) throw failure("EXECUTABLE_UNAVAILABLE");
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(artifact.executable)) hash.update(chunk as Buffer);
      const after = await lstat(artifact.executable);
      if (hash.digest("hex") !== artifact.sha256 || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
        throw failure("OMP_ARTIFACT_MISMATCH");
      }
    } catch (error) {
      if (error instanceof OmpRuntimeError) throw error;
      throw failure(nodeCode(error) === "ENOENT" ? "EXECUTABLE_NOT_FOUND" : "EXECUTABLE_UNAVAILABLE", "process-spawn");
    }
  }
}
