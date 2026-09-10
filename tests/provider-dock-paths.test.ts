import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { resolveProviderDockPaths } from "../src/index.js";

describe("ProviderDock paths", () => {
  it("uses the specification-compatible default data directory", () => {
    const paths = resolveProviderDockPaths({ environment: {}, userHome: "C:\\Users\\test" });
    expect(paths.dataDirectory).toBe(join("C:\\Users\\test", ".provider-switcher"));
    expect(paths.providersFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "providers", "providers.json"),
    );
    expect(paths.logicalModelsFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "fallback", "logical-models.json"),
    );
    expect(paths.promptProfilesFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "prompts", "profiles.json"),
    );
    expect(paths.projectProfilesFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "projects", "profiles.json"),
    );
    expect(paths.healthHistoryFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "health", "history.json"),
    );
    expect(paths.usageHistoryFile).toBe(
      join("C:\\Users\\test", ".provider-switcher", "usage", "events.json"),
    );
    expect(paths.secretsDirectory).toBe(
      join("C:\\Users\\test", ".provider-switcher", "secrets"),
    );
    expect(paths.runtimeDirectory).toBe(
      join("C:\\Users\\test", ".provider-switcher", "runtime"),
    );
    expect(paths.codexHome).toBe(
      join("C:\\Users\\test", ".provider-switcher", "runtime", "codex-home"),
    );
  });

  it("supports an isolated directory override", () => {
    const paths = resolveProviderDockPaths({
      environment: { PROVIDER_DOCK_HOME: ".test-provider-dock" },
      userHome: "ignored",
    });
    expect(paths.dataDirectory).toBe(resolve(".test-provider-dock"));
    expect(paths.codexHome).toBe(
      join(resolve(".test-provider-dock"), "runtime", "codex-home"),
    );
  });

  it("honors an explicit CODEX_HOME override", () => {
    const paths = resolveProviderDockPaths({
      environment: { CODEX_HOME: "C:\\isolated-codex" },
      userHome: "C:\\Users\\test",
    });

    expect(paths.codexHome).toBe("C:\\isolated-codex");
  });
});
