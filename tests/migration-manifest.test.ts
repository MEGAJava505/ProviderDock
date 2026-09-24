import { afterEach, describe, expect, it } from "vitest";
import { appendFile, link, mkdtemp, mkdir, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  createVerifiedSnapshot, inventoryMigrationSource, readVerifiedMigrationMetadata, writeExclusivePortalStage,
  type MigrationSourcePolicy,
} from "../src/migration/migration-manifest.js";

const temporaryRoots: string[] = [];
afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    const target = resolve(root);
    if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes("migration-manifest-")) {
      throw new Error("Unsafe test cleanup");
    }
    await rm(target, { recursive: true, force: true });
  }
});

describe("verified migration snapshots", () => {
  it("preserves nested allowlisted session paths using opaque byte copies", async () => {
    const { root, base } = await fixture();
    await mkdir(join(root, "sessions", "nested"), { recursive: true });
    await writeFile(join(root, "sessions", "nested", "one.jsonl"), Buffer.from([255, 0, 128, 1]));
    const source: MigrationSourcePolicy = {
      root, files: [{ relativePath: "sessions/nested/one.jsonl", kind: "session" }],
    };
    const manifest = await inventoryMigrationSource(source);
    expect(await createVerifiedSnapshot(source, manifest, join(base, "snapshot"))).toEqual(manifest);
    expect(await readFile(join(base, "snapshot", "sessions", "nested", "one.jsonl"))).toEqual(Buffer.from([255, 0, 128, 1]));
  });

  it("refuses to expose opaque/secret bytes through the metadata reader or read outside the manifest", async () => {
    const { policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    for (const path of ["ciphertext.bin", "accounts.json", "../outside"]) {
      await expect(readVerifiedMigrationMetadata(policy, manifest, path))
        .rejects.toMatchObject({ code: "INVALID_METADATA" });
    }
  });

  it("the low-level writer also refuses empty, legacy or malformed stage documents", async () => {
    const { base, policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    for (const document of [{ version: 2, records: [] }, { version: 1, records: [] }, { token: "DO-NOT-REPORT" }]) {
      await expect(writeExclusivePortalStage(policy, manifest, join(base, "staged.json"), document))
        .rejects.toMatchObject({ code: "INVALID_STAGE" });
    }
    expect(await readdir(base)).toEqual(["source"]);
  });

  it("reports missing root/parent boundaries without leaking absolute filesystem paths", async () => {
    const { base, policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    await expect(inventoryMigrationSource({ ...policy, root: join(base, "DO-NOT-REPORT") }))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED", message: "SOURCE_CHANGED" });
    await expect(createVerifiedSnapshot(policy, manifest, join(base, "DO-NOT-REPORT", "snapshot")))
      .rejects.toMatchObject({ code: "SOURCE_CHANGED", message: "SOURCE_CHANGED" });
  });

  it("rejects nested, overlapping, relative and linked destinations without writing", async () => {
    const { root, base, policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    await symlink(root, join(base, "alias"), "junction");
    for (const destination of [root, base, join(root, "snapshot"), ".", join(base, "alias", "snapshot")]) {
      await expect(createVerifiedSnapshot(policy, manifest, destination)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    }
    expect(await readdir(root)).toEqual(["accounts.json", "ciphertext.bin"]);
  });

  it("never overwrites an existing destination or permits two successful snapshot writers", async () => {
    const { base, policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    const destination = join(base, "snapshot");
    const results = await Promise.allSettled([
      createVerifiedSnapshot(policy, manifest, destination),
      createVerifiedSnapshot(policy, manifest, destination),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: { code: "DESTINATION_EXISTS" },
    });
    expect(await readFile(join(destination, "ciphertext.bin"), "utf8")).toBe("abc");
  });

  it("rejects changed source bytes, missing files and tampered manifests before creating a snapshot", async () => {
    const { base, root, policy } = await fixture();
    const manifest = await inventoryMigrationSource(policy);
    const destination = join(base, "snapshot");
    await writeFile(join(root, "ciphertext.bin"), "xyz");
    await expect(createVerifiedSnapshot(policy, manifest, destination)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await readdir(base)).not.toContain("snapshot");
    await writeFile(join(root, "ciphertext.bin"), "abc");
    for (const files of [[], [...manifest.files, manifest.files[0]!], [
      { ...manifest.files[0]!, relativePath: "../escape" }, manifest.files[1]!,
    ]]) {
      await expect(createVerifiedSnapshot(policy, { ...manifest, files }, destination))
        .rejects.toMatchObject({ code: "INVALID_MANIFEST" });
    }
    await rm(join(root, "ciphertext.bin"));
    await expect(createVerifiedSnapshot(policy, manifest, destination)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
    expect(await readdir(base)).not.toContain("snapshot");
  });

  it("detects a source writer during snapshot IO instead of reporting a verified copy", async () => {
    const { base, root, policy } = await fixture();
    await writeFile(join(root, "ciphertext.bin"), Buffer.alloc(16 * 1024 * 1024, 7));
    const manifest = await inventoryMigrationSource(policy);
    let mutation: Promise<void> | undefined;
    const watcher = watch(base, (_event, name) => {
      if (String(name) === "snapshot" && !mutation) {
        mutation = appendFile(join(root, "ciphertext.bin"), "changed");
      }
    });
    try {
      await expect(createVerifiedSnapshot(policy, manifest, join(base, "snapshot")))
        .rejects.toMatchObject({ code: "SOURCE_CHANGED" });
      await mutation;
      expect(mutation).toBeDefined();
    } finally { watcher.close(); await mutation; }
  });

  it("hashes oversized metadata but does not parse it or allocate its full contents", async () => {
    const { root } = await fixture();
    await truncate(join(root, "accounts.json"), 64 * 1024 * 1024 + 1);
    const manifest = await inventoryMigrationSource({
      root, files: [{ relativePath: "accounts.json", kind: "portal-metadata" }],
    });
    expect(manifest.files[0]).toMatchObject({ byteLength: 67_108_865, validation: "too-large" });
  });

  it("copies only the explicit allowlist and verifies byte-for-byte preservation, including corrupt metadata", async () => {
    const { root, base, policy } = await fixture();
    await writeFile(join(root, "out-of-scope"), "do-not-copy");
    const manifest = await inventoryMigrationSource(policy);
    const destination = join(base, "snapshot");
    expect(await createVerifiedSnapshot(policy, manifest, destination)).toEqual(manifest);
    expect(await readdir(destination)).toEqual(["accounts.json", "ciphertext.bin"]);
    expect(await readFile(join(destination, "accounts.json"))).toEqual(Buffer.alloc(280_047));
    expect(await readFile(join(destination, "ciphertext.bin"), "utf8")).toBe("abc");
    expect(await readFile(join(root, "ciphertext.bin"), "utf8")).toBe("abc");
  });
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "migration-manifest-"));
  temporaryRoots.push(base);
  const root = join(base, "source");
  await mkdir(root);
  const policy: MigrationSourcePolicy = {
    root,
    files: [
      { relativePath: "accounts.json", kind: "portal-metadata" },
      { relativePath: "ciphertext.bin", kind: "protected-secret" },
    ],
  };
  await writeFile(join(root, "accounts.json"), Buffer.alloc(280_047));
  await writeFile(join(root, "ciphertext.bin"), "abc");
  return { base, root, policy };
}

describe("migration inventory", () => {
  it.each(["../outside", "dir/../../outside", "/outside", "C:/outside", "C:outside", "accounts.json:stream",
    "dir\\accounts.json", "./accounts.json", "dir//accounts.json", "NUL", "accounts.json.", "accounts.json "])(
    "rejects unsafe manifest path %s before reading it", async (relativePath) => {
      const { root, base } = await fixture();
      await writeFile(join(base, "outside"), "not-in-scope");
      await expect(inventoryMigrationSource({ root, files: [{ relativePath, kind: "opaque" }] }))
        .rejects.toMatchObject({ code: "UNSAFE_PATH" });
    },
  );

  it("requires an explicit absolute non-volume root and unambiguous file allowlist", async () => {
    const { policy } = await fixture();
    for (const root of [".", "", resolve(policy.root).slice(0, 3)]) {
      await expect(inventoryMigrationSource({ ...policy, root })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    }
    await expect(inventoryMigrationSource({ ...policy, files: [...policy.files, policy.files[0]!] }))
      .rejects.toMatchObject({ code: "INVALID_POLICY" });
    await expect(inventoryMigrationSource({
      ...policy, files: [policy.files[0]!, { ...policy.files[0]!, relativePath: "ACCOUNTS.JSON" }],
    })).rejects.toMatchObject({ code: "INVALID_POLICY" });
  });

  it("refuses junctions in the source root or its ancestors and linked source directories", async () => {
    const { root, base, policy } = await fixture();
    const alias = join(base, "alias");
    await symlink(root, alias, "junction");
    await expect(inventoryMigrationSource({ ...policy, root: alias })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await mkdir(join(root, "nested"));
    await writeFile(join(root, "nested", "file"), "abc");
    await expect(inventoryMigrationSource({
      root: join(alias, "nested"), files: [{ relativePath: "file", kind: "opaque" }],
    })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await symlink(base, join(root, "escape"), "junction");
    await expect(inventoryMigrationSource({
      root, files: [{ relativePath: "escape/source/accounts.json", kind: "portal-metadata" }],
    })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it("refuses hard-linked files that could alias files outside the policy", async () => {
    const { base, root, policy } = await fixture();
    await link(join(root, "ciphertext.bin"), join(base, "alias.bin"));
    await expect(inventoryMigrationSource(policy)).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });

  it.each([
    ["portal-metadata", '{"version":2,"records":[]}', "valid"],
    ["portal-metadata", '{"version":1,"records":[]}', "valid"],
    ["portal-metadata", '{"version":7,"records":[]}', "invalid-schema"],
    ["portal-metadata", '{"private":"DO-NOT-REPORT"', "invalid-json"],
    ["provider-metadata", '[{"id":"one","displayName":"One","baseUrl":"https://one.invalid"}]', "valid"],
    ["provider-metadata", '{"password":"DO-NOT-REPORT"}', "invalid-schema"],
    ["session", '{"text":"DO-NOT-REPORT"}', "not-inspected"],
  ] as const)("validates %s without returning parsed data (%s)", async (kind, content, validation) => {
    const { root } = await fixture();
    await writeFile(join(root, "metadata"), content);
    const manifest = await inventoryMigrationSource({ root, files: [{ relativePath: "metadata", kind }] });
    expect(manifest.files[0]?.validation).toBe(validation);
    expect(JSON.stringify(manifest)).not.toContain("DO-NOT-REPORT");
  });

  it("records the 280047-byte NUL corruption and hashes opaque bytes without exposing values or writing files", async () => {
    const { root, policy } = await fixture();
    const before = await readdir(root);
    const manifest = await inventoryMigrationSource(policy, new Date("2026-09-15T00:00:00Z"));
    expect(manifest).toMatchObject({
      version: 1,
      createdAt: "2026-09-15T00:00:00.000Z",
      files: [
        { relativePath: "accounts.json", byteLength: 280_047, kind: "portal-metadata", validation: "nul-bytes" },
        {
          relativePath: "ciphertext.bin", byteLength: 3, kind: "protected-secret", validation: "not-inspected",
          sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
        },
      ],
    });
    expect(manifest.files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.keys(manifest.files[1]!).sort()).toEqual(
      ["byteLength", "kind", "relativePath", "sha256", "validation"],
    );
    expect(JSON.stringify(manifest)).not.toContain(root);
    expect(await readFile(join(root, "accounts.json"))).toEqual(Buffer.alloc(280_047));
    expect(await readdir(root)).toEqual(before);
  });
});
