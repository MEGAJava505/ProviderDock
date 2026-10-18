// Source-matched, crash-recoverable build for `npm run build`. Plain `tsc --outDir dist` never deletes the
// output of a source file that was later removed, so stale orphan `.js` accumulate in dist/ and — via the
// package `files: ["dist/**/*.js"]` allowlist — would ship in the tarball. This helper compiles into a CLEAN
// staging dir and only then atomically swaps it into dist/, so every publish-time dist/ mirrors exactly the
// current src/ tree. A failed or incomplete compile NEVER replaces the prior working dist/.
//
// Recovery + concurrency (M5-R2.1): the build recognizes the dist/staging/backup STATE before deleting
// anything, so an interrupted swap (dist gone, .dist-prev holding the only whole build) is restored rather
// than destroyed; and a fail-closed lock (`.dist-build.lock`) serializes concurrent builds
// so one build can never delete another's in-flight staging. No network, no publish; only fixed basenames
// directly under the (injected) root, and never a rename/delete that follows a junction/symlink outward.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, rename, readdir, lstat, open, readFile } from "node:fs/promises";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Windows directory rename is not reliably immediate: an antivirus scan, the search indexer, or a just-closed
// tsc handle can hold a transient lock. Retry a bounded number of times; only a persistent failure is real.
// (This retry is NOT the recovery fix and is deliberately left unchanged.)
const RENAME_TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY", "EEXIST"]);

// Factory: bind every path + the ownership guard to `root`, so a fixture can drive the REAL recovery/swap
// logic against a throwaway temp tree (never the real repo). Nothing imports this module today; `npm run
// build` reaches production only through the direct-execution guard at the bottom of the file.
export function makeBuilder(root, overrides = {}) {
  const REPO = resolve(root);
  const DIST = join(REPO, "dist");
  const STAGING = join(REPO, ".dist-staging");
  const BACKUP = join(REPO, ".dist-prev");
  const LOCK = join(REPO, ".dist-build.lock");
  const tscBin = join(REPO, "node_modules", "typescript", "bin", "tsc");
  const hooks = overrides.hooks || {};

  // Guard: every path we ever delete or rename must be a KNOWN basename directly under the root. Anything
  // else is a hard stop (never a delete by a computed/unexpected root).
  const OWNED = new Set(["dist", ".dist-staging", ".dist-prev", ".dist-build.lock"]);
  function assertOwned(p, expectedBase) {
    const abs = resolve(p);
    if (dirname(abs) !== REPO || basename(abs) !== expectedBase || !OWNED.has(expectedBase)) {
      throw new Error(`refused-unowned-path:${expectedBase}`);
    }
    return abs;
  }
  async function exists(p) {
    try { await lstat(p); return true; }
    catch (error) { if (error?.code === "ENOENT") return false; throw error; }
  }
  // Fail-closed junction/symlink guard: NTFS junctions report isSymbolicLink()===true, so refuse to rm or
  // rename any owned dir that is actually a link (never follow it outward). A missing path is fine.
  async function assertNotLink(p, base) {
    const abs = assertOwned(p, base);
    let st;
    try { st = await lstat(abs); }
    catch (error) { if (error?.code === "ENOENT") return; throw error; }
    if (st.isSymbolicLink()) throw new Error(`refused-symlink:${base}`);
  }
  async function rmOwned(p, base) {
    await assertNotLink(p, base);
    await rm(assertOwned(p, base), { recursive: true, force: true });
  }
  async function renameOwned(from, fromBase, to, toBase) {
    const src = assertOwned(from, fromBase);
    const dst = assertOwned(to, toBase);
    await assertNotLink(from, fromBase);                 // never rename a link outward
    if (hooks.beforeRename) await hooks.beforeRename(fromBase, toBase);  // test seam (fault injection)
    let lastCode = "unknown";
    for (let attempt = 0; attempt < 10; attempt++) {
      try { await rename(src, dst); return; }
      catch (error) {
        lastCode = error?.code || "unknown";
        if (!RENAME_TRANSIENT.has(lastCode)) throw error;
        await sleep(50 + attempt * 50);
      }
    }
    const err = new Error(`rename-failed:${lastCode}`);
    err.code = lastCode;
    throw err;
  }
  async function countJs(dir) {
    let count = 0;
    async function walk(d, depth) {
      if (depth > 32) return;
      let ents; try { ents = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of ents) {
        if (e.isSymbolicLink()) continue;
        const full = join(d, e.name);
        if (e.isDirectory()) await walk(full, depth + 1);
        else if (e.isFile() && e.name.endsWith(".js")) count++;
      }
    }
    await walk(dir, 0);
    return count;
  }
  async function ownsLock(token) {
    try {
      await assertNotLink(LOCK, ".dist-build.lock");
      return (await readFile(LOCK, "utf8")) === token;
    } catch { return false; }
  }
  function runTsc(outDir) {
    return new Promise((res) => {
      const child = spawn(process.execPath, [tscBin, "-p", "tsconfig.build.json", "--outDir", outDir],
        { cwd: REPO, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
      child.on("close", (code) => res(code ?? 1));
      child.on("error", () => res(1));
    });
  }
  // Returns a plain result object; NEVER calls process.exit, so a fixture (or vitest) can drive the SAME
  // logic in-process. { ok, code, reason, jsEmitted, replacedPriorDist, recovered, recovery }.
  async function build({ compile = runTsc } = {}) {
    // Fail-closed build lock. O_CREAT|O_EXCL ("wx") — a second concurrent build sees EEXIST
    // and returns WITHOUT touching the lock or any owned dir. Only the process that CREATED the lock removes
    // it (verified by a random owner token), so a loser can never steal a live build's lock. A lock left by a crashed
    // build is NOT auto-reclaimed — a human removes it (house fail-closed idiom; see portal-repository.ts).
    let acquired = false;
    const lockToken = randomUUID();
    let handle;
    try {
      try {
        handle = await open(LOCK, "wx");
        acquired = true;
        await handle.writeFile(lockToken, "utf8");
        await handle.close();
        handle = undefined;
      } catch (e) {
        if (e && e.code === "EEXIST") {
          return { ok: false, code: 2, reason: "build-locked",
            recovery: "another build holds .dist-build.lock; if no build is running, delete it and retry" };
        }
        throw e;
      }

      // Refuse to operate on any owned path that is actually a junction/symlink (never follow it outward).
      await assertNotLink(DIST, "dist");
      await assertNotLink(STAGING, ".dist-staging");
      await assertNotLink(BACKUP, ".dist-prev");

      // STATE RECOGNITION before deleting anything (M5-R2.1). State B = interrupted swap: dist is gone and
      // .dist-prev holds the ONLY whole build. Restore it FIRST and never delete it. This deliberately
      // discards any staging left from the interrupted run and recompiles (correctness over speed: we will
      // not promote a staging we cannot re-prove here).
      const distExists0 = await exists(DIST);
      const backupExists0 = await exists(BACKUP);
      let recovered = false;
      // Two copies are ambiguous without a durable commit marker: `dist` might be an incomplete new
      // publication and backup the last whole build. Never delete the backup on that assumption.
      if (distExists0 && backupExists0) {
        return { ok: false, code: 2, reason: "ambiguous-backup",
          recovery: "inspect dist and .dist-prev, retain the whole build, then resolve the extra copy manually" };
      }
      if (!distExists0 && backupExists0) {
        await renameOwned(BACKUP, ".dist-prev", DIST, "dist");
        recovered = true;
      }
      // The staging dir is scratch — never a sole whole build — so it is safe to clear under the lock.
      if (await exists(STAGING)) await rmOwned(STAGING, ".dist-staging");

      const code = await compile(STAGING);
      // An external actor may replace the lock while tsc is running. If ownership is gone, this process
      // must not touch staging or publish dist: a successor may now be using the fixed output paths.
      if (!(await ownsLock(lockToken))) {
        return { ok: false, code: 2, reason: "build-lock-lost", recovered,
          recovery: "another owner holds .dist-build.lock; inspect dist and .dist-staging before retrying" };
      }
      if (code !== 0) {
        if (await exists(STAGING)) await rmOwned(STAGING, ".dist-staging");
        return { ok: false, code: code || 1, reason: "compile-failed", recovered };
      }
      const stagedBin = join(STAGING, "cli.js");
      const jsCount = await countJs(STAGING);
      if (!(await exists(stagedBin)) || jsCount === 0) {
        await rmOwned(STAGING, ".dist-staging");
        return { ok: false, code: 1, reason: "incomplete-output", recovered };
      }
      // SWAP with rollback. An existing backup cannot appear here under normal operation: an ambiguous
      // two-copy state was refused before compile, and a sole backup was restored to dist first.
      if (!(await ownsLock(lockToken))) {
        return { ok: false, code: 2, reason: "build-lock-lost", recovered,
          recovery: "another owner holds .dist-build.lock; inspect dist and .dist-staging before retrying" };
      }
      const hadDist = await exists(DIST);
      if (await exists(BACKUP)) throw new Error("backup-appeared-during-build");
      if (hadDist) {
        await renameOwned(DIST, "dist", BACKUP, ".dist-prev");   // demote current dist to backup
      }
      try {
        if (hooks.beforeSwap) await hooks.beforeSwap();          // test seam: force swap failure
        await renameOwned(STAGING, ".dist-staging", DIST, "dist");
      } catch (error) {
        // New dist not confirmed. Restore the prior dist from the backup we just demoted, if any.
        if (hadDist && !(await exists(DIST)) && (await exists(BACKUP))) {
          try { await renameOwned(BACKUP, ".dist-prev", DIST, "dist"); } catch { /* fall through */ }
        }
        if (!(await exists(DIST))) {
          // Unrecoverable via our own ops (a failed rename never destroys its own source, so this is
          // essentially unreachable). Preserve every byte and emit a static, secret-free, path-free code.
          console.error("MANUAL-RECOVERY-DIST-ABSENT: prior build preserved in .dist-prev and/or .dist-staging; rename one to dist by hand. No bytes were deleted.");
          return { ok: false, code: 1, reason: "swap-failed-unrecovered", recovered };
        }
        if (await exists(STAGING)) await rmOwned(STAGING, ".dist-staging");
        return { ok: false, code: 1, reason: "swap-failed-restored", recovered };
      }
      // New dist is confirmed. Drop the demoted backup best-effort; a leftover backup is treated as
      // ambiguous by the next run and requires manual resolution, never an automatic delete.
      if (await exists(BACKUP)) { try { await rmOwned(BACKUP, ".dist-prev"); } catch { /* non-fatal */ } }
      return { ok: true, jsEmitted: jsCount, replacedPriorDist: hadDist, recovered };
    } finally {
      // Ownership-gated release: the acquirer may only remove its own token. A successor that replaced
      // the lock while this build ran remains untouched. No stale-lock auto-reclaim.
      try { if (handle) await handle.close(); } catch { /* ignore */ }
      if (acquired) {
        try {
          if (await ownsLock(lockToken)) {
            await rm(assertOwned(LOCK, ".dist-build.lock"), { force: true });
          }
        } catch { /* fail closed: a held/foreign lock requires manual recovery */ }
      }
    }
  }

  return { build, runTsc, paths: { DIST, STAGING, BACKUP, LOCK } };
}

// Direct-execution guard: the production wrapper (which maps the result to a process exit code) runs ONLY
// when this file is the entry point — `npm run build` / `node scripts/build-dist.mjs`. When a fixture
// imports makeBuilder, argv[1] is the fixture, so this block does not run. Paths are compared case-
// normalized on win32 (drive-letter / short-path casing differs between argv and import.meta.url).
function isDirectRun() {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let a = import.meta.url;
  let b = pathToFileURL(argv1).href;
  if (process.platform === "win32") { a = a.toLowerCase(); b = b.toLowerCase(); }
  return a === b;
}

if (isDirectRun()) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const { build } = makeBuilder(repoRoot);
  build()
    .then((r) => {
      if (r.ok) {
        console.log(JSON.stringify({ ok: true, jsEmitted: r.jsEmitted, replacedPriorDist: r.replacedPriorDist, recovered: !!r.recovered }));
        process.exit(0);
      }
      // Secret-free: only a stable reason label (and the fixed recovery hint for a held lock).
      console.error(`build-dist: ${r.reason}${r.recovery ? " — " + r.recovery : ""}; dist/ left in a consistent state.`);
      process.exit(r.code || 1);
    })
    .catch((error) => {
      // Do not print raw filesystem error messages: they can contain absolute paths or environment details.
      const code = typeof error?.code === "string" && /^[A-Z0-9_]{2,32}$/.test(error.code)
        ? error.code : "UNEXPECTED";
      console.error(`build-dist: fatal:${code}; inspect dist, .dist-prev and .dist-staging before retrying.`);
      process.exit(1);
    });
}
