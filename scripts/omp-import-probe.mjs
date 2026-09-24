#!/usr/bin/env node
// Static, read-only probe of the pinned OMP checkout's session-import surface.
//
// It NEVER runs OMP, never builds it, never touches the network, and never
// reads a real session home. It only reads a few source files of the pinned
// checkout (.scratch/omp @ 0c6c981e) as TEXT and asserts the facts that decide
// whether a fixture-only AUTOMATED import is reachable from this Node harness.
//
// Output: a JSON verdict on stdout. Exits 0 when the verified facts still match
// the recorded blocker (or when the checkout is absent — nothing to verify),
// and non-zero if a fact drifted, so the blocker cannot rot silently.
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const omp = join(repoRoot, ".scratch", "omp", "packages", "coding-agent");
const EXPECTED_COMMIT = "0c6c981ee5838d97700180383077eb0a3790637c";

async function readText(relative) {
  try {
    return await readFile(join(omp, relative), "utf8");
  } catch {
    return undefined;
  }
}

async function main() {
  const factory = await readText("src/session/foreign-session-import.ts");
  const codexStore = await readText("src/session/codex-session-store.ts");
  const claudeStore = await readText("src/session/claude-session-store.ts");
  if (factory === undefined || codexStore === undefined || claudeStore === undefined) {
    // The pinned checkout is not present here — nothing to verify, not a failure.
    console.log(JSON.stringify({ skipped: true, reason: "pinned-omp-checkout-absent" }, null, 2));
    return 0;
  }

  const facts = {
    // The Node-reachable CLI factory builds the stores with NO explicit root,
    // so it can only read the home default (~/.codex, ~/.claude).
    cliFactoryIgnoresExplicitRoot:
      /new\s+CodexSessionStore\(\)/.test(factory) && /new\s+ClaudeSessionStore\(\)/.test(factory),
    // The classes themselves DO accept an explicit root — but reaching them
    // means bypassing the CLI.
    codexStoreAcceptsExplicitRoot: /constructor\(rootDirectory[^)]*=\s*path\.join\(os\.homedir\(\)/.test(codexStore),
    claudeStoreAcceptsExplicitRoot: /constructor\(root[^)]*=\s*resolveClaudePaths\(\)/.test(claudeStore),
    // ...and the Codex store hard-imports bun:sqlite, so it cannot run under
    // this Node/vitest harness without a Bun runtime executing upstream code.
    codexStoreRequiresBunSqlite: /import\s*\{\s*Database\s*\}\s*from\s*"bun:sqlite"/.test(codexStore),
    // The import chain reads/transforms files only — no network, no inference.
    importChainHasNoFetch:
      !/\bfetch\s*\(/.test(factory) && !/Authorization|apiKey|https?:\/\//.test(factory),
    // Target isolation IS supported at the library level (sessionDir option).
    importSupportsIsolatedSessionDir: /sessionDir\??\s*:/.test(factory),
  };

  const expected = {
    cliFactoryIgnoresExplicitRoot: true,
    codexStoreAcceptsExplicitRoot: true,
    claudeStoreAcceptsExplicitRoot: true,
    codexStoreRequiresBunSqlite: true,
    importChainHasNoFetch: true,
    importSupportsIsolatedSessionDir: true,
  };

  const drift = Object.keys(expected).filter((key) => facts[key] !== expected[key]);
  const verdict = {
    pinnedCommit: EXPECTED_COMMIT,
    automatedFixtureImportFromNodeHarness: "unsupported",
    reasons: [
      "cli-factory-hardcodes-home-source-root (createForeignSessionStore constructs stores with no rootDirectory)",
      "codex-store-requires-bun-sqlite (cannot run under the Node/vitest harness)",
      "cli-from-codex-from-claude-are-interactive-pickers (exit 0 != import)",
    ],
    verifiedFacts: facts,
    drift,
  };
  console.log(JSON.stringify(verdict, null, 2));
  return drift.length === 0 ? 0 : 1;
}

main().then((code) => process.exit(code), (error) => {
  console.error(String(error));
  process.exit(2);
});
