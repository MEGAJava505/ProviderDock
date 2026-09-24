import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
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
    const originalRevision = await vault.revision("ROUTER_KEY");
    expect(originalRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(await vault.get("ROUTER_KEY")).toBe("actual-secret-value");
    expect(await vault.listReferences()).toEqual(["ROUTER_KEY"]);

    const [fileName] = await readdir(directory);
    const storedFile = await readFile(join(directory, fileName as string), "utf8");
    expect(storedFile).not.toContain("actual-secret-value");
    expect(storedFile).toContain("ROUTER_KEY");

    await vault.set("ROUTER_KEY", "replacement-secret");
    expect(await vault.revision("ROUTER_KEY")).not.toBe(originalRevision);
    const replacementRevision = await vault.revision("ROUTER_KEY");
    await vault.set("ROUTER_KEY", "replacement-secret");
    expect(await vault.revision("ROUTER_KEY")).not.toBe(replacementRevision);
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

  it("changes the opaque revision if protected bytes change without changing the generation", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-secrets-"));
    const vault = new DpapiFileSecretVault(directory, new Base64Protector());
    await vault.set("ROUTER_KEY", "original-secret");
    const firstRevision = await vault.revision("ROUTER_KEY");
    const [fileName] = await readdir(directory);
    const path = join(directory, fileName!);
    const stored = JSON.parse(await readFile(path, "utf8")) as { protectedValue: string; generation: string };
    await writeFile(path, JSON.stringify({ ...stored, protectedValue: Buffer.from("changed-secret").toString("base64") }));
    expect(await vault.revision("ROUTER_KEY")).not.toBe(firstRevision);
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

  it("keeps every record when managed credentials are imported concurrently", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-credential-concurrency-"));
    const metadata = new FileCredentialMetadataRepository(join(directory, "registry.json"));
    await metadata.initializeEmpty();
    const secrets = new MemorySecretStore();
    const manager = new CredentialManager({ secrets, metadata, bindings: new TestCredentialBindings() });

    await Promise.all(Array.from({ length: 12 }, (_, index) => manager.add({
      providerId: "vsllm", purpose: "provider-api", value: `synthetic-key-${index}`,
    })));

    expect(await metadata.list()).toHaveLength(12);
    expect(await secrets.listReferences()).toHaveLength(12);
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

  it("marks an unavailable legacy binding without overwriting its ciphertext", async () => {
    const bindings = new TestCredentialBindings();
    await bindings.activate({ providerId: "vsllm", purpose: "provider-api", secretRef: "LEGACY_VSLLM_KEY" });
    let writes = 0;
    const secrets = {
      async get(): Promise<string | undefined> { throw new SecretProtectionError("Windows DPAPI operation failed."); },
      async set(): Promise<void> { writes += 1; },
      async delete(): Promise<boolean> { return false; },
      async listReferences(): Promise<readonly string[]> { return ["LEGACY_VSLLM_KEY"]; },
    };
    const metadata = new MemoryCredentialMetadataRepository();
    const manager = new CredentialManager({ secrets, metadata, bindings });

    const summaries = await manager.reconcile();

    expect(summaries).toEqual([
      expect.objectContaining({ providerId: "vsllm", maskedValue: "unavailable", state: "unavailable" }),
    ]);
    // The legacy ciphertext reference is preserved and never rewritten with a placeholder.
    expect((await metadata.list())[0]?.secretRef).toBe("LEGACY_VSLLM_KEY");
    expect(writes).toBe(0);
  });

  it("keeps an explicitly unlocked restore usable when no writable vault is available", async () => {
    const source = new MemorySecretStore();
    const sourceBindings = new TestCredentialBindings();
    const sourceManager = new CredentialManager({
      secrets: source,
      metadata: new MemoryCredentialMetadataRepository(),
      bindings: sourceBindings,
    });
    const credential = await sourceManager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "portable-recovery-secret",
    });
    const backupPath = join(await mkdtemp(join(tmpdir(), "provider-dock-unlocked-")), "credentials.pdv");
    await sourceManager.createBackup(backupPath, "restore-passphrase");

    const restoredBindings = new TestCredentialBindings();
    const restoredManager = new CredentialManager({
      secrets: new ReadOnlySecretStore(),
      metadata: new MemoryCredentialMetadataRepository(),
      bindings: restoredBindings,
    });
    const report = await restoredManager.restoreBackup(backupPath, "restore-passphrase");
    expect(report.restored).toBe(1);
    await restoredManager.activate("vsllm", "provider-api", report.credentialIds[0] ?? credential.id);
    await expect(restoredManager.resolveActive("vsllm", "provider-api")).resolves.toBe(
      "portable-recovery-secret",
    );
  });

  it("rolls registry and binding state back when activation fails after pointer mutation", async () => {
    const secrets = new MemorySecretStore();
    const metadata = new MemoryCredentialMetadataRepository();
    const bindings = new FailOnceCredentialBindings();
    const manager = new CredentialManager({ secrets, metadata, bindings });
    const first = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "first-provider-secret",
      activate: true,
    });
    const second = await manager.add({
      providerId: "vsllm",
      purpose: "provider-api",
      value: "second-provider-secret",
    });
    bindings.failNextActivation();

    await expect(manager.activate("vsllm", "provider-api", second.id)).rejects.toThrow(
      "simulated binding failure",
    );
    expect(await manager.list("vsllm", "provider-api")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, state: "active" }),
      expect.objectContaining({ id: second.id, state: "available" }),
    ]));
    expect((await bindings.list())[0]?.secretRef).toBe((await metadata.get(first.id))?.secretRef);
  });

  it("does not erase a concurrent import while rolling back failed activation", async () => {
    const secrets = new MemorySecretStore();
    const metadata = new MemoryCredentialMetadataRepository();
    const bindings = new TestCredentialBindings();
    const manager = new CredentialManager({ secrets, metadata, bindings });
    await manager.add({ providerId: "vsllm", purpose: "provider-api", value: "first-secret", activate: true });
    const selected = await manager.add({ providerId: "vsllm", purpose: "provider-api", value: "second-secret" });
    const selectedRef = (await metadata.get(selected.id))?.secretRef;
    const { entered: activationEntered, release } = pauseFailingActivation(bindings, selectedRef);

    const activation = manager.activate("vsllm", "provider-api", selected.id);
    await activationEntered;
    const added = manager.add({ providerId: "vsllm", purpose: "provider-api", value: "third-secret" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await expect(activation).rejects.toThrow("simulated binding failure");
    const third = await added;

    expect(await metadata.get(third.id)).toBeDefined();
    expect(await secrets.get((await metadata.get(third.id))?.secretRef ?? "missing")).toBe("third-secret");
  });

  it("does not erase an import from another manager when activation rolls back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-cross-manager-"));
    const path = join(directory, "registry.json");
    const metadataA = new FileCredentialMetadataRepository(path);
    const metadataB = new FileCredentialMetadataRepository(path);
    await metadataA.initializeEmpty();
    const secrets = new MemorySecretStore();
    const bindings = new TestCredentialBindings();
    const managerA = new CredentialManager({ secrets, metadata: metadataA, bindings });
    const managerB = new CredentialManager({ secrets, metadata: metadataB, bindings });
    await managerA.add({ providerId: "vsllm", purpose: "provider-api", value: "first-secret", activate: true });
    const selected = await managerA.add({ providerId: "vsllm", purpose: "provider-api", value: "second-secret" });
    const selectedRef = (await metadataA.get(selected.id))?.secretRef;
    const { entered: activationEntered, release } = pauseFailingActivation(bindings, selectedRef);

    const activation = managerA.activate("vsllm", "provider-api", selected.id);
    await activationEntered;
    const addition = managerB.add({ providerId: "vsllm", purpose: "provider-api", value: "third-secret" });
    const completedBeforeRelease = await Promise.race([
      addition.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300)),
    ]);
    release();
    await expect(activation).rejects.toThrow("simulated binding failure");
    const third = await addition;

    expect(completedBeforeRelease).toBe(false);
    expect(await metadataB.get(third.id)).toBeDefined();
    expect(await secrets.get((await metadataB.get(third.id))?.secretRef ?? "missing")).toBe("third-secret");
  });

  it("preserves records written outside its snapshot when activation rolls back", async () => {
    const secrets = new MemorySecretStore();
    const metadata = new MemoryCredentialMetadataRepository();
    const bindings = new TestCredentialBindings();
    const manager = new CredentialManager({ secrets, metadata, bindings });
    const first = await manager.add({ providerId: "vsllm", purpose: "provider-api", value: "first-secret", activate: true });
    const selected = await manager.add({ providerId: "vsllm", purpose: "provider-api", value: "second-secret" });
    const selectedRef = (await metadata.get(selected.id))?.secretRef;
    const outsideId = "5f0a5d2c-7d3b-4a2e-9c11-2b3c4d5e6f70";
    const originalActivate = bindings.activate.bind(bindings);
    bindings.activate = async (binding) => {
      if (binding.secretRef === selectedRef) {
        // A writer outside this operation's transaction lands a record between
        // the activation snapshot and the rollback; the rollback must not touch it.
        await metadata.upsert({
          id: outsideId,
          providerId: "other",
          purpose: "provider-api",
          secretRef: "OUTSIDE-CREDENTIAL",
          maskedValue: "out…side",
          state: "available",
          createdAt: "2026-09-23T00:00:00.000Z",
        });
        throw new Error("simulated binding failure");
      }
      await originalActivate(binding);
    };

    await expect(manager.activate("vsllm", "provider-api", selected.id)).rejects.toThrow(
      "simulated binding failure",
    );

    expect(await metadata.get(outsideId)).toBeDefined();
    expect(await manager.list("vsllm", "provider-api")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, state: "active" }),
      expect.objectContaining({ id: selected.id, state: "available" }),
    ]));
  });
});

describe("FileCredentialMetadataRepository lock safety", () => {
  const sampleRecord = {
    id: "b0c1d2e3-4f5a-4b6c-8d7e-9f0a1b2c3d4e",
    providerId: "vsllm",
    purpose: "provider-api",
    secretRef: "SAMPLE-REF",
    maskedValue: "sam…ref",
    state: "available",
    createdAt: "2026-09-23T00:00:00.000Z",
  } as const;

  async function reservedDeadPid(): Promise<number> {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    const pid = child.pid;
    if (pid === undefined) throw new Error("Could not spawn a probe process.");
    await new Promise<void>((resolve) => child.on("exit", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    return pid;
  }

  it("fails closed on a lock with no identifiable owner instead of removing a possible live successor", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-markerless-fail-"));
    const path = join(directory, "registry.json");
    const repo = new FileCredentialMetadataRepository(path, { busyTimeoutMs: 200, retryIntervalMs: 10 });
    await repo.initializeEmpty();
    const lockPath = `${path}.lock`;
    // A markerless lock is indistinguishable from a live writer that took the
    // directory but has not yet published its owner marker. Age it far past any
    // grace window so an auto-reclaiming writer would treat it as abandoned and
    // enter after moving it — exactly the interleaving that must never delete a
    // live successor's lock.
    await mkdir(lockPath);
    const aged = new Date(Date.now() - 3_600_000);
    await utimes(lockPath, aged, aged);

    // Fail closed and name the lock: an owner that cannot be identified cannot be
    // proven dead, so its directory is never removed.
    await expect(repo.upsert(sampleRecord)).rejects.toThrow(lockPath);
    await expect(stat(lockPath)).resolves.toBeDefined();
    expect((await repo.list()).map((record) => record.id)).not.toContain(sampleRecord.id);
    await rm(directory, { recursive: true, force: true });
  });

  it("fails closed on a lock whose recorded owner is gone instead of deleting it after the check", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-deadowner-fail-"));
    const path = join(directory, "registry.json");
    const repo = new FileCredentialMetadataRepository(path, { busyTimeoutMs: 200, retryIntervalMs: 10 });
    await repo.initializeEmpty();
    const lockPath = `${path}.lock`;
    await mkdir(lockPath);
    // The recorded owner has already exited. An auto-reclaimer would read this id
    // and then delete the directory — but a live successor can replace the lock
    // in the gap between that check and the delete, so the provably safe choice
    // is to refuse and fail closed rather than delete on the strength of a stale
    // observation.
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      ownerId: "crashed", pid: await reservedDeadPid(), acquiredAt: new Date().toISOString(),
    }));

    await expect(repo.upsert(sampleRecord)).rejects.toThrow(lockPath);
    const marker = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { ownerId: string };
    expect(marker.ownerId).toBe("crashed");
    expect((await repo.list()).map((record) => record.id)).not.toContain(sampleRecord.id);
    await rm(directory, { recursive: true, force: true });
  });

  it("refuses to steal a lock held by a live process and names the lock path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-live-lock-"));
    const path = join(directory, "registry.json");
    const repo = new FileCredentialMetadataRepository(path, { busyTimeoutMs: 150, retryIntervalMs: 10 });
    await repo.initializeEmpty();
    const lockPath = `${path}.lock`;
    await mkdir(lockPath);
    await writeFile(join(lockPath, "owner.json"), JSON.stringify({
      ownerId: "live", pid: process.pid, acquiredAt: new Date().toISOString(),
    }));

    const error = await repo.upsert(sampleRecord).then(() => undefined, (reason) => reason);
    const message = (error as Error).message;
    expect(message).toContain(lockPath);                                   // exact lock path
    expect(message).toContain("No changes were made.");
    expect(message).toMatch(/if no ProviderDock process is running/);      // deletion advice is CONDITIONAL, never for a live lock
    expect(message).not.toMatch(/SAMPLE-REF|sam…ref/);                     // no secret/ref leaks into the message
    // The live owner's lock and marker survive the refusal, and nothing was written.
    const marker = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { ownerId: string };
    expect(marker.ownerId).toBe("live");
    expect((await repo.list()).map((record) => record.id)).not.toContain(sampleRecord.id);
  });

  it("aborts fail-closed when it cannot publish its ownership marker", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-marker-fail-"));
    const path = join(directory, "registry.json");
    const lockPath = `${path}.lock`;
    // A writer whose marker publication always fails: without a marker it could
    // not prove ownership at release time, so it must abort rather than hold a
    // directory it cannot safely release.
    class UnmarkableRepository extends FileCredentialMetadataRepository {
      protected async writeOwnerMarker(): Promise<boolean> {
        return false;
      }
    }
    const repo = new UnmarkableRepository(path, { busyTimeoutMs: 400, retryIntervalMs: 10 });

    await expect(repo.upsert(sampleRecord)).rejects.toThrow(lockPath);
    // No unidentifiable lock is left behind, and nothing was written.
    await expect(stat(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await repo.list()).map((record) => record.id)).not.toContain(sampleRecord.id);
  });

  it("releases only its own lock, sparing a successor that took over mid-write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-release-own-"));
    const path = join(directory, "registry.json");
    const lockPath = `${path}.lock`;
    // While this writer holds the lock and its work runs, a successor reclaims
    // the directory. Cleanup must not delete the successor's live lock.
    class SwappingRepository extends FileCredentialMetadataRepository {
      public armed = false;
      protected async onLockHeld(lock: string): Promise<void> {
        if (!this.armed) return;
        this.armed = false;
        await rm(lock, { recursive: true, force: true });
        await mkdir(lock);
        await writeFile(join(lock, "owner.json"), JSON.stringify({
          ownerId: "successor", pid: process.pid, acquiredAt: new Date().toISOString(),
        }));
      }
    }
    const repo = new SwappingRepository(path, { busyTimeoutMs: 400, retryIntervalMs: 10 });
    await repo.initializeEmpty();
    repo.armed = true;

    await repo.upsert(sampleRecord);
    // The record was still committed, and the successor's lock survived cleanup.
    expect((await repo.list()).map((record) => record.id)).toContain(sampleRecord.id);
    const marker = JSON.parse(await readFile(join(lockPath, "owner.json"), "utf8")) as { ownerId: string };
    expect(marker.ownerId).toBe("successor");
  });

  it("preserves both records when two independent writers race on one file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "provider-dock-concurrent-write-"));
    const path = join(directory, "registry.json");
    const writerA = new FileCredentialMetadataRepository(path, { busyTimeoutMs: 5_000, retryIntervalMs: 5 });
    const writerB = new FileCredentialMetadataRepository(path, { busyTimeoutMs: 5_000, retryIntervalMs: 5 });
    await writerA.initializeEmpty();
    const recordA = { ...sampleRecord, id: "a1111111-1111-4111-8111-111111111111" };
    const recordB = { ...sampleRecord, id: "b2222222-2222-4222-8222-222222222222" };

    await Promise.all([writerA.upsert(recordA), writerB.upsert(recordB)]);

    const ids = (await writerA.list()).map((record) => record.id);
    expect(ids).toContain(recordA.id);
    expect(ids).toContain(recordB.id);
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

// Deterministic gate for the activation-rollback races: hold the binding
// activation for `secretRef` open until released, then fail it, so a test can
// land a concurrent write in the gap between the snapshot and the rollback.
function pauseFailingActivation(
  bindings: TestCredentialBindings,
  secretRef: string | undefined,
): { entered: Promise<void>; release: () => void } {
  let entered!: () => void;
  let release!: () => void;
  const activationEntered = new Promise<void>((resolve) => { entered = resolve; });
  const activationReleased = new Promise<void>((resolve) => { release = resolve; });
  const originalActivate = bindings.activate.bind(bindings);
  bindings.activate = async (binding) => {
    if (binding.secretRef === secretRef) {
      entered();
      await activationReleased;
      throw new Error("simulated binding failure");
    }
    await originalActivate(binding);
  };
  return { entered: activationEntered, release };
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

class ReadOnlySecretStore {
  async get(): Promise<string | undefined> {
    return undefined;
  }
}

class FailOnceCredentialBindings implements CredentialBindingAdapter {
  private active?: CredentialBinding;
  private failNext = false;

  failNextActivation(): void {
    this.failNext = true;
  }

  async list(): Promise<readonly CredentialBinding[]> {
    return this.active === undefined ? [] : [this.active];
  }

  async activate(binding: CredentialBinding): Promise<void> {
    this.active = binding;
    if (this.failNext) {
      this.failNext = false;
      throw new Error("simulated binding failure");
    }
  }

  async isReferenced(secretRef: string): Promise<boolean> {
    return this.active?.secretRef === secretRef;
  }
}
