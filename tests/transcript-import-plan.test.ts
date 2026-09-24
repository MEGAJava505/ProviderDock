import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dryRunTranscriptInventory } from "../src/migration/transcript-inventory.js";
import {
  commitStagedManifest,
  ImportManifestError,
  planTranscriptImport,
  readImportManifest,
  stageManifest,
  writeImportManifest,
  type ImportManifest,
  type ImportSelection,
  type ImportTargetScope,
} from "../src/migration/transcript-import-plan.js";

// A synthetic target; never a live provider binding, never carries secrets.
const SCOPE: ImportTargetScope = { providerId: "vsllm", accountId: "acct-1" };

async function root(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `import-plan-${prefix}-`));
}

async function claudeRow(sessionId: string): Promise<string> {
  return `${JSON.stringify({ sessionId, message: { role: "user", content: "hi" } })}\n`;
}

// Inventory a fixture home and plan an import of an explicit selection.
async function planFrom(
  home: string,
  selection: readonly ImportSelection[],
  existingManifest?: ImportManifest,
) {
  const inventory = await dryRunTranscriptInventory({
    roots: [{ client: "claude-code", path: home }],
  });
  return planTranscriptImport({
    inventory,
    selection,
    targetScope: SCOPE,
    ...(existingManifest !== undefined ? { existingManifest } : {}),
  });
}

describe("transcript import plan (fixtures only)", () => {
  it("marks a recognized, selected transcript ready and stages a manifest without importing", async () => {
    const home = await root("ready");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));

    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    expect(plan.items).toHaveLength(1);
    const item = plan.items[0]!;
    expect(item.status).toBe("ready");
    expect(item.sessionId).toBe("s-1");
    expect(item.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(item.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(item.ompSessionId).toBeUndefined(); // Never set at planning time.

    const manifest = stageManifest(plan);
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]!.state).toBe("staged"); // Never "imported" here.
    expect(manifest.items[0]!.ompSessionId).toBeUndefined();
  });

  it.each([
    { name: "empty", relative: "e.jsonl", body: "  \n", expected: "skipped" },
    { name: "corrupt", relative: "c.jsonl", body: "{ not json\n", expected: "corrupt" },
    { name: "non-transcript", relative: "n.txt", body: "nope", expected: "unsupported" },
  ])("carries the inventory status through for a $name source", async ({ relative, body, expected }) => {
    const home = await root("status");
    await writeFile(join(home, relative), body);

    const plan = await planFrom(home, [{ client: "claude-code", relativePath: relative }]);
    expect(plan.items[0]!.status).toBe(expected);
    // A non-ready item is never staged into the manifest.
    expect(stageManifest(plan).items).toHaveLength(0);
  });

  it("only plans explicitly selected sources, ignoring the rest of the inventory", async () => {
    const home = await root("select");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-a"));
    await writeFile(join(home, "b.jsonl"), await claudeRow("s-b"));

    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "b.jsonl" }]);
    expect(plan.items.map((item) => item.relativePath)).toEqual(["b.jsonl"]);
  });

  it("flags a second selected source sharing a session id as duplicate, never overwriting", async () => {
    const home = await root("dupe");
    const row = await claudeRow("shared");
    await writeFile(join(home, "first.jsonl"), row);
    await writeFile(join(home, "second.jsonl"), row);

    const plan = await planFrom(home, [
      { client: "claude-code", relativePath: "first.jsonl" },
      { client: "claude-code", relativePath: "second.jsonl" },
    ]);
    const byName = new Map(plan.items.map((item) => [item.relativePath, item]));
    // Inventory already dedupes identical content by session id; both signals agree.
    expect(byName.get("first.jsonl")!.status).toBe("ready");
    expect(byName.get("second.jsonl")!.status).toBe("duplicate");
    expect(stageManifest(plan).items).toHaveLength(1);
  });

  it("re-running against a committed manifest reports already-imported, not a duplicate row", async () => {
    const home = await root("rerun");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));
    const first = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);

    // Simulate a later stage having actually imported and verified the session.
    const staged = stageManifest(first);
    const committed: ImportManifest = {
      ...staged,
      items: staged.items.map((item) => ({ ...item, state: "imported" as const, ompSessionId: "omp-1" })),
    };

    const second = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }], committed);
    expect(second.items[0]!.status).toBe("already-imported");
    expect(second.items[0]!.ompSessionId).toBe("omp-1");
    // The re-run stages nothing new: no duplicate manifest entry is produced.
    expect(stageManifest(second).items).toHaveLength(0);
  });

  it("treats a changed source at the same path as a new candidate, not a silent overwrite", async () => {
    const home = await root("changed");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));
    const first = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    const committed: ImportManifest = {
      ...stageManifest(first),
      items: stageManifest(first).items.map((item) => ({ ...item, state: "imported" as const, ompSessionId: "omp-1" })),
    };

    // Rewrite the file: same path, different bytes → different content hash.
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1-edited"));
    const second = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }], committed);
    // New hash → new idempotency key → ready again (the old import is untouched).
    expect(second.items[0]!.status).toBe("ready");
    expect(second.items[0]!.idempotencyKey).not.toBe(committed.items[0]!.idempotencyKey);
  });

  it("refuses a source whose session id a different committed entry already claims", async () => {
    const home = await root("claimed");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));
    const inventory = await dryRunTranscriptInventory({ roots: [{ client: "claude-code", path: home }] });
    // A committed manifest that owns session "s-1" under a DIFFERENT source key.
    const committed: ImportManifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      targetScope: SCOPE,
      items: [{
        client: "claude-code",
        relativePath: "other.jsonl",
        sha256: "f".repeat(64),
        sessionId: "s-1",
        idempotencyKey: "a".repeat(64),
        state: "imported",
        ompSessionId: "omp-x",
      }],
    };
    const plan = planTranscriptImport({
      inventory,
      selection: [{ client: "claude-code", relativePath: "a.jsonl" }],
      targetScope: SCOPE,
      existingManifest: committed,
    });
    expect(plan.items[0]!.status).toBe("duplicate");
    expect(plan.items[0]!.reason).toBe("session-id-claimed-by-manifest");
  });

  it("ignores a committed manifest recorded for a different target scope", async () => {
    const home = await root("scope");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));
    const first = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    const otherScope: ImportManifest = {
      ...stageManifest(first),
      targetScope: { providerId: "other-provider" },
      items: stageManifest(first).items.map((item) => ({ ...item, state: "imported" as const, ompSessionId: "x" })),
    };
    // Same source, but the manifest is for another scope → treated as fresh.
    const second = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }], otherScope);
    expect(second.items[0]!.status).toBe("ready");
  });
});

// Regression guard for the manifest-history-loss defect: staging a new source
// must ACCUMULATE onto prior confirmed entries of the same scope, never replace
// them with only this run's `ready` rows.
describe("cumulative manifest staging (history-preserving)", () => {
  async function committedImport(
    home: string,
    relative: string,
    sessionId: string,
    ompSessionId: string,
  ): Promise<ImportManifest> {
    await writeFile(join(home, relative), await claudeRow(sessionId));
    const plan = await planFrom(home, [{ client: "claude-code", relativePath: relative }]);
    const staged = stageManifest(plan);
    // Simulate a later verified import having stamped an OMP identity onto A.
    return {
      ...staged,
      items: staged.items.map((item) => ({ ...item, state: "imported" as const, ompSessionId })),
    };
  }

  it("preserves a prior imported entry when a new source is staged onto the same scope", async () => {
    const home = await root("cumulative");
    const committed = await committedImport(home, "a.jsonl", "s-a", "omp-a");

    await writeFile(join(home, "b.jsonl"), await claudeRow("s-b"));
    const next = await planFrom(home, [
      { client: "claude-code", relativePath: "a.jsonl" },
      { client: "claude-code", relativePath: "b.jsonl" },
    ], committed);
    expect(next.items.find((item) => item.relativePath === "a.jsonl")!.status).toBe("already-imported");
    expect(next.items.find((item) => item.relativePath === "b.jsonl")!.status).toBe("ready");

    const merged = commitStagedManifest(committed, next);
    const byName = new Map(merged.items.map((item) => [item.relativePath, item]));
    // The prior imported A survives; B is added as staged. History is never dropped.
    expect(merged.items).toHaveLength(2);
    expect(byName.get("a.jsonl")).toMatchObject({ state: "imported", ompSessionId: "omp-a" });
    expect(byName.get("b.jsonl")).toMatchObject({ state: "staged" });
    expect(byName.get("b.jsonl")!.ompSessionId).toBeUndefined();
  });

  it("rejects merging a plan whose target scope differs from the committed manifest", async () => {
    const home = await root("cumulative-scope");
    const committed = await committedImport(home, "a.jsonl", "s-a", "omp-a");
    const foreign: ImportManifest = { ...committed, targetScope: { providerId: "other-provider" } };
    await writeFile(join(home, "b.jsonl"), await claudeRow("s-b"));
    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "b.jsonl" }]);
    expect(() => commitStagedManifest(foreign, plan)).toThrow(ImportManifestError);
  });

  it("never mints an imported state itself while the native importer is blocked", async () => {
    const home = await root("cumulative-mint");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-a"));
    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    const merged = commitStagedManifest(undefined, plan);
    expect(merged.items.every((item) => item.state === "staged")).toBe(true);
  });

  it("re-committing the same plan is idempotent, producing no duplicate manifest entries", async () => {
    const home = await root("cumulative-idem");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-a"));
    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    const once = commitStagedManifest(undefined, plan);
    const twice = commitStagedManifest(once, plan);
    expect(twice.items).toHaveLength(1);
    expect(twice.items[0]!.state).toBe("staged");
  });
});

describe("import manifest persistence (atomic, fail-closed)", () => {
  async function sampleManifest(): Promise<ImportManifest> {
    const home = await root("persist-src");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-1"));
    const plan = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    return stageManifest(plan, new Date("2026-09-24T00:00:00.000Z"));
  }

  it("writes atomically and re-reads an identical manifest, leaving no temp files", async () => {
    const dir = await root("persist");
    const manifest = await sampleManifest();
    const path = join(dir, "import-manifest.json");

    const written = await writeImportManifest(path, manifest);
    expect(written).toEqual(manifest);
    expect(await readImportManifest(path)).toEqual(manifest);
    // The atomic temp file is renamed or removed — only the target remains.
    const remaining = (await readFile(path, "utf8")).length;
    expect(remaining).toBeGreaterThan(0);
    await expect(stat(join(dir, "import-manifest.json.tmp"))).rejects.toBeDefined();
  });

  it("overwrites an existing manifest in place without corrupting it on the happy path", async () => {
    const dir = await root("overwrite");
    const path = join(dir, "m.json");
    const first = await sampleManifest();
    await writeImportManifest(path, first);
    const second: ImportManifest = { ...first, createdAt: "2026-09-25T00:00:00.000Z" };
    const written = await writeImportManifest(path, second);
    expect(written.createdAt).toBe("2026-09-25T00:00:00.000Z");
  });

  it("preserves an imported entry when a staged delta is written to the same file", async () => {
    const home = await root("persist-history-src");
    await writeFile(join(home, "a.jsonl"), await claudeRow("s-a"));
    const first = await planFrom(home, [{ client: "claude-code", relativePath: "a.jsonl" }]);
    const imported: ImportManifest = {
      ...stageManifest(first),
      items: stageManifest(first).items.map((item) => ({
        ...item, state: "imported" as const, ompSessionId: "omp-a",
      })),
    };
    const path = join(await root("persist-history-dst"), "m.json");
    await writeFile(path, JSON.stringify(imported)); // Synthetic prior import; no OMP run.

    await writeFile(join(home, "b.jsonl"), await claudeRow("s-b"));
    const next = await planFrom(home, [
      { client: "claude-code", relativePath: "a.jsonl" },
      { client: "claude-code", relativePath: "b.jsonl" },
    ], await readImportManifest(path));
    const written = await writeImportManifest(path, stageManifest(next));

    expect(written.items.map((item) => [item.relativePath, item.state])).toEqual([
      ["a.jsonl", "imported"], ["b.jsonl", "staged"],
    ]);
    expect(written.items[0]!.ompSessionId).toBe("omp-a");
    expect((await readImportManifest(path)).items).toEqual(written.items);
  });

  it("rejects replacing a manifest with one for a different target scope", async () => {
    const path = join(await root("persist-scope"), "m.json");
    const original = await writeImportManifest(path, await sampleManifest());
    const foreign: ImportManifest = { ...original, targetScope: { providerId: "other" } };

    await expect(writeImportManifest(path, foreign)).rejects.toMatchObject({
      code: "MANIFEST_SCOPE_MISMATCH",
    });
    expect(await readImportManifest(path)).toEqual(original);
  });

  it("refuses to mark a staged entry imported without verifying an OMP session", async () => {
    const path = join(await root("persist-unverified"), "m.json");
    const staged = await writeImportManifest(path, await sampleManifest());
    const fabricated: ImportManifest = {
      ...staged,
      items: staged.items.map((item) => ({
        ...item, state: "imported" as const, ompSessionId: "unverified-omp-id",
      })),
    };

    await expect(writeImportManifest(path, fabricated)).rejects.toMatchObject({
      code: "MANIFEST_UNVERIFIED_IMPORT",
    });
    expect(await readImportManifest(path)).toEqual(staged);
  });

  it("fails closed when the target directory does not exist, staging nothing", async () => {
    const manifest = await sampleManifest();
    const missing = join(await root("nowhere"), "no-such-subdir", "m.json");
    await expect(writeImportManifest(missing, manifest)).rejects.toBeInstanceOf(ImportManifestError);
  });

  it("leaves a prior committed manifest intact when a later write fails", async () => {
    const dir = await root("intact");
    const path = join(dir, "m.json");
    const original = await sampleManifest();
    await writeImportManifest(path, original);
    const before = await readFile(path, "utf8");

    // A structurally invalid manifest is rejected before any bytes are written.
    const invalid = { ...original, items: [{ ...original.items[0]!, state: "bogus" }] } as unknown as ImportManifest;
    await expect(writeImportManifest(path, invalid)).rejects.toBeDefined();
    expect(await readFile(path, "utf8")).toBe(before); // Untouched.
  });

  it("rejects a staged manifest item that carries an ompSessionId (schema invariant)", async () => {
    const dir = await root("invariant");
    const path = join(dir, "m.json");
    const manifest = await sampleManifest();
    const bad = {
      ...manifest,
      items: [{ ...manifest.items[0]!, state: "staged" as const, ompSessionId: "leaked" }],
    } as ImportManifest;
    await expect(writeImportManifest(path, bad)).rejects.toBeInstanceOf(ImportManifestError);
  });

  it("rejects an imported manifest item that lacks an ompSessionId (identity required)", async () => {
    const dir = await root("imported-identity");
    const path = join(dir, "m.json");
    const manifest = await sampleManifest();
    const bad = {
      ...manifest,
      items: [{
        client: "claude-code" as const,
        relativePath: "a.jsonl",
        idempotencyKey: "a".repeat(64),
        state: "imported" as const,
      }],
    } as unknown as ImportManifest;
    await expect(writeImportManifest(path, bad)).rejects.toBeInstanceOf(ImportManifestError);
  });

  it("fail-closes on a malformed manifest file rather than returning partial data", async () => {
    const dir = await root("malformed");
    const jsonPath = join(dir, "broken.json");
    await writeFile(jsonPath, "{ not json");
    await expect(readImportManifest(jsonPath)).rejects.toMatchObject({ code: "MANIFEST_INVALID_JSON" });

    const schemaPath = join(dir, "wrong-shape.json");
    await writeFile(schemaPath, JSON.stringify({ version: 2 }));
    await expect(readImportManifest(schemaPath)).rejects.toMatchObject({ code: "MANIFEST_INVALID_SCHEMA" });
  });

  it("round-trips a target directory containing spaces and Cyrillic characters", async () => {
    const dir = join(await root("unicode"), "Мои Сессии (backup)");
    const manifest = await sampleManifest();
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "манифест import.json");
    const written = await writeImportManifest(path, manifest);
    expect(written).toEqual(manifest);
    expect(await readImportManifest(path)).toEqual(manifest);
    await rm(dir, { recursive: true, force: true });
  });
});
