#!/usr/bin/env node
// Static, read-only probe of the pinned OMP checkout's session-import surface.
//
// It NEVER runs OMP, never builds it, never touches the network, and never
// reads a real session home. It only reads source files of the pinned
// checkout (.scratch/omp @ 0c6c981e) as TEXT and asserts the facts that decide
// whether a fixture-only AUTOMATED import is reachable from this Node harness.
//
// Output: a JSON verdict on stdout. Exits 0 when the verified facts still match
// the recorded blocker (or when the checkout is absent — nothing to verify),
// and non-zero if a fact drifted, so the blocker cannot rot silently.
import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const checkout = resolve(repoRoot, ".scratch", "omp");
const omp = join(checkout, "packages", "coding-agent");
const EXPECTED_COMMIT = "0c6c981ee5838d97700180383077eb0a3790637c";
const IMPORT_SOURCES = [
  "src/session/foreign-session-import.ts",
  "src/session/codex-session-store.ts",
  "src/session/claude-session-store.ts",
  "src/session/session-manager.ts",
  "src/session/session-listing.ts",
  "src/session/session-loader.ts",
];

function git(args) {
  const env = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
  for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"]) delete env[key];
  return spawnSync("git", args, { cwd: checkout, env, encoding: "utf8", windowsHide: true, timeout: 10000 });
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readText(relative) {
  try {
    return await readFile(join(omp, relative), "utf8");
  } catch {
    return undefined;
  }
}

const CHECKOUT_STAT_ERROR_CODES = new Set([
  "EACCES", "EPERM", "ENOTDIR", "ELOOP", "ENAMETOOLONG", "EIO",
]);

// Classify the pinned checkout as present, genuinely absent, or inaccessible.
// Only a confirmed ENOENT means "not here"; any other stat() failure
// (permission denied, not-a-directory, symlink loop, I/O, or unknown) is an
// access error that must NOT be mistaken for absence — otherwise a present but
// unreadable checkout would be silently skipped instead of refused. The raw
// error never leaves this function: absence is a bare flag and every other
// failure is reduced to a single normalized, allowlisted errno code.
async function classifyCheckoutPresence(target) {
  try {
    await stat(target);
    return { state: "present" };
  } catch (error) {
    const raw = error && typeof error.code === "string" ? error.code : "";
    if (raw === "ENOENT") return { state: "absent" };
    return { state: "inaccessible", code: CHECKOUT_STAT_ERROR_CODES.has(raw) ? raw : "OTHER" };
  }
}

async function main() {
  const factory = await readText(IMPORT_SOURCES[0]);
  const codexStore = await readText(IMPORT_SOURCES[1]);
  const claudeStore = await readText(IMPORT_SOURCES[2]);
  const sessionManager = await readText(IMPORT_SOURCES[3]);
  const sessionListing = await readText(IMPORT_SOURCES[4]);
  const sessionLoader = await readText(IMPORT_SOURCES[5]);
  const missingSourceCount = [factory, codexStore, claudeStore, sessionManager, sessionListing, sessionLoader]
    .filter((text) => text === undefined).length;

  // Distinguish an entirely absent optional checkout from one that exists but
  // cannot be read. A wholly missing checkout (confirmed ENOENT) is nothing to
  // verify (explicit skip, exit 0). A checkout whose stat() fails for any other
  // reason is an access error, NOT absence, and must be a structural refusal
  // with a non-zero exit, so an unreadable tree is never silently reported as
  // "nothing here". A checkout that exists but is missing pinned sources is a
  // separate verified refusal. No paths, contents, raw error, or env ever leak:
  // only allowlisted structural fields and a normalized errno code are printed.
  const presence = await classifyCheckoutPresence(checkout);
  if (presence.state === "absent") {
    // The pinned checkout directory is not present here — nothing to verify, not a failure.
    console.log(JSON.stringify({ skipped: true, reason: "pinned-omp-checkout-absent" }, null, 2));
    return 0;
  }
  if (presence.state === "inaccessible") {
    const verdict = {
      pinnedCommit: EXPECTED_COMMIT,
      automatedFixtureImportFromNodeHarness: "unsupported",
      reason: "pinned-omp-checkout-inaccessible",
      verifiedFacts: { pinnedCheckoutAccessible: false },
      checkoutStatErrorCode: presence.code,
      drift: ["pinnedCheckoutAccessible"],
    };
    console.log(JSON.stringify(verdict, null, 2));
    return 1;
  }
  if (missingSourceCount > 0) {
    const verdict = {
      pinnedCommit: EXPECTED_COMMIT,
      automatedFixtureImportFromNodeHarness: "unsupported",
      reason: "pinned-omp-import-source-incomplete",
      verifiedFacts: { pinnedImportSourcesPresent: false },
      missingSourceCount,
      drift: ["pinnedImportSourcesPresent"],
    };
    console.log(JSON.stringify(verdict, null, 2));
    return 1;
  }

  const revision = git(["rev-parse", "HEAD"]);
  const topLevel = git(["rev-parse", "--show-toplevel"]);
  const sourceDiff = git(["diff", "--no-ext-diff", "--quiet", "HEAD", "--",
    ...IMPORT_SOURCES.map((file) => `packages/coding-agent/${file}`)]);
  const facts = {
    pinnedCheckoutRevision: revision.status === 0 && topLevel.status === 0
      && samePath(topLevel.stdout.trim(), checkout) && revision.stdout.trim() === EXPECTED_COMMIT,
    pinnedImportSourcesClean: sourceDiff.status === 0,
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
    // This checks only the direct factory text, not transitive imports or OS-level network isolation.
    importFactoryHasNoFetch:
      !/\bfetch\s*\(/.test(factory) && !/Authorization|apiKey|https?:\/\//.test(factory),
    // Target isolation IS supported at the library level (sessionDir option).
    importSupportsIsolatedSessionDir: /sessionDir\??\s*:/.test(factory),
  };

  const expected = {
    pinnedCheckoutRevision: true,
    pinnedImportSourcesClean: true,
    cliFactoryIgnoresExplicitRoot: true,
    codexStoreAcceptsExplicitRoot: true,
    claudeStoreAcceptsExplicitRoot: true,
    codexStoreRequiresBunSqlite: true,
    importFactoryHasNoFetch: true,
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
