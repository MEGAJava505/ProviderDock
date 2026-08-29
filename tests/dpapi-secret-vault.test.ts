import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChainedSecretStore,
  DpapiFileSecretVault,
  EnvironmentSecretStore,
  MemorySecretStore,
  WindowsDpapiProtector,
  type SecretProtector,
} from "../src/index.js";

describe("DpapiFileSecretVault", () => {
  it("persists only protected values and supports the vault lifecycle", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-secrets-"));
    const vault = new DpapiFileSecretVault(directory, new Base64Protector());

    await vault.set("ROUTER_KEY", "actual-secret-value");
    expect(await vault.get("ROUTER_KEY")).toBe("actual-secret-value");
    expect(await vault.listReferences()).toEqual(["ROUTER_KEY"]);

    const [fileName] = await readdir(directory);
    const storedFile = await readFile(join(directory, fileName as string), "utf8");
    expect(storedFile).not.toContain("actual-secret-value");
    expect(storedFile).toContain("ROUTER_KEY");

    await vault.set("ROUTER_KEY", "replacement-secret");
    expect(await vault.get("ROUTER_KEY")).toBe("replacement-secret");
    expect(await vault.delete("ROUTER_KEY")).toBe(true);
    expect(await vault.delete("ROUTER_KEY")).toBe(false);
    expect(await vault.get("ROUTER_KEY")).toBeUndefined();
  });

  it("rejects references that could escape the secrets directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-secrets-"));
    const vault = new DpapiFileSecretVault(directory, new Base64Protector());
    await expect(vault.set("../escape", "secret")).rejects.toThrow();
  });
});

describe("ChainedSecretStore", () => {
  it("prefers the protected vault and falls back to the environment", async () => {
    const vault = new MemorySecretStore({ SHARED: "vault-value" });
    const environment = new EnvironmentSecretStore({
      SHARED: "environment-value",
      FALLBACK: "fallback-value",
    });
    const chained = new ChainedSecretStore([vault, environment]);

    expect(await chained.get("SHARED")).toBe("vault-value");
    expect(await chained.get("FALLBACK")).toBe("fallback-value");
    expect(await chained.get("MISSING")).toBeUndefined();
  });
});

const windowsIt = process.platform === "win32" ? it : it.skip;

windowsIt("round-trips a value through the current Windows user's DPAPI", async () => {
  const protector = new WindowsDpapiProtector();
  const plaintext = "ProviderDock DPAPI smoke ✓\n";
  const protectedValue = await protector.protect(plaintext);

  expect(protectedValue).not.toContain(plaintext);
  expect(await protector.unprotect(protectedValue)).toBe(plaintext);
});

class Base64Protector implements SecretProtector {
  async protect(value: string): Promise<string> {
    return Buffer.from(value, "utf8").toString("base64");
  }

  async unprotect(protectedValue: string): Promise<string> {
    return Buffer.from(protectedValue, "base64").toString("utf8");
  }
}
