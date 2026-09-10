import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  parseProjectProfile,
  projectDirectoryKey,
  projectProfileSchema,
  type ProjectProfile,
  type ProjectProfileInput,
} from "./project-profile.js";

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 2 * 1024 * 1024;

const storedProjectProfilesSchema = z
  .object({
    version: z.literal(storageVersion),
    projectProfiles: z.array(projectProfileSchema).max(2_048),
  })
  .strict();

export interface ProjectProfileRepository {
  list(): Promise<readonly ProjectProfile[]>;
  get(projectDirectory: string): Promise<ProjectProfile | undefined>;
  upsert(input: ProjectProfileInput): Promise<ProjectProfile>;
  delete(projectDirectory: string): Promise<boolean>;
}

export interface FileProjectProfileRepositoryOptions {
  readonly maximumFileBytes?: number;
  readonly platform?: NodeJS.Platform;
}

/** Exact-directory project bindings with atomic, serialized persistence. */
export class FileProjectProfileRepository implements ProjectProfileRepository {
  private readonly maximumFileBytes: number;
  private readonly platform: NodeJS.Platform;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FileProjectProfileRepositoryOptions = {},
  ) {
    this.maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    if (!Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes <= 0) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
    this.platform = options.platform ?? process.platform;
  }

  list(): Promise<readonly ProjectProfile[]> {
    return this.load();
  }

  async get(projectDirectory: string): Promise<ProjectProfile | undefined> {
    const key = projectDirectoryKey(projectDirectory, this.platform);
    return (await this.load()).find(
      (profile) =>
        projectDirectoryKey(profile.projectDirectory, this.platform) === key,
    );
  }

  upsert(input: ProjectProfileInput): Promise<ProjectProfile> {
    const profile = parseProjectProfile(input);
    return this.serializeMutation(async () => {
      const profiles = [...(await this.load())];
      const key = projectDirectoryKey(profile.projectDirectory, this.platform);
      const existingIndex = profiles.findIndex(
        (candidate) =>
          projectDirectoryKey(candidate.projectDirectory, this.platform) === key,
      );
      if (existingIndex >= 0) profiles[existingIndex] = profile;
      else profiles.push(profile);
      profiles.sort((left, right) =>
        projectDirectoryKey(left.projectDirectory, this.platform).localeCompare(
          projectDirectoryKey(right.projectDirectory, this.platform),
        ),
      );
      await this.writeAtomically(profiles);
      return profile;
    });
  }

  delete(projectDirectory: string): Promise<boolean> {
    const key = projectDirectoryKey(projectDirectory, this.platform);
    return this.serializeMutation(async () => {
      const profiles = [...(await this.load())];
      const remaining = profiles.filter(
        (profile) =>
          projectDirectoryKey(profile.projectDirectory, this.platform) !== key,
      );
      if (remaining.length === profiles.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async load(): Promise<readonly ProjectProfile[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Project-profile configuration exceeds ${this.maximumFileBytes} bytes.`,
        );
      }
      const document = storedProjectProfilesSchema.parse(JSON.parse(contents));
      const profiles = document.projectProfiles.map(parseProjectProfile);
      const keys = new Set<string>();
      for (const profile of profiles) {
        const key = projectDirectoryKey(profile.projectDirectory, this.platform);
        if (keys.has(key)) {
          throw new TypeError(
            `Duplicate project profile '${profile.projectDirectory}'.`,
          );
        }
        keys.add(key);
      }
      return profiles;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAtomically(
    profiles: readonly ProjectProfile[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, projectProfiles: profiles },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(
        `Project-profile configuration exceeds ${this.maximumFileBytes} bytes.`,
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

export class MemoryProjectProfileRepository implements ProjectProfileRepository {
  private readonly profiles = new Map<string, ProjectProfile>();

  constructor(private readonly platform: NodeJS.Platform = process.platform) {}

  async list(): Promise<readonly ProjectProfile[]> {
    return [...this.profiles.values()].sort((left, right) =>
      projectDirectoryKey(left.projectDirectory, this.platform).localeCompare(
        projectDirectoryKey(right.projectDirectory, this.platform),
      ),
    );
  }

  async get(projectDirectory: string): Promise<ProjectProfile | undefined> {
    return this.profiles.get(projectDirectoryKey(projectDirectory, this.platform));
  }

  async upsert(input: ProjectProfileInput): Promise<ProjectProfile> {
    const profile = parseProjectProfile(input);
    this.profiles.set(
      projectDirectoryKey(profile.projectDirectory, this.platform),
      profile,
    );
    return profile;
  }

  async delete(projectDirectory: string): Promise<boolean> {
    return this.profiles.delete(projectDirectoryKey(projectDirectory, this.platform));
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
