import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FilePromptProfileRepository,
  parsePromptProfile,
} from "../src/index.js";

describe("Prompt profiles", () => {
  it("validates profile preferences, fallback policy, and client flags", () => {
    expect(
      parsePromptProfile({
        id: "practical",
        name: "Practical Coding",
        instructions: "Inspect the implementation first.",
        preferredLogicalModelId: "gpt-x",
        preferredClient: "codex",
        reasoningLevel: "xhigh",
        fallbackPolicy: "logical-model",
        clientFlags: {
          codex: ["--no-alt-screen"],
          claudeCode: ["--verbose"],
        },
      }),
    ).toMatchObject({
      id: "practical",
      description: "",
      preferredLogicalModelId: "gpt-x",
      fallbackPolicy: "logical-model",
    });

    expect(() =>
      parsePromptProfile({
        id: "broken",
        name: "Broken",
        instructions: "Missing logical model.",
        fallbackPolicy: "logical-model",
      }),
    ).toThrow(/requires preferredLogicalModelId/i);
  });

  it("persists versioned CRUD data and serializes concurrent mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-prompts-"));
    const filePath = join(directory, "prompts", "profiles.json");
    const repository = new FilePromptProfileRepository(filePath);

    await Promise.all([
      repository.upsert({
        id: "practical",
        name: "Practical",
        instructions: "Work practically.",
      }),
      repository.upsert({
        id: "deep-review",
        name: "Deep Review",
        instructions: "Review every affected invariant.",
        preferredClient: "claude-code",
      }),
    ]);

    expect((await repository.list()).map((profile) => profile.id)).toEqual([
      "deep-review",
      "practical",
    ]);
    expect(await repository.delete("missing")).toBe(false);
    expect(await repository.delete("deep-review")).toBe(true);

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    expect(stored).toMatchObject({
      version: 1,
      promptProfiles: [{ id: "practical" }],
    });
  });

  it("fails closed for duplicate and oversized persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-prompts-"));
    const filePath = join(directory, "profiles.json");
    const repository = new FilePromptProfileRepository(filePath, {
      maximumFileBytes: 512,
    });
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        promptProfiles: [
          { id: "same", name: "One", instructions: "one" },
          { id: "same", name: "Two", instructions: "two" },
        ],
      }),
      "utf8",
    );
    await expect(repository.list()).rejects.toThrow(/duplicate prompt profile/i);

    await writeFile(filePath, "x".repeat(513), "utf8");
    await expect(repository.list()).rejects.toThrow(/exceeds 512 bytes/i);
  });
});
