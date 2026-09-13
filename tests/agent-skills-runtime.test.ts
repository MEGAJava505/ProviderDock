import { lstat, mkdir, mkdtemp, readlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentSkillsLocator, AgentSkillsRuntime } from "../src/index.js";

describe("AgentSkillsLocator", () => {
  it("honors the explicit global skills directory", () => {
    expect(
      new AgentSkillsLocator({
        environment: { PROVIDERDOCK_AGENT_SKILLS_DIR: "C:\\skills" },
        userHome: "C:\\Users\\someone",
      }).locate(),
    ).toBe("C:\\skills");
  });
});

describe("AgentSkillsRuntime", () => {
  it("links a native agent home to the global skills directory and reuses it", async () => {
    const root = await mkdtemp(join(tmpdir(), "providerdock-skills-"));
    const globalDirectory = join(root, "global-skills");
    const agentHome = join(root, "agent-home");
    await mkdir(globalDirectory, { recursive: true });
    const runtime = new AgentSkillsRuntime({
      environment: { PROVIDERDOCK_AGENT_SKILLS_DIR: globalDirectory },
      platform: process.platform,
    });

    await expect(runtime.prepare(agentHome)).resolves.toMatchObject({ status: "linked" });
    await expect(runtime.prepare(agentHome)).resolves.toMatchObject({ status: "already-linked" });
    const linkPath = join(agentHome, "skills");
    expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
    expect(await readlink(linkPath)).toBe(globalDirectory);
  });

  it("does not overwrite a conflicting skills path", async () => {
    const root = await mkdtemp(join(tmpdir(), "providerdock-skills-conflict-"));
    const globalDirectory = join(root, "global-skills");
    const agentHome = join(root, "agent-home");
    await mkdir(join(agentHome, "skills"), { recursive: true });
    await mkdir(globalDirectory, { recursive: true });
    const result = await new AgentSkillsRuntime({
      environment: { PROVIDERDOCK_AGENT_SKILLS_DIR: globalDirectory },
      platform: process.platform,
    }).prepare(agentHome);
    expect(result.status).toBe("conflict");
  });
});
