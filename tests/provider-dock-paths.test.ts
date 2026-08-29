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
    expect(paths.secretsDirectory).toBe(
      join("C:\\Users\\test", ".provider-switcher", "secrets"),
    );
  });

  it("supports an isolated directory override", () => {
    const paths = resolveProviderDockPaths({
      environment: { PROVIDER_DOCK_HOME: ".test-provider-dock" },
      userHome: "ignored",
    });
    expect(paths.dataDirectory).toBe(resolve(".test-provider-dock"));
  });
});
