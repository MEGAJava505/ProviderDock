// Fixture-only recovery + concurrency proof for scripts/build-dist.mjs (M5-R2.1). Imports the REAL
// makeBuilder and drives its actual recovery/swap/lock logic against THROWAWAY temp roots under os.tmpdir()
// — never the repo, never a real `dist`/`.dist-prev`, never real `tsc`. A FAKE compile stands in for tsc so
// no real build ever runs here. Every root is asserted to live under tmpdir and to differ from the repo root
// before any destructive step. One JSON result on stdout. Ships as `.mjs` (NOT a *.test.ts) so the vitest
// file/test counts are unchanged.
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBuilder } from "./build-dist.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TMP = resolve(tmpdir());
const createdRoots = [];
const SCAN_ALLOWED_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "EBUSY", "ELOOP", "EEXIST", "ENOTEMPTY"]);
function safeCause(error) {
  const code = error?.code;
  if (typeof code === "string" && SCAN_ALLOWED_CODES.has(code)) return code;
  const msg = typeof error?.message === "string" ? error.message : "";
  const m = msg.match(/^(refused-symlink|refused-unowned-path|rename-failed|injected-[a-z-]+):?/);
  return m ? m[1] : "unexpected-error";
}

// Every fixture root MUST be a fresh tmpdir subtree, never the repo. Assert before handing it to makeBuilder.
async function makeRoot(label) {
  const base = await mkdtemp(join(TMP, `build-recovery-smoke-${label}-`));
  const abs = resolve(base);
  if (abs === REPO_ROOT || !abs.startsWith(TMP + sep)) {
    throw new Error("refused-unowned-path:fixture-root");
  }
  createdRoots.push(abs);
  return abs;
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
// A "whole build" dir: cli.js (bin entry) + one extra .js (so countJs>0) + a marker naming WHICH build it is.
async function seedBuildDir(dir, marker) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "cli.js"), "#!/usr/bin/env node\n// fixture cli\n", "utf8");
  await writeFile(join(dir, "index.js"), "// fixture module\n", "utf8");
  await writeFile(join(dir, "marker.txt"), marker, "utf8");
}
async function markerOf(dir) { try { return await readFile(join(dir, "marker.txt"), "utf8"); } catch { return null; } }
// ---- Fake compilers (stand in for tsc; the build passes the STAGING path, they populate it) ----------
// A successful compile writes a whole build into staging and returns 0.
function compileOk(marker) {
  return async (stagingDir) => { await seedBuildDir(stagingDir, marker); return 0; };
}
// A failing compile writes nothing and returns a non-zero code (tsc error).
function compileFail() { return async () => 1; }
// An "incomplete" compile returns 0 but omits cli.js (sanity gate must still reject it).
function compileIncomplete() {
  return async (stagingDir) => { await mkdir(stagingDir, { recursive: true }); await writeFile(join(stagingDir, "index.js"), "// no cli\n", "utf8"); return 0; };
}
// A gated compile signals when it is REACHED (lock already held), then blocks until released — used to
// hold the lock deterministically while a second in-process build attempts to acquire it (state D).
function compileGated(marker) {
  let signalEntered, release;
  const entered = new Promise((r) => { signalEntered = r; });
  const gate = new Promise((r) => { release = r; });
  const compile = async (stagingDir) => { await seedBuildDir(stagingDir, marker); signalEntered(); await gate; return 0; };
  return { compile, entered, release: () => release() };
}

// One-shot fault seams.
function throwOnceBeforeSwap() {
  let fired = false;
  return async () => { if (!fired) { fired = true; const e = new Error("injected-swap-fail"); e.code = "INJECT"; throw e; } };
}
// Fail EVERY rename whose destination is `dist` — hits both the swap (staging->dist) and the rollback
// (backup->dist), so the build cannot restore dist and must fall through to byte-preserving manual recovery.
function failRenameToDist() {
  return async (_fromBase, toBase) => { if (toBase === "dist") { const e = new Error("injected-rename-to-dist"); e.code = "INJECT"; throw e; } };
}

const checks = [];
const record = (name, status, detail) => checks.push(detail === undefined ? { name, status } : { name, status, detail });
function expect(name, cond, detail) { record(name, cond ? "PASS" : "FAIL", detail); return cond; }
async function main() {
  // State A — dist present, no backup. Normal replace. New build lands; backup/staging/lock all gone.
  {
    const root = await makeRoot("stateA");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileOk("NEW") });
    expect("stateA-success-ok", r.ok === true && r.replacedPriorDist === true, "dist present, no backup -> replace");
    expect("stateA-dist-is-new", (await markerOf(join(root, "dist"))) === "NEW", "dist swapped to the freshly compiled build");
    expect("stateA-no-leftovers", !(await exists(join(root, ".dist-prev"))) && !(await exists(join(root, ".dist-staging"))) && !(await exists(join(root, ".dist-build.lock"))), "backup/staging/lock cleaned");
  }

  // State B — interrupted swap: dist ABSENT, .dist-prev holds the ONLY whole build (canary). The build must
  // restore it FIRST. Here the follow-on compile FAILS, so the canary must survive AS dist (this is exactly
  // the reopened defect: the old algorithm deleted .dist-prev before compiling and lost it).
  {
    const root = await makeRoot("stateB-fail");
    await seedBuildDir(join(root, ".dist-prev"), "CANARY");
    await seedBuildDir(join(root, ".dist-staging"), "LEFTOVER"); // stray staging from the interrupted run
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileFail() });
    expect("stateB-recovered-flag", r.ok === false && r.reason === "compile-failed" && r.recovered === true, "compile failed AFTER recovery");
    expect("stateB-canary-survived-as-dist", (await markerOf(join(root, "dist"))) === "CANARY", "backup restored to dist BEFORE the failing compile — canary NOT lost");
    expect("stateB-no-backup-left", !(await exists(join(root, ".dist-prev"))), "sole build was moved into dist, not left orphaned");
    expect("stateB-lock-released", !(await exists(join(root, ".dist-build.lock"))), "lock released after run");
  }

  // State B then a SUCCESSFUL compile — recovers the canary, then supersedes it with the fresh build.
  {
    const root = await makeRoot("stateB-ok");
    await seedBuildDir(join(root, ".dist-prev"), "CANARY");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileOk("NEW") });
    expect("stateB-then-build-ok", r.ok === true && r.recovered === true, "recovered then rebuilt");
    expect("stateB-then-build-dist-new", (await markerOf(join(root, "dist"))) === "NEW", "dist is the fresh build");
    expect("stateB-then-build-clean", !(await exists(join(root, ".dist-prev"))) && !(await exists(join(root, ".dist-staging"))), "no leftovers");
  }

  // State C — BOTH dist and .dist-prev present. Without a durable completion marker, we cannot distinguish
  // a successful swap with failed cleanup from an incomplete dist plus the last whole build in backup.
  // Refuse to overwrite either copy; a human can inspect and resolve this state.
  {
    const root = await makeRoot("stateC");
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "marker.txt"), "PARTIAL", "utf8");
    await seedBuildDir(join(root, ".dist-prev"), "ONLY-WHOLE");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileOk("NEWER") });
    expect("stateC-fail-closed", r.ok === false && r.reason === "ambiguous-backup", "both present -> manual resolution");
    expect("stateC-partial-unchanged", (await markerOf(join(root, "dist"))) === "PARTIAL", "unconfirmed dist was not published over");
    expect("stateC-backup-preserved", (await markerOf(join(root, ".dist-prev"))) === "ONLY-WHOLE", "last whole build not deleted");
    expect("stateC-no-compile", !(await exists(join(root, ".dist-staging"))), "no new build started in ambiguous state");
  }
  // Swap failure with rollback — dist demoted to backup, the staging->dist swap throws once, prior dist is
  // restored from backup. The user keeps their previous working dist; the half-built staging is discarded.
  {
    const root = await makeRoot("swapfail");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root, { hooks: { beforeSwap: throwOnceBeforeSwap() } });
    const r = await b.build({ compile: compileOk("NEW") });
    expect("swapfail-restored", r.ok === false && r.reason === "swap-failed-restored", "swap failed -> rollback");
    expect("swapfail-dist-is-old", (await markerOf(join(root, "dist"))) === "OLD", "prior dist restored intact");
    expect("swapfail-clean", !(await exists(join(root, ".dist-prev"))) && !(await exists(join(root, ".dist-staging"))), "backup consumed by rollback, staging discarded");
  }

  // Swap AND rollback both fail (every rename INTO dist throws). The build cannot restore dist, so it must
  // preserve every byte (the demoted OLD in .dist-prev and the NEW in .dist-staging) and emit a manual code.
  {
    const root = await makeRoot("bothfail");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root, { hooks: { beforeRename: failRenameToDist() } });
    const r = await b.build({ compile: compileOk("NEW") });
    expect("bothfail-unrecovered", r.ok === false && r.reason === "swap-failed-unrecovered", "neither swap nor rollback could place dist");
    const backupMarker = await markerOf(join(root, ".dist-prev"));
    const stagingMarker = await markerOf(join(root, ".dist-staging"));
    expect("bothfail-bytes-preserved", backupMarker === "OLD" && stagingMarker === "NEW", "BOTH the prior build and the new build survive on disk — nothing deleted");
  }

  // Incomplete staged output (no cli.js) — sanity gate rejects it, dist untouched, staging discarded.
  {
    const root = await makeRoot("incomplete");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileIncomplete() });
    expect("incomplete-rejected", r.ok === false && r.reason === "incomplete-output", "missing cli.js rejected");
    expect("incomplete-dist-untouched", (await markerOf(join(root, "dist"))) === "OLD" && !(await exists(join(root, ".dist-staging"))), "dist left as-is, staging discarded");
  }

  // Plain compile failure — dist untouched.
  {
    const root = await makeRoot("compilefail");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileFail() });
    expect("compilefail-dist-untouched", r.ok === false && r.reason === "compile-failed" && (await markerOf(join(root, "dist"))) === "OLD", "tsc failure leaves dist in place");
  }

  // Symlink/junction refusal — dist is a junction pointing OUTSIDE the root. The build must refuse BEFORE any
  // destructive op and never follow the link outward. If this host cannot create a link, the check is BLOCKED.
  {
    const root = await makeRoot("symlink");
    const outside = await makeRoot("symlink-outside");
    await seedBuildDir(join(outside, "precious"), "OUTSIDE-CANARY");
    let linked = true;
    try { await symlink(join(outside, "precious"), join(root, "dist"), "junction"); }
    catch { try { await symlink(join(outside, "precious"), join(root, "dist"), "dir"); } catch { linked = false; } }
    if (!linked) {
      record("symlink-refusal", "BLOCKED", "host cannot create a directory junction/symlink without privilege");
    } else {
      const b = makeBuilder(root);
      let refused = false;
      try { await b.build({ compile: compileOk("NEW") }); } catch (e) { refused = safeCause(e) === "refused-symlink"; }
      expect("symlink-refusal", refused, "build refused an owned dir that is a link");
      expect("symlink-outside-untouched", (await markerOf(join(outside, "precious"))) === "OUTSIDE-CANARY" && !(await exists(join(root, ".dist-build.lock"))), "link target untouched, lock released");
    }
  }

  // State D — concurrent builds. build-1 holds the lock while gated inside compile; build-2 attempts to
  // acquire, sees the lock, and returns build-locked WITHOUT touching build-1's in-flight staging. This
  // exercises the in-process ordering deterministically; a true multi-PROCESS OS race is NOT exercised here.
  {
    const root = await makeRoot("concurrentD");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b1 = makeBuilder(root);
    const g = compileGated("NEW1");
    const p1 = b1.build({ compile: g.compile });
    await g.entered; // build-1 has acquired the lock and is inside compile
    const b2 = makeBuilder(root);
    const r2 = await b2.build({ compile: compileOk("OTHER") });
    expect("concurrentD-second-locked", r2.ok === false && r2.reason === "build-locked", "second build refused fail-closed (no auto-reclaim)");
    expect("concurrentD-staging-intact", await exists(join(root, ".dist-staging")), "build-1's in-flight staging was NOT deleted by build-2");
    g.release();
    const r1 = await p1;
    expect("concurrentD-first-completes", r1.ok === true && (await markerOf(join(root, "dist"))) === "NEW1", "the holder completes and lands its build");
    expect("concurrentD-lock-released", !(await exists(join(root, ".dist-build.lock"))), "lock released after the holder finishes");
  }

  // A foreign successor replaces the lock while this build is running. The original owner must not unlink
  // the successor's marker at release (same ownership rule as the credential/portal locks).
  {
    const root = await makeRoot("lock-successor");
    await seedBuildDir(join(root, "dist"), "OLD");
    const b = makeBuilder(root);
    const r = await b.build({ compile: async (stagingDir) => {
      await seedBuildDir(stagingDir, "NEW");
      await rm(b.paths.LOCK);
      await writeFile(b.paths.LOCK, "FOREIGN-SUCCESSOR", "utf8");
      return 0;
    } });
    expect("lock-successor-build-refused", r.ok === false && r.reason === "build-lock-lost", "lost owner must not publish a new dist");
    expect("lock-successor-prior-dist", (await markerOf(join(root, "dist"))) === "OLD", "prior dist stays published");
    expect("lock-successor-staging-preserved", (await markerOf(join(root, ".dist-staging"))) === "NEW", "unowned staging is not deleted");
    let successor = null;
    try { successor = await readFile(b.paths.LOCK, "utf8"); } catch { /* absent is the failure under test */ }
    expect("lock-successor-preserved", successor === "FOREIGN-SUCCESSOR", "owner did not delete a successor's lock");
  }

  const failing = checks.filter((c) => c.status === "FAIL").length;
  const blocked = checks.filter((c) => c.status === "BLOCKED").length;
  const ok = failing === 0;
  console.log(JSON.stringify({ smoke: "build-recovery", fixtureOnly: true, network: "none", tsc: "faked", ok, failing, blocked, total: checks.length, checks }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

// ---- Negative suite: reproduce the OLD algorithm's State-B defect (RED) so the fixture provably has teeth,
// then show the current build preserves the same canary (GREEN). No real repo/dist/tsc; temp roots only. ----
async function negativeMain() {
  const neg = [];
  const nrecord = (name, status, detail) => neg.push(detail === undefined ? { name, status } : { name, status, detail });

  // Faithful re-enactment of the reopened defect: the prior build did `rm(.dist-staging)` then
  // `rm(.dist-prev)` UNCONDITIONALLY before compiling. In State B (dist absent, backup = only whole build)
  // that deletes the backup; if the compile then fails, the last whole build is gone. Run on a temp root.
  async function simulateLegacyStep1(root) {
    if (resolve(root) === REPO_ROOT || !resolve(root).startsWith(TMP + sep)) throw new Error("refused-unowned-path:legacy-root");
    await rm(join(root, ".dist-staging"), { recursive: true, force: true });
    await rm(join(root, ".dist-prev"), { recursive: true, force: true }); // <-- the defect: canary deleted
    // failing compile writes no dist -> dist stays absent
  }

  {
    const root = await makeRoot("legacyB");
    await seedBuildDir(join(root, ".dist-prev"), "CANARY");
    await seedBuildDir(join(root, ".dist-staging"), "LEFTOVER");
    await simulateLegacyStep1(root);
    const canaryGone = !(await exists(join(root, ".dist-prev")));
    const distAbsent = !(await exists(join(root, "dist")));
    nrecord("legacy-stateB-RED", canaryGone && distAbsent ? "PASS" : "FAIL",
      "OLD algorithm deleted .dist-prev before a failing compile -> last whole build lost (defect reproduced)");
  }

  {
    // Same State B, but drive the CURRENT build with a failing compile: the canary must survive as dist.
    const root = await makeRoot("newB");
    await seedBuildDir(join(root, ".dist-prev"), "CANARY");
    await seedBuildDir(join(root, ".dist-staging"), "LEFTOVER");
    const b = makeBuilder(root);
    const r = await b.build({ compile: compileFail() });
    const preserved = r.ok === false && (await markerOf(join(root, "dist"))) === "CANARY";
    nrecord("new-code-preserves-canary", preserved ? "PASS" : "FAIL",
      "current build restores .dist-prev to dist BEFORE compiling -> same canary survives the failing compile (fix)");
  }

  const failing = neg.filter((c) => c.status === "FAIL").length;
  const ok = failing === 0;
  console.log(JSON.stringify({ smoke: "build-recovery-negative", fixtureOnly: true, network: "none", tsc: "faked", ok, failing, total: neg.length, checks: neg }, null, 2));
  process.exitCode = ok ? 0 : 1;
}

const wantNegative = process.argv.includes("--negative");
(wantNegative ? negativeMain() : main())
  .catch((error) => {
    console.log(JSON.stringify({ smoke: wantNegative ? "build-recovery-negative" : "build-recovery", ok: false, error: safeCause(error) }, null, 2));
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const root of createdRoots.splice(0)) { try { await rm(root, { recursive: true, force: true }); } catch { /* best-effort */ } }
  });
