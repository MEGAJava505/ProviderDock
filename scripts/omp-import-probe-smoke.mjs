#!/usr/bin/env node
// Sequential, fixture-only check of the read-only OMP import probe's revision guard.
// Git writes are limited to one owned temp repository; the real OMP checkout is never changed.
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const prefix = join(tmpdir(), "providerdock-import-probe-");
const checks = [];

function runGit(args, checkout) {
  const result = spawnSync("git", args, { cwd: checkout, encoding: "utf8", windowsHide: true, timeout: 10000 });
  if (result.status !== 0) throw new Error(`fixture-git-${args[0]}-failed`);
  return result.stdout.trim();
}

function runProbe(probePath, root) {
  const result = spawnSync(process.execPath, [probePath],
    { cwd: root, encoding: "utf8", windowsHide: true, timeout: 15000 });
  let verdict;
  try { verdict = JSON.parse(result.stdout); } catch { verdict = null; }
  return { exit: result.status, verdict };
}

function check(name, passed) {
  checks.push({ name, status: passed ? "PASS" : "FAIL" });
}

// Build an owned copy of the probe whose stat() always throws a given errno,
// simulating an existing-but-inaccessible checkout WITHOUT touching real ACLs or
// the pinned .scratch/omp. readFile is left intact so pinned sources still read;
// only the presence probe hits the injected error. Fails loudly if the probe's
// import shape changes, so the substitution can never silently become a no-op.
function injectThrowingStat(source, code) {
  const importLine = 'import { readFile, stat } from "node:fs/promises";';
  if (!source.includes(importLine)) throw new Error("fixture-probe-stat-import-shape-changed");
  const stub = 'import { readFile } from "node:fs/promises";\n'
    + "const stat = async () => { const injected = new Error(\"fixture-injected-stat-error\"); "
    + `injected.code = ${JSON.stringify(code)}; throw injected; };`;
  return source.replace(importLine, stub);
}

async function main() {
  let root;
  let root2;
  try {
    root = await mkdtemp(prefix);
    const checkout = join(root, ".scratch", "omp");
    const sourceDir = join(checkout, "packages", "coding-agent", "src", "session");
    const scriptDir = join(root, "scripts");
    await mkdir(sourceDir, { recursive: true });
    await mkdir(scriptDir, { recursive: true });
    const factoryPath = join(sourceDir, "foreign-session-import.ts");
    const factory = "new ClaudeSessionStore(); new CodexSessionStore(); type Options = { sessionDir?: string };\n";
    await writeFile(factoryPath, factory);
    await writeFile(join(sourceDir, "codex-session-store.ts"),
      'import { Database } from "bun:sqlite"; constructor(rootDirectory = path.join(os.homedir(), ".codex")) {}\n');
    await writeFile(join(sourceDir, "claude-session-store.ts"),
      "constructor(root = resolveClaudePaths().configDir) {}\n");
    const sessionManagerPath = join(sourceDir, "session-manager.ts");
    await writeFile(sessionManagerPath, "// fixture session persistence\n");
    await writeFile(join(sourceDir, "session-listing.ts"), "// fixture read-only listing\n");
    const sessionLoaderPath = join(sourceDir, "session-loader.ts");
    await writeFile(sessionLoaderPath, "// fixture session loader\n");
    const script = await readFile(join(repoRoot, "scripts", "omp-import-probe.mjs"), "utf8");
    const fixtureProbe = join(scriptDir, "omp-import-probe.mjs");
    await writeFile(fixtureProbe, script);

    runGit(["init", "-q"], checkout);
    runGit(["add", "packages/coding-agent/src/session"], checkout);
    runGit(["-c", "user.name=Fixture", "-c", "user.email=fixture@invalid",
      "-c", "commit.gpgsign=false", "commit", "-qm", "fixture"], checkout);
    const fixtureHead = runGit(["rev-parse", "HEAD"], checkout);

    const unpinned = runProbe(fixtureProbe, root);
    check("unpinned-checkout-refused", unpinned.exit === 1
      && unpinned.verdict?.drift?.includes("pinnedCheckoutRevision")
      && unpinned.verdict?.verifiedFacts?.pinnedImportSourcesClean === true);

    const expectedLine = script.match(/const EXPECTED_COMMIT = "[0-9a-f]{40}";/)?.[0];
    if (!expectedLine) throw new Error("fixture-expected-commit-not-found");
    await writeFile(fixtureProbe, script.replace(expectedLine, `const EXPECTED_COMMIT = "${fixtureHead}";`));
    const pinned = runProbe(fixtureProbe, root);
    check("pinned-clean-checkout-accepted", pinned.exit === 0
      && pinned.verdict?.verifiedFacts?.pinnedCheckoutRevision === true
      && pinned.verdict?.verifiedFacts?.pinnedImportSourcesClean === true
      && pinned.verdict?.verifiedFacts?.importFactoryHasNoFetch === true);

    await rm(sessionLoaderPath);
    const missingSource = runProbe(fixtureProbe, root);
    check("missing-source-refused", missingSource.exit === 1
      && missingSource.verdict?.drift?.includes("pinnedImportSourcesPresent")
      && missingSource.verdict?.skipped !== true);
    await writeFile(sessionLoaderPath, "// fixture session loader\n");

    await writeFile(sessionManagerPath, "// fixture session persistence changed\n");
    const persistenceDrift = runProbe(fixtureProbe, root);
    check("modified-persistence-source-refused", persistenceDrift.exit === 1
      && persistenceDrift.verdict?.drift?.includes("pinnedImportSourcesClean")
      && persistenceDrift.verdict?.verifiedFacts?.pinnedCheckoutRevision === true);
    await writeFile(sessionManagerPath, "// fixture session persistence\n");

    await writeFile(factoryPath, factory + "// local drift\n");
    const modified = runProbe(fixtureProbe, root);
    check("modified-import-source-refused", modified.exit === 1
      && modified.verdict?.drift?.includes("pinnedImportSourcesClean")
      && modified.verdict?.verifiedFacts?.pinnedCheckoutRevision === true);

    // A checkout that EXISTS but whose stat() fails for a reason OTHER than
    // absence (EACCES/EPERM) must be a structural refusal, never mistaken for an
    // absent checkout and skipped. stat is substituted only in an owned copy of
    // the probe; the real checkout and pinned .scratch/omp are untouched. The
    // refusal must carry only allowlisted structural fields (a normalized errno
    // code), and never a path, file contents, raw error, or environment.
    for (const code of ["EACCES", "EPERM"]) {
      const injectedProbe = join(scriptDir, `omp-import-probe-stat-${code}.mjs`);
      await writeFile(injectedProbe, injectThrowingStat(script, code));
      const inaccessible = runProbe(injectedProbe, root);
      check(`existing-checkout-stat-${code}-refused`, inaccessible.exit === 1
        && inaccessible.verdict?.skipped !== true
        && inaccessible.verdict?.reason === "pinned-omp-checkout-inaccessible"
        && inaccessible.verdict?.checkoutStatErrorCode === code
        && inaccessible.verdict?.verifiedFacts?.pinnedCheckoutAccessible === false
        && inaccessible.verdict?.drift?.includes("pinnedCheckoutAccessible"));
    }

    // A wholly absent checkout is distinct from an incomplete one: no .scratch/omp
    // at all must stay an explicitly-labeled skip (exit 0), never a refusal and
    // never a verified verdict. A separate owned temp root has only the probe.
    root2 = await mkdtemp(prefix);
    const scriptDir2 = join(root2, "scripts");
    await mkdir(scriptDir2, { recursive: true });
    const absentProbe = join(scriptDir2, "omp-import-probe.mjs");
    await writeFile(absentProbe, script);
    const absent = runProbe(absentProbe, root2);
    check("absent-checkout-skipped", absent.exit === 0
      && absent.verdict?.skipped === true
      && absent.verdict?.reason === "pinned-omp-checkout-absent"
      && !absent.verdict?.drift?.includes?.("pinnedImportSourcesPresent"));
  } finally {
    for (const dir of [root, root2]) {
      if (!dir) continue;
      if (!dir.startsWith(prefix)) throw new Error("refused-unowned-fixture-root");
      await rm(dir, { recursive: true, force: true });
    }
  }
  const ok = checks.length === 8 && checks.every((item) => item.status === "PASS");
  console.log(JSON.stringify({ smoke: "omp-import-probe", fixtureOnly: true, ok, checks }));
  process.exitCode = ok ? 0 : 1;
}

main().catch((error) => {
  const code = typeof error?.code === "string" && /^[A-Z0-9_]+$/.test(error.code)
    ? error.code : "unexpected-error";
  console.log(JSON.stringify({ smoke: "omp-import-probe", fixtureOnly: true, ok: false, code }));
  process.exitCode = 1;
});
