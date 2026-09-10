import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  FileProjectProfileRepository,
  parseProjectProfile,
} from "../src/index.js";

describe("Project profiles", () => {
  it("requires absolute directories and normalizes bindings", () => {
    expect(() =>
      parseProjectProfile({
        projectDirectory: "relative/project",
        promptProfileId: "practical",
      }),
    ).toThrow(/absolute path/i);

    const root = join(tmpdir(), "provider-dock-project");
    expect(
      parseProjectProfile({
        projectDirectory: join(root, "."),
        promptProfileId: "practical",
      }),
    ).toMatchObject({
      projectDirectory: root,
      promptProfileId: "practical",
    });
  });

  it("persists exact-directory bindings and serializes concurrent mutations", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-projects-"));
    const filePath = join(directory, "projects", "profiles.json");
    const repository = new FileProjectProfileRepository(filePath);
    const projectA = join(directory, "project-a");
    const projectB = join(directory, "project-b");

    await Promise.all([
      repository.upsert({
        projectDirectory: projectB,
        promptProfileId: "review",
      }),
      repository.upsert({
        projectDirectory: projectA,
        promptProfileId: "practical",
      }),
    ]);

    expect((await repository.list()).map((profile) => profile.projectDirectory)).toEqual([
      projectA,
      projectB,
    ]);
    expect(await repository.get(join(projectA, "."))).toMatchObject({
      promptProfileId: "practical",
    });
    expect(await repository.delete(join(directory, "missing"))).toBe(false);
    expect(await repository.delete(projectB)).toBe(true);

    const stored = JSON.parse(await readFile(filePath, "utf8"));
    expect(stored).toMatchObject({
      version: 1,
      projectProfiles: [
        { projectDirectory: projectA, promptProfileId: "practical" },
      ],
    });
  });

  it("fails closed for duplicate and oversized persisted data", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-projects-"));
    const filePath = join(directory, "profiles.json");
    const repository = new FileProjectProfileRepository(filePath, {
      maximumFileBytes: 512,
    });
    const projectDirectory = join(directory, "project");
    await writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        projectProfiles: [
          { projectDirectory, promptProfileId: "one" },
          { projectDirectory: join(projectDirectory, "."), promptProfileId: "two" },
        ],
      }),
      "utf8",
    );
    await expect(repository.list()).rejects.toThrow(/duplicate project profile/i);

    await writeFile(filePath, "x".repeat(513), "utf8");
    await expect(repository.list()).rejects.toThrow(/exceeds 512 bytes/i);
  });
});
