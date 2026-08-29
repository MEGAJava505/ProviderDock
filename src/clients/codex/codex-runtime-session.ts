import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import { z } from "zod";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import {
  CodexRuntimeConfigFactory,
  CodexRuntimeConfigurationError,
  type CodexProviderRoute,
} from "./codex-runtime-config.js";

const sessionIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const manifestSchema = z
  .object({
    version: z.literal(1),
    sessionId: sessionIdSchema,
    profileName: z.string().regex(/^providerdock-[a-f0-9]{32}$/),
    profileSha256: z.string().regex(/^[a-f0-9]{64}$/),
    projectDirectory: z.string().min(1),
    providerId: z.string().min(1),
    modelId: z.string().min(1),
    state: z.enum(["PREPARING", "READY", "ACTIVE"]),
    createdAt: z.string().datetime(),
    pid: z.number().int().positive().optional(),
  })
  .strict();

type CodexRuntimeManifest = z.infer<typeof manifestSchema>;

export interface PrepareCodexRuntimeInput {
  readonly profile: ProviderProfile;
  readonly modelId: string;
  readonly projectDirectory: string;
  readonly route: CodexProviderRoute;
}

export interface PreparedCodexRuntime {
  readonly sessionId: string;
  readonly profileName: string;
  readonly profilePath: string;
  readonly sessionDirectory: string;
  readonly manifestPath: string;
  readonly projectDirectory: string;
  readonly environment: Readonly<Record<string, string>>;
}

export type CodexRecoveryOutcome =
  | { readonly sessionId: string; readonly status: "RECOVERED" }
  | { readonly sessionId: string; readonly status: "ACTIVE"; readonly pid: number }
  | { readonly sessionId: string; readonly status: "CONFLICT"; readonly message: string }
  | { readonly sessionId: string; readonly status: "INVALID"; readonly message: string };

export interface CodexRuntimeSessionManagerOptions {
  readonly codexHome: string;
  readonly runtimeRoot: string;
  readonly secrets: SecretStore;
  readonly now?: () => Date;
  readonly randomId?: () => string;
  readonly isProcessAlive?: (pid: number) => boolean;
}

export class CodexRuntimeSessionManager {
  readonly codexHome: string;
  private readonly runtimeRoot: string;
  private readonly configFactory: CodexRuntimeConfigFactory;
  private readonly now: () => Date;
  private readonly randomId: () => string;
  private readonly isProcessAlive: (pid: number) => boolean;

  constructor(options: CodexRuntimeSessionManagerOptions) {
    this.codexHome = options.codexHome;
    this.runtimeRoot = options.runtimeRoot;
    this.configFactory = new CodexRuntimeConfigFactory(options.secrets);
    this.now = options.now ?? (() => new Date());
    this.randomId = options.randomId ?? (() => randomUUID().replaceAll("-", ""));
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  }

  async prepare(input: PrepareCodexRuntimeInput): Promise<PreparedCodexRuntime> {
    const projectStats = await stat(input.projectDirectory).catch(() => undefined);
    if (!projectStats?.isDirectory()) {
      throw new CodexRuntimeConfigurationError(
        `Project directory '${input.projectDirectory}' does not exist or is not a directory.`,
      );
    }

    const sessionId = sessionIdSchema.parse(this.randomId());
    const built = await this.configFactory.build({
      profile: input.profile,
      modelId: input.modelId,
      route: input.route,
      sessionId,
    });
    const profileSha256 = sha256(built.contents);
    const sessionDirectory = join(this.runtimeRoot, sessionId);
    const manifestPath = join(sessionDirectory, "manifest.json");
    const profilePath = join(this.codexHome, `${built.profileName}.config.toml`);
    const manifest: CodexRuntimeManifest = {
      version: 1,
      sessionId,
      profileName: built.profileName,
      profileSha256,
      projectDirectory: input.projectDirectory,
      providerId: input.profile.id,
      modelId: input.modelId,
      state: "PREPARING",
      createdAt: this.now().toISOString(),
    };

    await mkdir(this.runtimeRoot, { recursive: true });
    await mkdir(sessionDirectory, { recursive: false });
    await mkdir(this.codexHome, { recursive: true });
    await writeFile(manifestPath, serializeManifest(manifest), { encoding: "utf8", flag: "wx" });
    await writeFile(profilePath, built.contents, { encoding: "utf8", flag: "wx" });
    await this.writeManifest(manifestPath, { ...manifest, state: "READY" });

    return {
      sessionId,
      profileName: built.profileName,
      profilePath,
      sessionDirectory,
      manifestPath,
      projectDirectory: input.projectDirectory,
      environment: built.environment,
    };
  }

  async markActive(runtime: PreparedCodexRuntime, pid: number): Promise<void> {
    const manifest = await this.readPreparedManifest(runtime);
    if (manifest.state !== "READY") {
      throw new CodexRuntimeConfigurationError(
        `Codex runtime '${runtime.sessionId}' is not ready to become active.`,
      );
    }
    await this.writeManifest(runtime.manifestPath, { ...manifest, state: "ACTIVE", pid });
  }

  async cleanup(runtime: PreparedCodexRuntime): Promise<void> {
    const manifest = await this.readPreparedManifest(runtime);
    await this.removeProfileIfUnchanged(manifest);
    await this.removeSessionDirectory(runtime.sessionId);
  }

  async recoverStaleSessions(): Promise<readonly CodexRecoveryOutcome[]> {
    let directoryNames: string[];
    try {
      directoryNames = await readdir(this.runtimeRoot);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }

    const outcomes: CodexRecoveryOutcome[] = [];
    for (const sessionId of directoryNames.sort()) {
      if (!sessionIdSchema.safeParse(sessionId).success) continue;
      const manifestPath = join(this.runtimeRoot, sessionId, "manifest.json");
      let manifest: CodexRuntimeManifest;
      try {
        manifest = manifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
        if (manifest.sessionId !== sessionId) throw new Error("Session id mismatch.");
      } catch {
        outcomes.push({
          sessionId,
          status: "INVALID",
          message: "Runtime manifest is missing or invalid; no files were removed.",
        });
        continue;
      }

      if (manifest.state === "ACTIVE" && manifest.pid && this.isProcessAlive(manifest.pid)) {
        outcomes.push({ sessionId, status: "ACTIVE", pid: manifest.pid });
        continue;
      }

      try {
        await this.removeProfileIfUnchanged(manifest);
        await this.removeSessionDirectory(sessionId);
        outcomes.push({ sessionId, status: "RECOVERED" });
      } catch (error) {
        outcomes.push({
          sessionId,
          status: "CONFLICT",
          message: error instanceof Error ? error.message : "Runtime recovery conflict.",
        });
      }
    }
    return outcomes;
  }

  private async readPreparedManifest(runtime: PreparedCodexRuntime): Promise<CodexRuntimeManifest> {
    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(runtime.manifestPath, "utf8")),
    );
    if (
      manifest.sessionId !== runtime.sessionId ||
      manifest.profileName !== runtime.profileName ||
      runtime.profilePath !== this.profilePath(manifest)
    ) {
      throw new CodexRuntimeConfigurationError("Codex runtime manifest does not match the session.");
    }
    return manifest;
  }

  private async removeProfileIfUnchanged(manifest: CodexRuntimeManifest): Promise<void> {
    const profilePath = this.profilePath(manifest);
    let contents: string;
    try {
      contents = await readFile(profilePath, "utf8");
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return;
      throw error;
    }
    if (sha256(contents) !== manifest.profileSha256) {
      throw new CodexRuntimeConfigurationError(
        `Temporary Codex profile '${basename(profilePath)}' changed after creation; it was not removed.`,
      );
    }
    await unlink(profilePath);
  }

  private async removeSessionDirectory(sessionId: string): Promise<void> {
    sessionIdSchema.parse(sessionId);
    await rm(join(this.runtimeRoot, sessionId), { recursive: true, force: true });
  }

  private profilePath(manifest: CodexRuntimeManifest): string {
    return join(this.codexHome, `${manifest.profileName}.config.toml`);
  }

  private async writeManifest(path: string, manifest: CodexRuntimeManifest): Promise<void> {
    const parsed = manifestSchema.parse(manifest);
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, serializeManifest(parsed), { encoding: "utf8", flag: "wx" });
    await rename(temporaryPath, path);
  }
}

function serializeManifest(manifest: CodexRuntimeManifest): string {
  return `${JSON.stringify(manifestSchema.parse(manifest), null, 2)}\n`;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "EPERM") return true;
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
