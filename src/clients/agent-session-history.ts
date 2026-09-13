import { readdir, readFile, stat, unlink } from "node:fs/promises";
import { basename, join } from "node:path";

export type AgentClient = "claude-code" | "codex";

export type AgentSessionResumeBlockReason =
  | "legacy-provider"
  | "invalid-session-id"
  | "missing-project"
  | "missing-model";

export interface AgentSessionRecord {
  readonly id: string;
  readonly client: AgentClient;
  readonly providerId: string;
  readonly projectDirectory?: string;
  readonly modelId?: string;
  readonly title: string;
  readonly updatedAt: string;
  readonly resumable: boolean;
  readonly resumeBlockedReason?: AgentSessionResumeBlockReason;
  /** Filesystem path is internal and must not be returned to browser clients. */
  readonly path: string;
}

export interface AgentSessionHistoryOptions {
  readonly claudeHome: string;
  readonly codexHome: string;
}

export interface DeleteAgentSessionInput {
  readonly client: AgentClient;
  readonly id: string;
  readonly providerId?: string;
}

const providerIdPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const legacyCodexProviderId = "legacy";
function resumeBlockReason(input: {
  readonly providerId: string;
  readonly id: string;
  readonly projectDirectory?: string | undefined;
  readonly modelId?: string | undefined;
}): AgentSessionResumeBlockReason | undefined {
  if (input.providerId === legacyCodexProviderId) return "legacy-provider";
  if (!uuidPattern.test(input.id)) return "invalid-session-id";
  if (input.projectDirectory === undefined) return "missing-project";
  if (input.modelId === undefined) return "missing-model";
  return undefined;
}

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Reads retained conversation files from the same provider-scoped homes used by
 * launchers. Delete operations never accept a caller-supplied path: they first
 * rediscover the record under an allowed root and then unlink that exact file.
 */
export class AgentSessionHistory {
  private readonly claudeHome: string;
  private readonly codexHome: string;

  constructor(options: AgentSessionHistoryOptions) {
    this.claudeHome = options.claudeHome;
    this.codexHome = options.codexHome;
  }

  async list(): Promise<readonly AgentSessionRecord[]> {
    const [claude, codex, legacyCodex] = await Promise.all([
      this.listProviderHomes("claude-code"),
      this.listProviderHomes("codex"),
      this.listLegacyCodexSessions(),
    ]);
    return [...claude, ...codex, ...legacyCodex]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async delete(input: DeleteAgentSessionInput): Promise<boolean> {
    const matches = (await this.list()).filter(
      (record) =>
        record.client === input.client &&
        record.id === input.id &&
        (input.providerId === undefined || record.providerId === input.providerId),
    );
    if (matches.length !== 1) return false;
    try {
      await unlink(matches[0]!.path);
      return true;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return false;
      throw error;
    }
  }

  private async listProviderHomes(
    client: AgentClient,
  ): Promise<readonly AgentSessionRecord[]> {
    const home = client === "claude-code" ? this.claudeHome : this.codexHome;
    const providerRoot = join(home, "providers");
    const providers = (await readDirectoryNames(providerRoot)).filter((name) =>
      providerIdPattern.test(name),
    );
    const records: AgentSessionRecord[] = [];
    for (const providerId of providers) {
      const sessionRoot = join(
        providerRoot,
        providerId,
        client === "claude-code" ? "projects" : "sessions",
      );
      const titles = client === "codex"
        ? await readCodexTitles(join(providerRoot, providerId, "session_index.jsonl"))
        : new Map<string, CodexSessionTitle>();
      records.push(...(await scanSessionTree(sessionRoot, client, providerId, titles)));
    }
    return records;
  }

  private async listLegacyCodexSessions(): Promise<readonly AgentSessionRecord[]> {
    const titles = await readCodexTitles(join(this.codexHome, "session_index.jsonl"));
    return scanSessionTree(
      join(this.codexHome, "sessions"),
      "codex",
      legacyCodexProviderId,
      titles,
    );
  }
}

interface CodexSessionTitle {
  readonly title?: string;
  readonly updatedAt?: string;
}

async function scanSessionTree(
  root: string,
  client: AgentClient,
  providerId: string,
  codexTitles: ReadonlyMap<string, CodexSessionTitle>,
): Promise<readonly AgentSessionRecord[]> {
  const records: AgentSessionRecord[] = [];
  await visit(root, async (path, entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) return;
    const parsed = client === "claude-code"
      ? await parseClaudeSession(path, entry.name, providerId)
      : await parseCodexSession(path, entry.name, providerId, codexTitles);
    if (parsed !== undefined) records.push(parsed);
  });
  return records;
}

async function visit(
  directory: string,
  visitFile: (path: string, entry: { readonly name: string; readonly isFile: () => boolean }) => Promise<void>,
): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await visit(path, visitFile);
      continue;
    }
    await visitFile(path, entry);
  }
}

async function parseClaudeSession(
  path: string,
  fileName: string,
  providerId: string,
): Promise<AgentSessionRecord | undefined> {
  const lines = await readJsonLines(path);
  let title: string | undefined;
  let projectDirectory: string | undefined;
  let modelId: string | undefined;
  let sessionId: string | undefined;
  for (const row of lines) {
    const message = isRecord(row.message) ? row.message : undefined;
    if (sessionId === undefined && typeof row.sessionId === "string") sessionId = row.sessionId;
    if (title === undefined) {
      if (typeof row.aiTitle === "string") title = row.aiTitle;
      else if (typeof row.title === "string") title = row.title;
      else if (typeof message?.title === "string") title = message.title;
      else if (
        message?.role === "user" &&
        typeof message.content === "string" &&
        message.content.trim() !== ""
      ) {
        title = normalizePreview(message.content);
      }
    }
    if (projectDirectory === undefined) {
      projectDirectory = firstString(row.cwd, row.projectDirectory, message?.cwd);
    }
    if (modelId === undefined) modelId = firstString(row.model, message?.model);
  }
  const id = sessionId ?? basename(fileName, ".jsonl");
  const updatedAt = await fileUpdatedAt(path);
  const blockedReason = resumeBlockReason({ providerId, id, projectDirectory, modelId });
  return {
    id,
    client: "claude-code",
    providerId,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    ...(modelId === undefined ? {} : { modelId }),
    title: title ?? "Claude Code session",
    updatedAt,
    resumable: blockedReason === undefined,
    ...(blockedReason === undefined ? {} : { resumeBlockedReason: blockedReason }),
    path,
  };
}

async function parseCodexSession(
  path: string,
  fileName: string,
  providerId: string,
  titles: ReadonlyMap<string, CodexSessionTitle>,
): Promise<AgentSessionRecord | undefined> {
  const lines = await readJsonLines(path);
  let payloadId: string | undefined;
  let projectDirectory: string | undefined;
  let modelId: string | undefined;
  for (const row of lines) {
    const payload = isRecord(row.payload) ? row.payload : undefined;
    if (payloadId === undefined) payloadId = firstString(payload?.session_id, payload?.id);
    if (projectDirectory === undefined) {
      projectDirectory = firstString(row.cwd, row.projectDirectory, payload?.cwd);
    }
    if (modelId === undefined) modelId = firstString(row.model, payload?.model);
  }
  const id = payloadId ?? basename(fileName, ".jsonl");
  const indexed = titles.get(id);
  const updatedAt = indexed?.updatedAt && isIsoDateTime(indexed.updatedAt)
    ? indexed.updatedAt
    : await fileUpdatedAt(path);
  const blockedReason = resumeBlockReason({ providerId, id, projectDirectory, modelId });
  return {
    id,
    client: "codex",
    providerId,
    ...(projectDirectory === undefined ? {} : { projectDirectory }),
    ...(modelId === undefined ? {} : { modelId }),
    title: indexed?.title?.trim() || "Codex CLI session",
    updatedAt,
    resumable: blockedReason === undefined,
    ...(blockedReason === undefined ? {} : { resumeBlockedReason: blockedReason }),
    path,
  };
}

async function readJsonLines(path: string): Promise<readonly Record<string, unknown>[]> {
  const contents = await readFile(path, "utf8").catch(() => "");
  const rows: Record<string, unknown>[] = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRecord(parsed)) rows.push(parsed);
    } catch {
      // Agent clients append partial JSON during crashes. Skip those lines.
    }
  }
  return rows;
}

async function readCodexTitles(
  path: string,
): Promise<Map<string, CodexSessionTitle>> {
  const rows = await readJsonLines(path);
  const result = new Map<string, CodexSessionTitle>();
  for (const row of rows) {
    const id = firstString(row.id);
    if (id === undefined) continue;
    const title = firstString(row.thread_name, row.title);
    const updatedAt = firstString(row.updated_at);
    result.set(id, {
      ...(title === undefined ? {} : { title }),
      ...(updatedAt === undefined ? {} : { updatedAt }),
    });
  }
  return result;
}

async function readDirectoryNames(path: string): Promise<readonly string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

async function fileUpdatedAt(path: string): Promise<string> {
  const stats = await stat(path);
  return stats.mtime.toISOString();
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return undefined;
}

function normalizePreview(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 96);
}

function isIsoDateTime(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
