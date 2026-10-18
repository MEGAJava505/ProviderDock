// Physical consolidation (M5.3) of three transcript-migration test files into one:
//   - tests/transcript-inventory.test.ts      (dry-run scan)
//   - tests/transcript-import-plan.test.ts    (plan + manifest persistence)
//   - tests/transcript-import-preview.test.ts (read-only preview + capability verdict)
// Every `it`/`it.each` scenario, setup/teardown, and negative path is preserved verbatim under a clearly
// separated top-level describe. Each block keeps its OWN helpers and its OWN target SCOPE (the plan block uses
// { providerId: "vsllm", accountId: "acct-1" }; the preview block uses { providerId: "vsllm" }) — these are
// intentionally distinct and are not merged. No assertion is rewritten; no test is skipped.
import { chmod, link, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dryRunTranscriptInventory,
  type TranscriptInventoryEntry,
} from "../src/migration/transcript-inventory.js";
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
import { buildImportPreview } from "../src/migration/transcript-import-preview.js";
import {
  isAutomatedNativeImportSupported,
  OMP_IMPORT_CAPABILITY,
  PINNED_OMP_COMMIT,
  type OmpImportCapability,
} from "../src/migration/omp-import-capability.js";

// ============================================================================
// Block 1 — dry-run transcript inventory (from tests/transcript-inventory.test.ts)
// ============================================================================
describe("dry-run transcript inventory", () => {
  // The only keys a caller (or a UI) is ever allowed to see. The scan must never
  // surface message content, tool arguments, tokens, or cookies.
  const ALLOWED_KEYS = new Set([
    "client",
    "relativePath",
    "sizeBytes",
    "sha256",
    "status",
    "reason",
    "sessionId",
  ]);

  async function root(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `transcript-inventory-${prefix}-`));
  }

  async function write(base: string, relative: string, contents: string): Promise<void> {
    const full = join(base, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, contents);
  }

  function byPath(entries: readonly TranscriptInventoryEntry[]): Map<string, TranscriptInventoryEntry> {
    return new Map(entries.map((entry) => [entry.relativePath, entry]));
  }

  describe("dry-run transcript inventory (fixtures only)", () => {
    it("recognizes well-formed Claude and Codex transcripts and derives their ids", async () => {
      const claudeHome = await root("claude");
      await write(
        claudeHome,
        "providers/openai/projects/proj/a.jsonl",
        `${JSON.stringify({ sessionId: "claude-1", message: { role: "user", content: "hi" } })}\n`,
      );
      const codexHome = await root("codex");
      await write(
        codexHome,
        "sessions/b.jsonl",
        `${JSON.stringify({ payload: { session_id: "codex-1", model: "x" } })}\n`,
      );

      const result = await dryRunTranscriptInventory({
        roots: [
          { client: "claude-code", path: claudeHome },
          { client: "codex", path: codexHome },
        ],
      });

      expect(result.dryRun).toBe(true);
      const entries = byPath(result.entries);
      const claude = entries.get("providers/openai/projects/proj/a.jsonl");
      expect(claude?.status).toBe("recognized");
      expect(claude?.client).toBe("claude-code");
      expect(claude?.sessionId).toBe("claude-1");
      expect(claude?.sha256).toMatch(/^[0-9a-f]{64}$/);
      const codex = entries.get("sessions/b.jsonl");
      expect(codex?.status).toBe("recognized");
      expect(codex?.sessionId).toBe("codex-1");
    });
    it("classifies empty, corrupt, and non-transcript files without importing them", async () => {
      const home = await root("mixed");
      await write(home, "empty.jsonl", "   \n\n");
      await write(home, "corrupt.jsonl", "{ this is not json\nalso broken }\n");
      await write(home, "notes.txt", "not a transcript at all");

      const result = await dryRunTranscriptInventory({ roots: [{ client: "codex", path: home }] });
      const entries = byPath(result.entries);
      expect(entries.get("empty.jsonl")?.status).toBe("empty");
      expect(entries.get("corrupt.jsonl")?.status).toBe("corrupt");
      expect(entries.get("notes.txt")?.status).toBe("unsupported");
      expect(entries.get("notes.txt")?.reason).toBe("not-a-jsonl-transcript");
    });

    it("flags a second file sharing a session id as duplicate, keeping the first recognized", async () => {
      const home = await root("dupe");
      const row = `${JSON.stringify({ sessionId: "same-id" })}\n`;
      await write(home, "first.jsonl", row);
      await write(home, "second.jsonl", row);

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "claude-code", path: home }],
      });
      const map = byPath(entries);
      expect(map.get("first.jsonl")?.status).toBe("recognized");
      expect(map.get("second.jsonl")?.status).toBe("duplicate");
      expect(map.get("second.jsonl")?.reason).toBe("session-id-already-seen");
    });

    it("produces identical output when the same dry-run is repeated (idempotent, no writes)", async () => {
      const home = await root("repeat");
      await write(home, "a.jsonl", `${JSON.stringify({ sessionId: "r-1" })}\n`);
      await write(home, "b.jsonl", "garbage\n");
      const roots = [{ client: "claude-code" as const, path: home }];

      const first = await dryRunTranscriptInventory({ roots });
      const second = await dryRunTranscriptInventory({ roots });
      expect(second).toEqual(first);
    });
    it("does not read files above the read limit, but still inventories them", async () => {
      const home = await root("limit");
      await write(home, "big.jsonl", `${JSON.stringify({ sessionId: "big" })}\n`);

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "claude-code", path: home }],
        maxFileBytes: 4,
      });
      const big = byPath(entries).get("big.jsonl");
      expect(big?.status).toBe("unsupported");
      expect(big?.reason).toBe("exceeds-read-limit");
      expect(big?.sha256).toBeUndefined();
    });

    it("never exposes anything beyond the allowed metadata keys or the file's secrets", async () => {
      const home = await root("secret");
      const secret = "TOP-SECRET-TOKEN-do-not-leak";
      await write(
        home,
        "s.jsonl",
        `${JSON.stringify({ sessionId: "s-1", message: { role: "user", content: secret }, apiKey: secret })}\n`,
      );

      const result = await dryRunTranscriptInventory({
        roots: [{ client: "claude-code", path: home }],
      });
      expect(JSON.stringify(result)).not.toContain(secret);
      for (const entry of result.entries) {
        for (const key of Object.keys(entry)) expect(ALLOWED_KEYS.has(key)).toBe(true);
      }
    });
    it("records a symlink but never follows it out of the root", async () => {
      const home = await root("escape");
      const outside = await root("outside");
      await write(outside, "secret.jsonl", `${JSON.stringify({ sessionId: "leaked" })}\n`);
      const linkPath = join(home, "link.jsonl");
      let symlinkSupported = true;
      try {
        await symlink(join(outside, "secret.jsonl"), linkPath, "file");
      } catch {
        symlinkSupported = false; // Windows without privilege/developer mode.
      }
      // A real file so the scan still returns something regardless of symlink support.
      await write(home, "real.jsonl", `${JSON.stringify({ sessionId: "real" })}\n`);

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "codex", path: home }],
      });
      const map = byPath(entries);
      expect(map.get("real.jsonl")?.status).toBe("recognized");
      // The outside file's own id must never appear — the link was not traversed.
      expect(entries.some((entry) => entry.sessionId === "leaked")).toBe(false);
      if (symlinkSupported) {
        expect(map.get("link.jsonl")?.status).toBe("unsupported");
        expect(map.get("link.jsonl")?.reason).toBe("symlink-not-followed");
      }
    });
  });

  describe("dry-run transcript inventory — boundary hardening", () => {
    it("enforces the read limit on bytes actually read, not just the stat size", async () => {
      const home = await root("read-limit");
      // 300 bytes of real content; a 64-byte cap must reject it on read.
      await write(home, "big.jsonl", `${JSON.stringify({ sessionId: "x", pad: "y".repeat(260) })}\n`);
      await write(home, "small.jsonl", `${JSON.stringify({ sessionId: "s" })}\n`);

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "codex", path: home }],
        maxFileBytes: 64,
      });
      const map = byPath(entries);
      expect(map.get("big.jsonl")?.status).toBe("unsupported");
      expect(map.get("big.jsonl")?.reason).toBe("exceeds-read-limit");
      expect(map.get("big.jsonl")?.sha256).toBeUndefined();
      expect(map.get("small.jsonl")?.status).toBe("recognized");
    });
    it("fail-closes an unreadable file to unsupported instead of crashing the scan", async () => {
      const home = await root("unreadable");
      await write(home, "ok.jsonl", `${JSON.stringify({ sessionId: "ok" })}\n`);
      const locked = join(home, "locked.jsonl");
      await write(home, "locked.jsonl", `${JSON.stringify({ sessionId: "locked" })}\n`);
      let unreadable = true;
      try {
        await chmod(locked, 0o000);
        // On Windows chmod does not remove read access; detect and skip that leg.
        await import("node:fs/promises").then((fs) => fs.readFile(locked)).then(
          () => {
            unreadable = false;
          },
          () => undefined,
        );
      } catch {
        unreadable = false;
      }

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "claude-code", path: home }],
      });
      const map = byPath(entries);
      expect(map.get("ok.jsonl")?.status).toBe("recognized");
      if (unreadable) {
        expect(map.get("locked.jsonl")?.status).toBe("unsupported");
        expect(map.get("locked.jsonl")?.reason).toBe("read-failed");
        await chmod(locked, 0o600); // Let the temp dir be cleaned up.
      }
    });
    it("never traverses a directory junction/symlink that resolves outside the root", async () => {
      const home = await root("junction");
      const outside = await root("junction-outside");
      await write(outside, "secret.jsonl", `${JSON.stringify({ sessionId: "leaked-via-dir" })}\n`);
      await write(home, "real.jsonl", `${JSON.stringify({ sessionId: "real" })}\n`);
      const linkDir = join(home, "linked");
      let linked = true;
      try {
        await symlink(outside, linkDir, "junction");
      } catch {
        try {
          await symlink(outside, linkDir, "dir");
        } catch {
          linked = false;
        }
      }

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "codex", path: home }],
      });
      expect(byPath(entries).get("real.jsonl")?.status).toBe("recognized");
      // Regardless of how the escape link was created, its target must be unread.
      expect(entries.some((entry) => entry.sessionId === "leaked-via-dir")).toBe(false);
      if (linked) {
        expect(entries.every((entry) => !entry.relativePath.startsWith("linked/"))).toBe(true);
      }
    });
    it("detects the same session id appearing in two different roots deterministically", async () => {
      const homeA = await root("root-a");
      const homeB = await root("root-b");
      const row = `${JSON.stringify({ sessionId: "shared-across-roots" })}\n`;
      await write(homeA, "a.jsonl", row);
      await write(homeB, "b.jsonl", row);
      const roots = [
        { client: "claude-code" as const, path: homeA },
        { client: "claude-code" as const, path: homeB },
      ];

      const first = await dryRunTranscriptInventory({ roots });
      const second = await dryRunTranscriptInventory({ roots });
      expect(second).toEqual(first);
      const statuses = first.entries.map((entry) => entry.status);
      expect(statuses).toEqual(["recognized", "duplicate"]);
    });

    it("fail-closes a hard-linked (aliased) transcript instead of vouching for its bytes", async () => {
      // A hard link is a deterministic, controlled substitution of trust: the path
      // no longer names a single unique object, so the scanner cannot vouch for it.
      const home = await root("aliased");
      await write(home, "a.jsonl", `${JSON.stringify({ sessionId: "aliased" })}\n`);
      let linked = true;
      try {
        await link(join(home, "a.jsonl"), join(home, "b.jsonl"));
      } catch {
        linked = false; // Some filesystems refuse hard links; skip the assertion.
      }

      const { entries } = await dryRunTranscriptInventory({
        roots: [{ client: "claude-code", path: home }],
      });
      if (linked) {
        const map = byPath(entries);
        for (const relative of ["a.jsonl", "b.jsonl"]) {
          expect(map.get(relative)?.status).toBe("unsupported");
          expect(map.get(relative)?.reason).toBe("aliased-hard-link");
          expect(map.get(relative)?.sha256).toBeUndefined();
        }
      }
    });
  });
});

// ============================================================================
// Block 2 — transcript import plan + manifest persistence (from tests/transcript-import-plan.test.ts)
// ============================================================================
describe("transcript import plan + manifest persistence", () => {
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
});

// ============================================================================
// Block 3 — read-only import preview + OMP capability verdict (from tests/transcript-import-preview.test.ts)
// ============================================================================
describe("read-only import preview + OMP capability verdict", () => {
  const SCOPE: ImportTargetScope = { providerId: "vsllm" };

  async function home(prefix: string): Promise<string> {
    return mkdtemp(join(tmpdir(), `import-preview-${prefix}-`));
  }

  async function planFrom(dir: string, selection: readonly ImportSelection[], existingManifest?: ImportManifest) {
    const inventory = await dryRunTranscriptInventory({ roots: [{ client: "claude-code", path: dir }] });
    return planTranscriptImport({
      inventory,
      selection,
      targetScope: SCOPE,
      ...(existingManifest !== undefined ? { existingManifest } : {}),
    });
  }

  describe("read-only import preview (fixtures only)", () => {
    it("frames a ready candidate as a staged context transfer, never a restore", async () => {
      const dir = await home("ready");
      await writeFile(join(dir, "a.jsonl"), `${JSON.stringify({ sessionId: "s-1", message: { role: "user", content: "secret text" } })}\n`);
      const plan = await planFrom(dir, [{ client: "claude-code", relativePath: "a.jsonl" }]);

      const preview = buildImportPreview(plan);
      expect(preview.promisesFullRestore).toBe(false);
      expect(preview.summary.contextTransferReady).toBe(1);
      const row = preview.rows[0]!;
      expect(row.disposition).toBe("context-transfer-ready");
      expect(row.nativeResume).toBe("unsupported"); // Old CLI resume is never offered.
      expect(row.sessionId).toBe("s-1");
      expect(row.ompIdentity).toBeUndefined(); // Nothing imported yet.
    });

    it("reflects the verified blocker: automated native import is unsupported", async () => {
      const dir = await home("blocked");
      await writeFile(join(dir, "a.jsonl"), `${JSON.stringify({ sessionId: "s-1" })}\n`);
      const plan = await planFrom(dir, [{ client: "claude-code", relativePath: "a.jsonl" }]);
      expect(buildImportPreview(plan).automatedNativeImport).toBe("unsupported");
    });
    it("surfaces every negative disposition without revealing transcript content", async () => {
      const dir = await home("negative");
      const secret = "DO-NOT-LEAK-abc123";
      await writeFile(join(dir, "corrupt.jsonl"), `{ broken ${secret}\n`);
      await writeFile(join(dir, "empty.jsonl"), "  \n");
      await writeFile(join(dir, "notes.txt"), secret);
      const plan = await planFrom(dir, [
        { client: "claude-code", relativePath: "corrupt.jsonl" },
        { client: "claude-code", relativePath: "empty.jsonl" },
        { client: "claude-code", relativePath: "notes.txt" },
      ]);

      const preview = buildImportPreview(plan);
      const byPath = new Map(preview.rows.map((row) => [row.relativePath, row]));
      expect(byPath.get("corrupt.jsonl")!.disposition).toBe("corrupt");
      expect(byPath.get("empty.jsonl")!.disposition).toBe("skipped");
      expect(byPath.get("notes.txt")!.disposition).toBe("unsupported");
      // No transcript content, and no absolute paths, ever appear in the view.
      const serialized = JSON.stringify(preview);
      expect(serialized).not.toContain(secret);
      expect(serialized).not.toContain(dir);
    });

    it("lists the old capabilities a context transfer never auto-activates", async () => {
      const dir = await home("rights");
      await writeFile(join(dir, "a.jsonl"), `${JSON.stringify({ sessionId: "s-1" })}\n`);
      const preview = buildImportPreview(await planFrom(dir, [{ client: "claude-code", relativePath: "a.jsonl" }]));
      for (const capability of ["permissions", "mcp-servers", "extensions", "hooks", "provider-credentials", "oauth-tokens", "project-bindings"]) {
        expect(preview.notCarried).toContain(capability);
      }
    });
    it("shows a prior import as already-imported with its verified OMP identity", async () => {
      const dir = await home("already");
      await writeFile(join(dir, "a.jsonl"), `${JSON.stringify({ sessionId: "s-1" })}\n`);
      const first = await planFrom(dir, [{ client: "claude-code", relativePath: "a.jsonl" }]);
      const staged = stageManifest(first);
      const committed: ImportManifest = {
        ...staged,
        items: staged.items.map((item) => ({ ...item, state: "imported" as const, ompSessionId: "omp-42" })),
      };
      const preview = buildImportPreview(await planFrom(dir, [{ client: "claude-code", relativePath: "a.jsonl" }], committed));
      expect(preview.summary.alreadyImported).toBe(1);
      expect(preview.rows[0]!.disposition).toBe("already-imported");
      expect(preview.rows[0]!.ompIdentity).toBe("omp-42");
    });
  });

  describe("OMP import capability verdict", () => {
    it("reports the automated native import as unsupported with content-free blockers", () => {
      expect(OMP_IMPORT_CAPABILITY.route).toBe("unsupported-automated-native-import");
      expect(isAutomatedNativeImportSupported()).toBe(false);
      expect(OMP_IMPORT_CAPABILITY.blockers).toContain("cli-factory-hardcodes-home-source-root");
      expect(OMP_IMPORT_CAPABILITY.blockers).toContain("codex-store-requires-bun-sqlite-runtime");
      // Reasons must stay identifiers, never transcript content or absolute paths.
      for (const blocker of OMP_IMPORT_CAPABILITY.blockers) {
        expect(blocker).toMatch(/^[a-z0-9-]+$/);
      }
    });

    it("records only scoped importer facts, without claiming network isolation", () => {
      expect(OMP_IMPORT_CAPABILITY.supported.explicitSourceRootAtClassLevel).toBe(true);
      expect(OMP_IMPORT_CAPABILITY.supported.isolatedTargetSessionDir).toBe(true);
      expect(OMP_IMPORT_CAPABILITY.supported).toHaveProperty("importFactoryHasNoFetch", true);
      expect(OMP_IMPORT_CAPABILITY.supported).not.toHaveProperty("noNetworkOrInferenceOnImport");
      expect(OMP_IMPORT_CAPABILITY.pinnedCommit).toBe(PINNED_OMP_COMMIT);
    });

    it("is frozen so a caller cannot quietly upgrade the verdict to supported", () => {
      expect(Object.isFrozen(OMP_IMPORT_CAPABILITY)).toBe(true);
      expect(() => {
        (OMP_IMPORT_CAPABILITY as { route: string }).route = "supported-context-transfer-adapter";
      }).toThrow();
    });

    it("would report supported only if a route with zero blockers were ever provided", () => {
      const hypothetical: OmpImportCapability = {
        ...OMP_IMPORT_CAPABILITY,
        route: "supported-context-transfer-adapter",
        blockers: [],
      };
      expect(isAutomatedNativeImportSupported(hypothetical)).toBe(true);
      // A route flip alone, with blockers still present, must NOT read as supported.
      expect(
        isAutomatedNativeImportSupported({
          ...OMP_IMPORT_CAPABILITY,
          route: "supported-context-transfer-adapter",
        }),
      ).toBe(false);
    });
  });
});
