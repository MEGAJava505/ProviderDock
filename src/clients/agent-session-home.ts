import type { Dirent } from "node:fs";
import { mkdir, readdir, rmdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export const defaultRetainedAgentSessionsPerProvider = 50;

const providerIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const codexSessionFileNamePattern = /^rollout-.*\.jsonl$/i;
const claudeSessionFileNamePattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;

export interface AgentSessionLayout {
  /**
   * Directory below a provider home in which the agent stores conversation files.
   * Only files matching the layout predicate in this directory are eligible for
   * retention; credentials and configuration remain untouched.
   */
  readonly sessionDirectoryName: string;
  isSessionFile(fileName: string): boolean;
}

export const codexAgentSessionLayout: AgentSessionLayout = {
  sessionDirectoryName: "sessions",
  isSessionFile: (fileName) => codexSessionFileNamePattern.test(fileName),
};

export const claudeAgentSessionLayout: AgentSessionLayout = {
  sessionDirectoryName: "projects",
  isSessionFile: (fileName) => claudeSessionFileNamePattern.test(fileName),
};

export interface AgentSessionHomeManagerOptions {
  readonly rootDirectory: string;
  readonly retainedSessionsPerProvider?: number;
  readonly layout: AgentSessionLayout;
}

interface SessionFileMetadata {
  readonly path: string;
  readonly modifiedAtMs: number;
}

export class AgentSessionHomeManager {
  private readonly rootDirectory: string;
  private readonly retainedSessionsPerProvider: number;
  private readonly layout: AgentSessionLayout;
  private readonly activeSessionsByProvider = new Map<string, number>();

  constructor(options: AgentSessionHomeManagerOptions) {
    this.rootDirectory = options.rootDirectory;
    this.retainedSessionsPerProvider =
      options.retainedSessionsPerProvider ?? defaultRetainedAgentSessionsPerProvider;
    this.layout = options.layout;
    if (
      !Number.isSafeInteger(this.retainedSessionsPerProvider) ||
      this.retainedSessionsPerProvider < 1
    ) {
      throw new RangeError("retainedSessionsPerProvider must be a positive integer.");
    }
  }

  homeFor(providerId: string): string {
    validateProviderId(providerId);
    return join(this.rootDirectory, "providers", providerId);
  }

  async prepare(providerId: string): Promise<string> {
    const home = this.homeFor(providerId);
    await mkdir(home, { recursive: true });
    return home;
  }

  async beginSession(providerId: string): Promise<string> {
    const home = await this.prepare(providerId);
    const active = this.activeSessionsByProvider.get(providerId) ?? 0;
    this.activeSessionsByProvider.set(providerId, active + 1);
    return home;
  }

  async endSession(providerId: string): Promise<void> {
    validateProviderId(providerId);
    const active = this.activeSessionsByProvider.get(providerId);
    if (active === undefined) return;
    if (active <= 1) this.activeSessionsByProvider.delete(providerId);
    else this.activeSessionsByProvider.set(providerId, active - 1);
    await this.retain(providerId);
  }

  async retain(providerId: string): Promise<void> {
    const sessionRoot = join(this.homeFor(providerId), this.layout.sessionDirectoryName);
    const sessions = await collectSessionFiles(sessionRoot, this.layout);
    const orderedSessions = [...sessions].sort((left, right) =>
      right.modifiedAtMs - left.modifiedAtMs || comparePathsDescending(left.path, right.path),
    );

    for (const session of orderedSessions.slice(this.retainedSessionsPerProvider)) {
      await unlink(session.path).catch((error: unknown) => {
        if (!isENOENT(error)) throw error;
      });
    }
    await removeEmptyDirectories(sessionRoot);
  }
}

function validateProviderId(providerId: string): void {
  if (!providerIdPattern.test(providerId)) {
    throw new RangeError(
      "Provider ids used for agent session homes may contain only lowercase letters, digits, hyphens, and underscores.",
    );
  }
}

async function collectSessionFiles(
  directory: string,
  layout: AgentSessionLayout,
): Promise<readonly SessionFileMetadata[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return [];
    throw error;
  }

  const files: SessionFileMetadata[] = [];
  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectSessionFiles(entryPath, layout)));
      continue;
    }
    if (!entry.isFile() || !layout.isSessionFile(entry.name)) continue;

    const stats = await stat(entryPath).catch((error: unknown) => {
      if (isENOENT(error)) return undefined;
      throw error;
    });
    if (stats !== undefined && stats.isFile()) {
      files.push({ path: entryPath, modifiedAtMs: stats.mtimeMs });
    }
  }
  return files;
}

async function removeEmptyDirectories(directory: string): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isENOENT(error)) return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    await removeEmptyDirectories(join(directory, entry.name));
  }

  const remaining = await readdir(directory).catch((error: unknown) => {
    if (isENOENT(error)) return [];
    throw error;
  });
  if (remaining.length === 0) {
    await rmdir(directory).catch((error: unknown) => {
      if (!isENOENT(error) && !isENOTEMPTY(error)) throw error;
    });
  }
}

function comparePathsDescending(left: string, right: string): number {
  if (left < right) return 1;
  if (left > right) return -1;
  return 0;
}

function isENOENT(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

function isENOTEMPTY(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOTEMPTY";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

