import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  parsePromptProfile,
  promptProfileSchema,
  type PromptProfile,
  type PromptProfileInput,
} from "./prompt-profile.js";

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 4 * 1024 * 1024;

const storedPromptProfilesSchema = z
  .object({
    version: z.literal(storageVersion),
    promptProfiles: z.array(promptProfileSchema).max(512),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [index, profile] of document.promptProfiles.entries()) {
      if (ids.has(profile.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate prompt profile '${profile.id}'.`,
          path: ["promptProfiles", index, "id"],
        });
      }
      ids.add(profile.id);
    }
  });

export interface PromptProfileRepository {
  list(): Promise<readonly PromptProfile[]>;
  get(id: string): Promise<PromptProfile | undefined>;
  upsert(input: PromptProfileInput): Promise<PromptProfile>;
  delete(id: string): Promise<boolean>;
}

export interface FilePromptProfileRepositoryOptions {
  readonly maximumFileBytes?: number;
}

/** Versioned, bounded, serialized and atomic prompt-profile storage. */
export class FilePromptProfileRepository implements PromptProfileRepository {
  private readonly maximumFileBytes: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FilePromptProfileRepositoryOptions = {},
  ) {
    this.maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    if (!Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes <= 0) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
  }

  list(): Promise<readonly PromptProfile[]> {
    return this.load();
  }

  async get(id: string): Promise<PromptProfile | undefined> {
    return (await this.load()).find((profile) => profile.id === id);
  }

  upsert(input: PromptProfileInput): Promise<PromptProfile> {
    const profile = parsePromptProfile(input);
    return this.serializeMutation(async () => {
      const profiles = [...(await this.load())];
      const existingIndex = profiles.findIndex(
        (candidate) => candidate.id === profile.id,
      );
      if (existingIndex >= 0) profiles[existingIndex] = profile;
      else profiles.push(profile);
      profiles.sort((left, right) => left.id.localeCompare(right.id));
      await this.writeAtomically(profiles);
      return profile;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const profiles = [...(await this.load())];
      const remaining = profiles.filter((profile) => profile.id !== id);
      if (remaining.length === profiles.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async load(): Promise<readonly PromptProfile[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Prompt-profile configuration exceeds ${this.maximumFileBytes} bytes.`,
        );
      }
      return storedPromptProfilesSchema.parse(JSON.parse(contents)).promptProfiles;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAtomically(
    profiles: readonly PromptProfile[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, promptProfiles: profiles },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(
        `Prompt-profile configuration exceeds ${this.maximumFileBytes} bytes.`,
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

export class MemoryPromptProfileRepository implements PromptProfileRepository {
  private readonly profiles = new Map<string, PromptProfile>();

  async list(): Promise<readonly PromptProfile[]> {
    return [...this.profiles.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async get(id: string): Promise<PromptProfile | undefined> {
    return this.profiles.get(id);
  }

  async upsert(input: PromptProfileInput): Promise<PromptProfile> {
    const profile = parsePromptProfile(input);
    this.profiles.set(profile.id, profile);
    return profile;
  }

  async delete(id: string): Promise<boolean> {
    return this.profiles.delete(id);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
