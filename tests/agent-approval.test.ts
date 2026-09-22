import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentApprovalLevels,
  claudeApprovalArgs,
  codexApprovalArgs,
  defaultAgentApprovalLevel,
  isAgentApprovalLevel,
} from "../src/clients/agent-approval.js";
import {
  FileAgentApprovalPreferenceRepository,
  MemoryAgentApprovalPreferenceRepository,
} from "../src/index.js";

describe("agent approval levels", () => {
  it("defines the shared launch approval levels with a safe default", () => {
    expect(agentApprovalLevels).toEqual(["ask", "auto", "full-auto"]);
    expect(defaultAgentApprovalLevel).toBe("ask");
  });

  it("validates approval level values", () => {
    for (const level of agentApprovalLevels) {
      expect(isAgentApprovalLevel(level)).toBe(true);
    }
    expect(isAgentApprovalLevel("yolo")).toBe(false);
    expect(isAgentApprovalLevel(undefined)).toBe(false);
  });

  it("maps every level to a sandboxed or explicit Codex flag set", () => {
    expect(codexApprovalArgs("ask")).toEqual([
      "--sandbox",
      "read-only",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(codexApprovalArgs("auto")).toEqual([
      "--sandbox",
      "workspace-write",
      "--ask-for-approval",
      "on-request",
    ]);
    expect(codexApprovalArgs("full-auto")).toEqual([
      "--dangerously-bypass-approvals-and-sandbox",
    ]);
    expect(codexApprovalArgs()).toEqual(codexApprovalArgs(defaultAgentApprovalLevel));
  });

  it("maps every level to a Claude Code permission mode", () => {
    expect(claudeApprovalArgs("ask")).toEqual(["--permission-mode", "manual"]);
    expect(claudeApprovalArgs("auto")).toEqual(["--permission-mode", "acceptEdits"]);
    expect(claudeApprovalArgs("full-auto")).toEqual(["--dangerously-skip-permissions"]);
    expect(claudeApprovalArgs()).toEqual(claudeApprovalArgs(defaultAgentApprovalLevel));
  });
});

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
