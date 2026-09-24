import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { dryRunTranscriptInventory } from "../src/migration/transcript-inventory.js";
import {
  planTranscriptImport,
  stageManifest,
  type ImportManifest,
  type ImportSelection,
  type ImportTargetScope,
} from "../src/migration/transcript-import-plan.js";
import { buildImportPreview } from "../src/migration/transcript-import-preview.js";

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
