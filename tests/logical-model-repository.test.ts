import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileLogicalModelRepository } from "../src/index.js";

describe("FileLogicalModelRepository", () => {
  it("persists versioned CRUD data and serializes concurrent mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-logical-models-"));
    const filePath = join(directory, "fallback", "logical-models.json");
    const repository = new FileLogicalModelRepository(filePath);

    await Promise.all([
      repository.upsert({
        id: "gpt-x",
        routes: [
          { providerId: "primary", modelId: "gpt-x", priority: 100 },
          { providerId: "secondary", modelId: "gpt-x", priority: 90 },
        ],
      }),
      repository.upsert({
        id: "claude-x",
        routes: [{ providerId: "anthropic", modelId: "claude-x", priority: 100 }],
      }),
    ]);

    expect((await repository.list()).map((logicalModel) => logicalModel.id)).toEqual([
      "claude-x",
      "gpt-x",
    ]);
    expect(await repository.delete("missing")).toBe(false);
    expect(await repository.delete("claude-x")).toBe(true);

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    expect(stored).toMatchObject({
      version: 1,
      logicalModels: [{ id: "gpt-x" }],
    });
  });

  it("fails closed for malformed, duplicate, and oversized persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-logical-models-"));
    const filePath = join(directory, "logical-models.json");
    const repository = new FileLogicalModelRepository(filePath, { maximumFileBytes: 512 });
    const duplicate = {
      version: 1,
      logicalModels: [
        { id: "same", routes: [{ providerId: "one", modelId: "m" }] },
        { id: "same", routes: [{ providerId: "two", modelId: "m" }] },
      ],
    };
    await writeFile(filePath, JSON.stringify(duplicate), "utf8");
    await expect(repository.list()).rejects.toThrow(/duplicate logical model/i);

    await writeFile(filePath, "x".repeat(513), "utf8");
    await expect(repository.list()).rejects.toThrow(/exceeds 512 bytes/i);
  });
});
