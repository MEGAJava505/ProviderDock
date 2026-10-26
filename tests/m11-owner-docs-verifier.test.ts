import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Gate tests for scripts/m11/verify-owner-docs.mjs. The verifier is the only automated
// check that the Windows-only owner documents are executable at all, so it must be
// proven to fire on known defects, not merely to report zero findings.

const repoRoot = resolve(__dirname, "..");
const script = join(repoRoot, "scripts", "m11", "verify-owner-docs.mjs");
const docsDir = join(repoRoot, "docs", "omp-migration");

type Run = { status: number; stdout: string };

function run(args: string[]): Run {
  try {
    const stdout = execFileSync(process.execPath, [script, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (err) {
    const e = err as { status?: number; stdout?: string };
    return { status: e.status ?? -1, stdout: e.stdout ?? "" };
  }
}

describe("m11 owner-docs verifier", () => {
  it(
    "passes its own detector selftest",
    () => {
      const out = run(["--selftest"]);
      expect(out.status).toBe(0);
      expect(out.stdout).toContain("selftest: OK");
    },
    30_000,
  );

  it(
    "passes on the current documents",
    () => {
      const out = run([]);
      expect(out.stdout).not.toContain("FAIL");
      expect(out.status).toBe(0);
    },
    30_000,
  );

  it(
    "catches the real pre-fix revisions and stays clean on HEAD",
    () => {
      const out = run(["--history"]);
      expect(out.stdout).toContain("ok   f79908a");
      expect(out.stdout).toContain("ok   27d1459");
      expect(out.status).toBe(0);
    },
    60_000,
  );

  it(
    "fails when a document is missing",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "m11-docs-missing-"));
      try {
        const out = run(["--docs", dir]);
        expect(out.status).toBe(1);
        expect(out.stdout).toContain("missing-doc");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "fails when an executable path is rewritten as a PowerShell redirect",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "m11-docs-corrupt-"));
      try {
        cpSync(docsDir, dir, { recursive: true });
        const full = join(dir, "M11_FULL_EXECUTION_TASK.md");
        writeFileSync(full, readFileSync(full, "utf8").replace(/\$owned/g, "<OWNED>"));
        const out = run(["--docs", dir]);
        expect(out.status).toBe(1);
        expect(out.stdout).toContain("powershell-redirect-char");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("rejects --docs without a value", () => {
    const out = run(["--docs", "--json"]);
    expect(out.status).toBe(2);
  });
});
