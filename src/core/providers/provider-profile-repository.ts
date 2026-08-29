import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  parseProviderProfile,
  providerProfileSchema,
  type ProviderProfile,
  type ProviderProfileInput,
} from "./provider-profile.js";

export interface ProviderProfileRepository {
  list(): Promise<readonly ProviderProfile[]>;
  get(id: string): Promise<ProviderProfile | undefined>;
  upsert(profile: ProviderProfileInput): Promise<ProviderProfile>;
  delete(id: string): Promise<boolean>;
}

const storedProfilesSchema = z.array(providerProfileSchema);

export class FileProviderProfileRepository implements ProviderProfileRepository {
  constructor(private readonly filePath: string) {}

  async list(): Promise<readonly ProviderProfile[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      return storedProfilesSchema.parse(JSON.parse(contents));
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  async get(id: string): Promise<ProviderProfile | undefined> {
    return (await this.list()).find((profile) => profile.id === id);
  }

  async upsert(input: ProviderProfileInput): Promise<ProviderProfile> {
    const profile = parseProviderProfile(input);
    const profiles = [...(await this.list())];
    const existingIndex = profiles.findIndex((candidate) => candidate.id === profile.id);

    if (existingIndex >= 0) profiles[existingIndex] = profile;
    else profiles.push(profile);

    profiles.sort((left, right) => left.id.localeCompare(right.id));
    await this.writeAtomically(profiles);
    return profile;
  }

  async delete(id: string): Promise<boolean> {
    const profiles = [...(await this.list())];
    const remaining = profiles.filter((profile) => profile.id !== id);
    if (remaining.length === profiles.length) return false;

    await this.writeAtomically(remaining);
    return true;
  }

  private async writeAtomically(profiles: readonly ProviderProfile[]): Promise<void> {
    const directory = dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(profiles, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, this.filePath);
  }
}

export class MemoryProviderProfileRepository implements ProviderProfileRepository {
  private readonly profiles = new Map<string, ProviderProfile>();

  async list(): Promise<readonly ProviderProfile[]> {
    return [...this.profiles.values()].sort((left, right) => left.id.localeCompare(right.id));
  }

  async get(id: string): Promise<ProviderProfile | undefined> {
    return this.profiles.get(id);
  }

  async upsert(input: ProviderProfileInput): Promise<ProviderProfile> {
    const profile = parseProviderProfile(input);
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

