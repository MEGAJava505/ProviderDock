import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lstat, mkdir, readlink, symlink } from "node:fs/promises";

export interface AgentSkillsLocatorOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly userHome?: string;
}

export class AgentSkillsLocator {
  private readonly environment: NodeJS.ProcessEnv;
  private readonly userHome: string;

  constructor(options: AgentSkillsLocatorOptions = {}) {
    this.environment = options.environment ?? process.env;
    this.userHome = options.userHome ?? homedir();
  }

  locate(): string {
    const configured = this.environment.PROVIDERDOCK_AGENT_SKILLS_DIR?.trim();
    return resolve(configured || join(this.userHome, ".agents", "skills"));
  }
}

export type AgentSkillsStatus =
  | "linked"
  | "already-linked"
  | "unavailable"
  | "conflict"
  | "failed";

export interface AgentSkillsPreparation {
  readonly status: AgentSkillsStatus;
  readonly globalDirectory: string;
  readonly linkPath: string;
  readonly message?: string;
}

export interface AgentSkillsRuntimeOptions extends AgentSkillsLocatorOptions {
  readonly platform?: NodeJS.Platform;
}

export class AgentSkillsRuntime {
  private readonly locator: AgentSkillsLocator;
  private readonly platform: NodeJS.Platform;

  constructor(options: AgentSkillsRuntimeOptions = {}) {
    this.locator = new AgentSkillsLocator(options);
    this.platform = options.platform ?? process.platform;
  }

  async prepare(homeDirectory: string): Promise<AgentSkillsPreparation> {
    const globalDirectory = this.locator.locate();
    const linkPath = join(homeDirectory, "skills");
    const exists = await lstat(globalDirectory).then((stats) => stats.isDirectory()).catch(() => false);
    if (!exists) return { status: "unavailable", globalDirectory, linkPath };
    await mkdir(dirname(linkPath), { recursive: true });
    const current = await lstat(linkPath).catch(() => undefined);
    if (current?.isSymbolicLink()) {
      const target = await readlink(linkPath).catch(() => undefined);
      if (target !== undefined && resolve(dirname(linkPath), target) === globalDirectory) {
        return { status: "already-linked", globalDirectory, linkPath };
      }
      return { status: "conflict", globalDirectory, linkPath, message: "skills path points elsewhere" };
    }
    if (current !== undefined) {
      return { status: "conflict", globalDirectory, linkPath, message: "skills path already exists" };
    }
    try {
      await symlink(globalDirectory, linkPath, this.platform === "win32" ? "junction" : "dir");
      return { status: "linked", globalDirectory, linkPath };
    } catch (error) {
      return {
        status: "failed",
        globalDirectory,
        linkPath,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
