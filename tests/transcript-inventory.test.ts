import { chmod, link, mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  dryRunTranscriptInventory,
  type TranscriptInventoryEntry,
} from "../src/migration/transcript-inventory.js";

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
