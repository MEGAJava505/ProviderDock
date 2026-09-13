import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileAgentApprovalPreferenceRepository,
  MemoryAgentApprovalPreferenceRepository,
} from "../src/index.js";

describe("Agent approval preferences", () => {
  it("persists an explicit full-auto preference", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-launch-"));
    const repository = new FileAgentApprovalPreferenceRepository(
      join(directory, "launch", "preferences.json"),
      { platform: "win32" },
    );

    await repository.upsert({
      projectDirectory: "C:\\Projects\\Example",
      approvalLevel: "full-auto",
    });

    expect(await repository.get("C:\\projects\\example")).toEqual({
      projectDirectory: "C:\\Projects\\Example",
      approvalLevel: "full-auto",
    });
    expect(JSON.parse(await readFile(join(directory, "launch", "preferences.json"), "utf8")))
      .toMatchObject({ version: 1 });
  });

  it("defaults to ask when no preference exists", async () => {
    const repository = new MemoryAgentApprovalPreferenceRepository();
    expect(await repository.get("C:\\Projects\\Example")).toBeUndefined();
  });

  it("fails closed to ask when storage is invalid", async () => {
    const directory = await mkdtemp(join(tmpdir(), "providerdock-launch-"));
    const file = join(directory, "preferences.json");
    await writeFile(file, "{ invalid", "utf8");
    const repository = new FileAgentApprovalPreferenceRepository(file);

    await expect(repository.get("C:\\Projects\\Example")).rejects.toThrow();
    await expect(repository.upsert({
      projectDirectory: "C:\\Projects\\Example",
      approvalLevel: "full-auto",
    })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("{ invalid");
    expect((await readdir(directory)).filter((name) => name.endsWith(".bak")))
      .toHaveLength(1);
  });

  it("deletes a preference by normalized project directory", async () => {
    const repository = new MemoryAgentApprovalPreferenceRepository({ platform: "win32" });
    await repository.upsert({
      projectDirectory: "C:\\Projects\\Example",
      approvalLevel: "auto",
    });

    expect(await repository.delete("C:\\projects\\EXAMPLE")).toBe(true);
    expect(await repository.get("C:\\Projects\\Example")).toBeUndefined();
  });
});
