import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import {
  logicalModelGroupSchema,
  parseLogicalModelGroup,
  type LogicalModelGroup,
  type LogicalModelGroupInput,
} from "./logical-model.js";

const storageVersion = 1 as const;
const defaultMaximumFileBytes = 1024 * 1024;

const storedLogicalModelsSchema = z
  .object({
    version: z.literal(storageVersion),
    logicalModels: z.array(logicalModelGroupSchema).max(512),
  })
  .strict()
  .superRefine((document, context) => {
    const ids = new Set<string>();
    for (const [index, logicalModel] of document.logicalModels.entries()) {
      if (ids.has(logicalModel.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate logical model '${logicalModel.id}'.`,
          path: ["logicalModels", index, "id"],
        });
      }
      ids.add(logicalModel.id);
    }
  });

export interface LogicalModelRepository {
  list(): Promise<readonly LogicalModelGroup[]>;
  get(id: string): Promise<LogicalModelGroup | undefined>;
  upsert(input: LogicalModelGroupInput): Promise<LogicalModelGroup>;
  delete(id: string): Promise<boolean>;
}

export interface FileLogicalModelRepositoryOptions {
  readonly maximumFileBytes?: number;
}

/** Versioned, bounded and crash-safe storage for logical-model routing policy. */
export class FileLogicalModelRepository implements LogicalModelRepository {
  private readonly maximumFileBytes: number;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    options: FileLogicalModelRepositoryOptions = {},
  ) {
    this.maximumFileBytes = options.maximumFileBytes ?? defaultMaximumFileBytes;
    if (!Number.isSafeInteger(this.maximumFileBytes) || this.maximumFileBytes <= 0) {
      throw new TypeError("maximumFileBytes must be a positive safe integer.");
    }
  }

  async list(): Promise<readonly LogicalModelGroup[]> {
    return this.load();
  }

  async get(id: string): Promise<LogicalModelGroup | undefined> {
    return (await this.load()).find((logicalModel) => logicalModel.id === id);
  }

  upsert(input: LogicalModelGroupInput): Promise<LogicalModelGroup> {
    const logicalModel = parseLogicalModelGroup(input);
    return this.serializeMutation(async () => {
      const logicalModels = [...(await this.load())];
      const existingIndex = logicalModels.findIndex(
        (candidate) => candidate.id === logicalModel.id,
      );
      if (existingIndex >= 0) logicalModels[existingIndex] = logicalModel;
      else logicalModels.push(logicalModel);
      logicalModels.sort((left, right) => left.id.localeCompare(right.id));
      await this.writeAtomically(logicalModels);
      return logicalModel;
    });
  }

  delete(id: string): Promise<boolean> {
    return this.serializeMutation(async () => {
      const logicalModels = [...(await this.load())];
      const remaining = logicalModels.filter((logicalModel) => logicalModel.id !== id);
      if (remaining.length === logicalModels.length) return false;
      await this.writeAtomically(remaining);
      return true;
    });
  }

  private async load(): Promise<readonly LogicalModelGroup[]> {
    try {
      const contents = await readFile(this.filePath, "utf8");
      if (Buffer.byteLength(contents, "utf8") > this.maximumFileBytes) {
        throw new RangeError(
          `Logical-model configuration exceeds ${this.maximumFileBytes} bytes.`,
        );
      }
      return storedLogicalModelsSchema.parse(JSON.parse(contents)).logicalModels;
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
  }

  private async writeAtomically(
    logicalModels: readonly LogicalModelGroup[],
  ): Promise<void> {
    const serialized = `${JSON.stringify(
      { version: storageVersion, logicalModels },
      null,
      2,
    )}\n`;
    if (Buffer.byteLength(serialized, "utf8") > this.maximumFileBytes) {
      throw new RangeError(
        `Logical-model configuration exceeds ${this.maximumFileBytes} bytes.`,
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

export class MemoryLogicalModelRepository implements LogicalModelRepository {
  private readonly logicalModels = new Map<string, LogicalModelGroup>();

  async list(): Promise<readonly LogicalModelGroup[]> {
    return [...this.logicalModels.values()].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
  }

  async get(id: string): Promise<LogicalModelGroup | undefined> {
    return this.logicalModels.get(id);
  }

  async upsert(input: LogicalModelGroupInput): Promise<LogicalModelGroup> {
    const logicalModel = parseLogicalModelGroup(input);
    this.logicalModels.set(logicalModel.id, logicalModel);
    return logicalModel;
  }

  async delete(id: string): Promise<boolean> {
    return this.logicalModels.delete(id);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
