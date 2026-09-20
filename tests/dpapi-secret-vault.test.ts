import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ChainedSecretStore,
  CredentialManager,
  DpapiFileSecretVault,
  encryptPortableSecretPayload,
  decryptPortableSecretPayload,
  EnvironmentSecretStore,
  FileCredentialMetadataRepository,
  MemoryCredentialMetadataRepository,
  MemorySecretStore,
  SecretProtectionError,
  WindowsDpapiProtector,
  type CredentialBindingAdapter,
  type CredentialBinding,
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

  it("falls through an undecryptable protected store to an explicit environment value", async () => {
    const protectedStore = {
      async get(): Promise<string | undefined> {
        throw new SecretProtectionError("Windows DPAPI operation failed.");
      },
    };
    const chained = new ChainedSecretStore([
      protectedStore,
      new EnvironmentSecretStore({ RECOVERED: "environment-value" }),
    ]);

    await expect(chained.get("RECOVERED")).resolves.toBe("environment-value");
  });
});

describe("portable secret envelope", () => {
  it("round-trips a JSON payload without serializing plaintext", async () => {
    const payload = {
      version: 1,
      credentials: [{ id: "cred-1", value: "actual-secret-value" }],
    };

    const envelope = await encryptPortableSecretPayload(payload, "correct horse battery staple");

    expect(JSON.stringify(envelope)).not.toContain("actual-secret-value");
    await expect(
      decryptPortableSecretPayload(envelope, "correct horse battery staple"),
    ).resolves.toEqual(payload);
  });

  it("rejects a wrong passphrase and tampered ciphertext with one sanitized error", async () => {
    const envelope = await encryptPortableSecretPayload({ value: "actual-secret-value" }, "passphrase");
    const tampered = { ...envelope, ciphertext: `${envelope.ciphertext.slice(0, -1)}A` };

    await expect(decryptPortableSecretPayload(envelope, "wrong")).rejects.toMatchObject({
      name: "SecretProtectionError",
      message: "Portable credential backup could not be opened.",
    });
    await expect(decryptPortableSecretPayload(tampered, "passphrase")).rejects.toBeInstanceOf(
      SecretProtectionError,
    );
  });

  it("rejects unsupported or malformed envelopes before returning data", async () => {
    await expect(
      decryptPortableSecretPayload({ version: 99 }, "passphrase"),
    ).rejects.toBeInstanceOf(SecretProtectionError);
    await expect(
      decryptPortableSecretPayload({ version: 1, ciphertext: "not-an-envelope" }, "passphrase"),
    ).rejects.toBeInstanceOf(SecretProtectionError);
  });
});

describe("CredentialManager", () => {
  it("supports multiple masked credentials and resolves only the explicit active one", async () => {
    const bindings = new TestCredentialBindings();
    const manager = new CredentialManager({
      secrets: new MemorySecretStore(),
      metadata: new MemoryCredentialMetadataRepository(),
      bindings,
      now: () => new Date("2026-09-21T00:00:00.000Z"),
    });

    const first = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "abc123456789WXYZ",
      activate: true,
    });
    const second = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "def987654321LMNO",
    });

    expect(first.maskedValue).toBe("abc…WXYZ");
    expect(second.maskedValue).toBe("def…LMNO");
    const listed = await manager.list("vsllm", "provider-api");
    expect(listed).toHaveLength(2);
    expect(listed).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, state: "active", maskedValue: "abc…WXYZ" }),
      expect.objectContaining({ id: second.id, state: "available", maskedValue: "def…LMNO" }),
    ]));
    await expect(manager.resolveActive("vsllm", "provider-api")).resolves.toBe("abc123456789WXYZ");
  });

  it("rotates explicitly, blocks referenced removal, and restores an additive backup", async () => {
    const secrets = new MemorySecretStore();
    const bindings = new TestCredentialBindings();
    const metadata = new MemoryCredentialMetadataRepository();
    const manager = new CredentialManager({ secrets, metadata, bindings });
    const oldCredential = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "old-provider-secret",
      activate: true,
    });
    const newCredential = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "new-provider-secret",
    });

    await expect(manager.remove("vsllm", oldCredential.id)).rejects.toThrow(
      "Credential is still referenced by an active binding.",
    );
    await manager.activate("vsllm", "provider-api", newCredential.id);
    await expect(manager.resolveActive("vsllm", "provider-api")).resolves.toBe("new-provider-secret");
    await manager.remove("vsllm", oldCredential.id);

    const backupPath = join(await mkdtemp(join(tmpdir(), "provider-dock-backup-")), "credentials.pdv");
    await manager.createBackup(backupPath, "backup-passphrase");
    const restoredSecrets = new MemorySecretStore();
    const restoredManager = new CredentialManager({
      secrets: restoredSecrets,
      metadata: new MemoryCredentialMetadataRepository(),
      bindings: new TestCredentialBindings(),
    });
    const report = await restoredManager.restoreBackup(backupPath, "backup-passphrase");

    expect(report.restored).toBe(1);
    expect((await restoredManager.list("vsllm", "provider-api"))).toEqual([
      expect.objectContaining({ maskedValue: "new…cret", state: "available" }),
    ]);
    expect(await restoredSecrets.listReferences()).toHaveLength(1);
  });

  it("persists metadata without a plaintext value and reports an unavailable payload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-credential-registry-"));
    const registryPath = join(directory, "credentials", "registry.json");
    const secrets = new MemorySecretStore();
    const manager = new CredentialManager({
      secrets,
      metadata: new FileCredentialMetadataRepository(registryPath),
      bindings: new TestCredentialBindings(),
    });

    const added = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "persisted-secret-value",
    });
    const registryContents = await readFile(registryPath, "utf8");
    expect(registryContents).not.toContain("persisted-secret-value");

    const unavailable = new CredentialManager({
      secrets: new UnavailableSecretVault(),
      metadata: new FileCredentialMetadataRepository(registryPath),
      bindings: new TestCredentialBindings(),
    });
    expect(await unavailable.list("vsllm", "provider-api")).toEqual([
      expect.objectContaining({ id: added.id, state: "unavailable" }),
    ]);
  });

  it("reconciles legacy bindings additively without changing their secret references", async () => {
    const secrets = new MemorySecretStore({ LEGACY_VSLLM_KEY: "legacy-provider-secret" });
    const bindings = new TestCredentialBindings();
    await bindings.activate({
      providerId: "vsllm",
      purpose: "provider-api",
      secretRef: "LEGACY_VSLLM_KEY",
    });
    const metadata = new MemoryCredentialMetadataRepository();
    const manager = new CredentialManager({ secrets, metadata });
    // Manager instances without bindings must not invent references.
    await expect(manager.reconcile()).resolves.toEqual([]);

    const reconciler = new CredentialManager({ secrets, metadata, bindings });
    const summaries = await reconciler.reconcile();
    expect(summaries).toEqual([
      expect.objectContaining({
        providerId: "vsllm",
        purpose: "provider-api",
        maskedValue: "leg…cret",
        state: "active",
      }),
    ]);
    const record = (await metadata.list())[0];
    expect(record?.secretRef).toBe("LEGACY_VSLLM_KEY");
    expect(await secrets.get("LEGACY_VSLLM_KEY")).toBe("legacy-provider-secret");
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

class TestCredentialBindings implements CredentialBindingAdapter {
  private readonly active = new Map<string, CredentialBinding>();

  async list(): Promise<readonly CredentialBinding[]> {
    return [...this.active.values()];
  }

  async activate(binding: CredentialBinding): Promise<void> {
    this.active.set(`${binding.providerId}:${binding.purpose}`, binding);
  }

  async isReferenced(secretRef: string): Promise<boolean> {
    return [...this.active.values()].some((binding) => binding.secretRef === secretRef);
  }
}

class UnavailableSecretVault {
  async get(): Promise<string | undefined> {
    throw new SecretProtectionError("Windows DPAPI operation failed.");
  }

  async set(): Promise<void> {}

  async delete(): Promise<boolean> {
    return false;
  }

  async listReferences(): Promise<readonly string[]> {
    return [];
  }
}
