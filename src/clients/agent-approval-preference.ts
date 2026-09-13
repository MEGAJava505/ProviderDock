import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, normalize } from "node:path";
import { z } from "zod";
import { projectDirectoryKey } from "../core/profiles/project-profile.js";
import {
  agentApprovalLevels,
  type AgentApprovalLevel,
} from "./agent-approval.js";

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 1024 * 1024;

const agentApprovalPreferenceSchema = z
  .object({
    projectDirectory: z.string().trim().min(1).max(4_096),
    approvalLevel: z.enum(agentApprovalLevels),
  })
  .strict();

const storedPreferencesSchema = z
  .object({
    version: z.literal(storageVersion),
    preferences: z.array(agentApprovalPreferenceSchema).max(2_048),
  })
  .strict();

export interface AgentApprovalPreference {
  readonly projectDirectory: string;
  readonly approvalLevel: AgentApprovalLevel;
}

export type AgentApprovalPreferenceInput = AgentApprovalPreference;

export interface AgentApprovalPreferenceRepository {
  list(): Promise<readonly AgentApprovalPreference[]>;
  get(projectDirectory: string): Promise<AgentApprovalPreference | undefined>;
  upsert(input: AgentApprovalPreferenceInput): Promise<AgentApprovalPreference>;
  delete(projectDirectory: string): Promise<boolean>;
}

export interface FileAgentApprovalPreferenceRepositoryOptions {
  readonly maximumFileBytes?: number;
  readonly platform?: NodeJS.Platform;
}

/** Per-project launch approval choices with atomic, serialized persistence. */
export class FileAgentApprovalPreferenceRepository
  implements AgentApprovalPreferenceRepository
{
  private readonly maximumFileBytes: number;
  private readonly platform: NodeJS.Platform;
  private mutationQueue: Promise<void> = Promise.resolve();
  private backupTask?: Promise<string>;

  constructor(
    private readonly filePath: string,
    options: FileAgentApprovalPreferenceRepositoryOptions = {},
  ) {
    this.maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    if (!Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes <= 0) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
    this.platform = options.platform ?? process.platform;
  }

  list(): Promise<readonly AgentApprovalPreference[]> {
    return this.load();
  }

  async get(projectDirectory: string): Promise<AgentApprovalPreference | undefined> {
    const key = projectDirectoryKey(projectDirectory, this.platform);
    return (await this.load()).find(
      (preference) =>
        projectDirectoryKey(preference.projectDirectory, this.platform) === key,
    );
  }

  upsert(input: AgentApprovalPreferenceInput): Promise<AgentApprovalPreference> {
    const preference = parseAgentApprovalPreference(input);
    return this.serializeMutation(async () => {
      const preferences = [...(await this.load())];
      const key = projectDirectoryKey(preference.projectDirectory, this.platform);
      const existingIndex = preferences.findIndex(
        (candidate) =>
          projectDirectoryKey(candidate.projectDirectory, this.platform) === key,
      );
      if (existingIndex >= 0) preferences[existingIndex] = preference;
      else preferences.push(preference);
      preferences.sort((left, right) =>
        projectDirectoryKey(left.projectDirectory, this.platform).localeCompare(
          projectDirectoryKey(right.projectDirectory, this.platform),
        ),
      );
      await this.writeAtomically(preferences);
      return preference;
    });
  }

  delete(projectDirectory: string): Promise<boolean> {
    const key = projectDirectoryKey(projectDirectory, this.platform);
    return this.serializeMutation(async () => {
      const preferences = [...(await this.load())];
      const remaining = preferences.filter(
        (preference) =>
          projectDirectoryKey(preference.projectDirectory, this.platform) !== key,
      );
      if (remaining.length === preferences.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async load(): Promise<readonly AgentApprovalPreference[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Agent approval preferences exceed ${this.maximumFileBytes} bytes.`,
        );
      }
      let document: z.infer<typeof storedPreferencesSchema>;
      try {
        document = storedPreferencesSchema.parse(JSON.parse(contents));
      } catch (error) {
        await this.preserveCorruptSource(contents);
        throw new AgentApprovalPreferenceCorruptionError(
          `Agent approval preference store '${this.filePath}' is corrupt.`,
          { cause: error },
        );
      }
      const preferences = document.preferences.map(parseAgentApprovalPreference);
      const keys = new Set<string>();
      for (const preference of preferences) {
        const key = projectDirectoryKey(preference.projectDirectory, this.platform);
        if (keys.has(key)) {
          const error = new AgentApprovalPreferenceCorruptionError(
            `Duplicate agent approval preference '${preference.projectDirectory}'.`,
          );
          await this.preserveCorruptSource(contents);
          throw error;
        }
        keys.add(key);
      }
      return preferences;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async preserveCorruptSource(contents: string): Promise<string> {
    this.backupTask ??= (async () => {
      await mkdir(dirname(this.filePath), { recursive: true });
      const backupPath = `${this.filePath}.corrupt-${Date.now()}-${randomUUID()}.bak`;
      await writeFile(backupPath, contents, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return backupPath;
    })();
    return this.backupTask;
  }

  private async writeAtomically(
    preferences: readonly AgentApprovalPreference[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, preferences },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(
        `Agent approval preferences exceed ${this.maximumFileBytes} bytes.`,
      );
    }

    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, serialized, { encoding: "utf8", flag: "wx" });
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export class MemoryAgentApprovalPreferenceRepository
  implements AgentApprovalPreferenceRepository
{
  private readonly preferences = new Map<string, AgentApprovalPreference>();

  private readonly platform: NodeJS.Platform;

  constructor(options: { readonly platform?: NodeJS.Platform } = {}) {
    this.platform = options.platform ?? process.platform;
  }

  async list(): Promise<readonly AgentApprovalPreference[]> {
    return [...this.preferences.values()].sort((left, right) =>
      projectDirectoryKey(left.projectDirectory, this.platform).localeCompare(
        projectDirectoryKey(right.projectDirectory, this.platform),
      ),
    );
  }

  async get(projectDirectory: string): Promise<AgentApprovalPreference | undefined> {
    return this.preferences.get(projectDirectoryKey(projectDirectory, this.platform));
  }

  async upsert(input: AgentApprovalPreferenceInput): Promise<AgentApprovalPreference> {
    const preference = parseAgentApprovalPreference(input);
    this.preferences.set(
      projectDirectoryKey(preference.projectDirectory, this.platform),
      preference,
    );
    return preference;
  }

  async delete(projectDirectory: string): Promise<boolean> {
    return this.preferences.delete(projectDirectoryKey(projectDirectory, this.platform));
  }
}

export class AgentApprovalPreferenceCorruptionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentApprovalPreferenceCorruptionError";
  }
}

function parseAgentApprovalPreference(
  input: AgentApprovalPreferenceInput,
): AgentApprovalPreference {
  const parsed = agentApprovalPreferenceSchema.parse(input);
  return { ...parsed, projectDirectory: normalize(parsed.projectDirectory) };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
