// Run after `npm run build`. Proves the local distribution package is safe and the INSTALLED CLI runs in a
// cold fixture data-root. No network, no publish, no provider/OMP/browser, no real homes/keys/sessions.
// M5.1: a package `files` allowlist MUST be declared before any pack; the `npm pack --dry-run --json` manifest
//        is verified path-by-path against an explicit allowlist (never "safe because one name is missing").
// M5.2: a tarball is built + installed --offline into isolated temp dirs, and the installed bin is exercised
//        read-only (`--help`, `providers list --json`) with temp PROVIDER_DOCK_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR,
//        never touching HOME/USERPROFILE. Offline-cache miss is honest BLOCKED (never an online fallback, never
//        the source checkout standing in for the installed package). One JSON result on stdout; only counts and
//        allowlisted/synthetic codes leave this script — never a raw file byte, secret, or absolute foreign path.
// npm isolation (M5-R2.2): EVERY npm child runs under an owned temp `npm_config_cache` + empty owned
//        `npm_config_userconfig`/`npm_config_globalconfig` (env config OUTRANKS any discovered .npmrc) starting
//        from a canonical system-var allowlist, so no inherited NPM_CONFIG_*/npm_config_*/HOME leaks in. A genuine
//        offline cache-miss is recognized by the SPECIFIC npm code `ENOTCACHED`, never the generic "only-if-cached"
//        phrase (which also rides along in EACCES/permission failures); fs/permission and package/integrity
//        failures are hard FAILs, never laundered as an accepted cache-miss. foreignHomeIsolation stays NOT-PROVEN
//        (os.homedir() has an OS fallback independent of the env, so stripping HOME is defense-in-depth only).
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir, stat, rename, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep, dirname, relative } from "node:path";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OWNED_PREFIX = "package-safety-smoke-";
const createdRoots = [];
// Isolated npm environment (owned temp cache + empty owned user/global config). Set ONCE at the top of both
// main() and negativeMain(); read by every runNpm child. A guard in runNpm hard-stops if it is still unset, so
// no npm child can silently inherit the real HOME/APPDATA cache or a foreign .npmrc.
let npmEnv = null;
const checks = [];
const record = (name, status, detail) => checks.push(detail === undefined ? { name, status } : { name, status, detail });

// Allowlisted, secret-free codes tolerated while walking our OWN fixture space.
const SCAN_ALLOWED_CODES = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "EIO", "EBUSY", "ELOOP", "EMFILE", "ENOTDIR"]);
function safeCause(error) {
  const code = error?.code;
  if (typeof code === "string" && SCAN_ALLOWED_CODES.has(code)) return code;
  return "unexpected-error";
}

// The ONLY packlist paths the installed CLI is allowed to carry: runtime .js under dist/, plus mandatory npm
// metadata (package.json + README/LICENSE/NOTICE/CHANGELOG which npm force-includes). Everything else — src/,
// tests/, docs/, scripts/, maps, declarations, secrets, homes — is a violation. Returns a category or null.
function classifyPackPath(rawPath) {
  const p = rawPath.replace(/\\/g, "/");
  if (p === "package.json") return "meta:package.json";
  if (/^readme(\.[a-z0-9]+)?$/i.test(p)) return "meta:readme";
  if (/^licen[sc]e(\.[a-z0-9]+)?$/i.test(p)) return "meta:license";
  if (/^notice(\.[a-z0-9]+)?$/i.test(p)) return "meta:notice";
  if (/^changelog(\.[a-z0-9]+)?$/i.test(p)) return "meta:changelog";
  if (p.startsWith("dist/") && p.endsWith(".js")) return "runtime:dist-js";
  return null;
}

// Defense-in-depth labels for a violation path (never trusted alone — the allowlist above is authoritative).
const FORBIDDEN = [
  ["src", /^src\//], ["tests", /^tests?\//], ["docs", /^docs?\//], ["scripts", /^scripts?\//],
  ["env-key", /(^|\/)\.env/i], ["provider-dock-home", /(^|\/)\.provider-dock/i], ["scratch", /(^|\/)\.scratch/i],
  ["git", /(^|\/)\.git(\/|$)/], ["claude", /(^|\/)\.claude(\/|$)/], ["node_modules", /(^|\/)node_modules(\/|$)/],
  ["pdv", /\.pdv$/i], ["sourcemap", /\.map$/i], ["declaration", /\.d\.ts$/i], ["powershell", /\.ps1$/i],
  ["session", /(^|\/)sessions?(\/|$)/i], ["screenshot", /\.(png|jpe?g|gif|webp)$/i], ["tsconfig", /tsconfig.*\.json$/i],
];
function forbiddenLabel(rawPath) {
  const p = rawPath.replace(/\\/g, "/");
  for (const [label, re] of FORBIDDEN) if (re.test(p)) return label;
  return "not-allowlisted";
}

const ALLOWLIST_PATTERNS = ["package.json", "README*", "LICENSE*", "dist/**/*.js"];

// ---- process helpers ------------------------------------------------------------------------------------
// Node 22 (CVE-2024-27980) refuses to spawn a .cmd/.bat without shell:true on Windows; when we go through the
// shell we quote every path arg ourselves so nothing is re-interpreted. Node child (our own execPath) needs no
// shell. Neither runner ever inherits stdin or opens a window.
function quoteArg(a) {
  return /["\s&|<>^()]/.test(a) ? `"${String(a).replace(/"/g, '\\"')}"` : a;
}
function runNpm(args, cwd, spawnImpl = spawn) {
  // Fail-closed: never run an npm child before the isolated env is pinned (else it would inherit the real
  // HOME/APPDATA cache + any foreign .npmrc). Callers always initialize npmEnv first; this is a hard guard.
  if (!npmEnv) throw new Error("npm-env-not-initialized");
  const isWin = process.platform === "win32";
  const bin = isWin ? "npm.cmd" : "npm";
  return new Promise((res) => {
    const opts = { cwd, env: npmEnv, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    let child;
    if (isWin) {
      const line = [quoteArg(bin), ...args.map(quoteArg)].join(" ");
      child = spawnImpl(line, { ...opts, shell: true });
    } else {
      child = spawnImpl(bin, args, opts);
    }
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => res({ code, out, err }));
    child.on("error", (e) => res({ code: null, out, err: err + String(e?.code || e) }));
  });
}
function runNode(args, env, cwd) {
  return new Promise((res) => {
    const child = spawn(process.execPath, args, { env, cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => res({ code, out, err }));
    child.on("error", (e) => res({ code: null, out, err: err + String(e?.code || e) }));
  });
}

// Generic external-tool runner (e.g. `tar`) with the same Windows shell/quoting rule as runNpm.
function runTool(bin, args, cwd) {
  const isWin = process.platform === "win32";
  return new Promise((res) => {
    const opts = { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true };
    const child = isWin
      ? spawn([quoteArg(bin), ...args.map(quoteArg)].join(" "), { ...opts, shell: true })
      : spawn(bin, args, opts);
    let out = "", err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("close", (code) => res({ code, out, err }));
    child.on("error", (e) => res({ code: null, out, err: err + String(e?.code || e) }));
  });
}

async function makeRoot(tag) {
  const root = await mkdtemp(join(tmpdir(), `${OWNED_PREFIX}${tag}-`));
  createdRoots.push(root);
  return root;
}

// ---- npm isolation --------------------------------------------------------------------------------------
// Canonical system-var allowlist for npm children: ONLY what npm + its Windows shell need to run at all. Every
// credential/home/APPDATA var and every inherited NPM_CONFIG_*/npm_config_* is dropped, so nothing an outer
// shell exported can override the cache/config we pin below. Keys are matched case-insensitively (Windows may
// expose `Path`, not `PATH`) and re-emitted under one canonical name each.
const SYSTEM_ENV_ALLOW = [
  "SystemRoot", "windir", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE",
];
function baseSystemEnv() {
  const lower = new Map();
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") lower.set(k.toLowerCase(), v);
  const env = {};
  for (const canonical of SYSTEM_ENV_ALLOW) {
    const v = lower.get(canonical.toLowerCase());
    if (typeof v === "string" && v.length > 0) env[canonical] = v;
  }
  return env;
}
// Owned, empty npm home: a temp cache/ + prefix/ and two empty .npmrc files. Nothing is read from the real
// user/global config; npm's logs land under <cache>/_logs, i.e. inside this temp root.
async function makeNpmHome() {
  const home = await makeRoot("npm-home");
  const cache = join(home, "cache");
  const prefix = join(home, "prefix");
  const userconfig = join(home, "user.npmrc");
  const globalconfig = join(home, "global.npmrc");
  await mkdir(cache, { recursive: true });
  await mkdir(prefix, { recursive: true });
  await writeFile(userconfig, "", "utf8");
  await writeFile(globalconfig, "", "utf8");
  return { home, cache, prefix, userconfig, globalconfig };
}
// Isolated env for npm children. The config env vars OUTRANK any .npmrc discovered via HOME/APPDATA, which is
// what actually isolates the cache; dropping the home vars (baseSystemEnv) is defense-in-depth, NOT a proof of
// foreign-home isolation (os.homedir() still resolves via the OS). update_notifier off => no outbound check.
function makeNpmEnv(npmHome) {
  const env = baseSystemEnv();
  env.npm_config_cache = npmHome.cache;
  env.npm_config_userconfig = npmHome.userconfig;
  env.npm_config_globalconfig = npmHome.globalconfig;
  env.npm_config_prefix = npmHome.prefix;
  env.npm_config_update_notifier = "false";
  if (process.platform !== "win32") env.HOME = npmHome.home; // give POSIX npm a writable fallback; env config still wins
  return env;
}
function normPath(p) {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
}
// Boolean-only proof that npm actually resolved its cache UNDER our owned temp root. We ask npm itself
// (`npm config get cache`), normalize, and record only the verdict — never the path, never any env value.
async function proveNpmIsolation(npmHome) {
  const res = await runNpm(["config", "get", "cache"], repoRoot);
  const reported = (res.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop() || "";
  let resolvedUnderTempRoot = false;
  try {
    resolvedUnderTempRoot = res.code === 0 && reported.length > 0
      && (normPath(reported) + sep).startsWith(normPath(npmHome.home) + sep);
  } catch { resolvedUnderTempRoot = false; }
  record("m5.2-npm-cache-isolated", resolvedUnderTempRoot ? "PASS" : "FAIL", { resolvedUnderTempRoot });
  return resolvedUnderTempRoot;
}

// Delete ONLY paths we created: absolute, under the OS temp dir, carrying our owned prefix. Anything else is a
// guard FAIL and is left untouched (never a delete in the workspace or a user home).
async function cleanup() {
  const tmpBase = resolve(tmpdir()) + sep;
  for (const root of createdRoots) {
    const target = resolve(root);
    const inTmp = (target + sep).startsWith(tmpBase);
    const owned = target.includes(OWNED_PREFIX);
    if (!inTmp || !owned) { record("cleanup-guard", "FAIL", { reason: "refused-unowned-path" }); continue; }
    try { await rm(target, { recursive: true, force: true }); }
    catch (error) { record("cleanup", "WARN", { cause: safeCause(error) }); }
  }
}

// Bounded recursive scan for a caller-supplied canary marker across a tree. Any limit hit or read error is
// UNKNOWN (unreadable++), NEVER silently "clean". Emits only counts + sorted allowlisted codes — no path, no byte.
const SCAN_LIMITS = { maxDepth: 24, maxFiles: 4000, maxFileBytes: 4 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 };
async function canaryScan(root, markers) {
  const needles = markers.map((m) => Buffer.from(m, "utf8"));
  let scanned = 0, leaks = 0, unreadable = 0, files = 0, totalBytes = 0;
  const readErrorCodes = new Set();
  async function walk(dir, depth) {
    if (depth > SCAN_LIMITS.maxDepth) { unreadable++; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { unreadable++; readErrorCodes.add(safeCause(error)); return; }
    for (const ent of entries) {
      if (files >= SCAN_LIMITS.maxFiles || totalBytes >= SCAN_LIMITS.maxTotalBytes) { unreadable++; return; }
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) { unreadable++; continue; }
      if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!ent.isFile()) { unreadable++; continue; }
      files++;
      let st;
      try { st = await stat(full); } catch (error) { unreadable++; readErrorCodes.add(safeCause(error)); continue; }
      if (st.size > SCAN_LIMITS.maxFileBytes) { unreadable++; continue; }
      let buf;
      try { buf = await readFile(full); } catch (error) { unreadable++; readErrorCodes.add(safeCause(error)); continue; }
      totalBytes += buf.length; scanned++;
      if (needles.some((n) => buf.includes(n))) leaks++;
    }
  }
  await walk(root, 0);
  return { scanned, leaks, unreadable, files, readErrorCodes: [...readErrorCodes].sort() };
}

// ---- manifest / package.json helpers --------------------------------------------------------------------
async function readPackageJson(dir) {
  const raw = await readFile(join(dir, "package.json"), "utf8");
  return JSON.parse(raw);
}

// Count runtime .js actually on disk under dist/, bounded, so we can prove the packlist carries ALL of them
// (a missing runtime asset is as bad as an extra secret). Symlinks are not followed.
async function countDistJs(distDir) {
  let count = 0, unreadable = 0, seen = 0;
  async function walk(dir, depth) {
    if (depth > SCAN_LIMITS.maxDepth || seen >= SCAN_LIMITS.maxFiles) { unreadable++; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (safeCause(error) !== "ENOENT") unreadable++; return; }
    for (const ent of entries) {
      seen++;
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) { unreadable++; continue; }
      if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
      if (ent.isFile() && ent.name.endsWith(".js")) count++;
    }
  }
  await walk(distDir, 0);
  return { count, unreadable };
}

// Map the CURRENT source tree to the runtime .js the package is expected to carry. tsc emits one dist/<same-rel>.js
// per compiled module (rootDir=src, outDir=dist, no bundling; declaration/map files land beside them but are
// excluded by the `files` allowlist), so `src/a/b.ts` -> `dist/a/b.js`. This walks directory ENTRIES only — it
// never opens a source file, so no src byte/secret is read. `.d.ts` inputs (no emit) are skipped. Returns the
// expected dist-js path set plus an unreadable counter (any limit hit / read error => UNKNOWN, never "empty").
async function expectedRuntimeJsSet(root) {
  const srcDir = join(root, "src");
  const set = new Set();
  let unreadable = 0, seen = 0;
  async function walk(dir, depth) {
    if (depth > SCAN_LIMITS.maxDepth || seen >= SCAN_LIMITS.maxFiles) { unreadable++; return; }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) { if (safeCause(error) !== "ENOENT") unreadable++; return; }
    for (const ent of entries) {
      seen++;
      const full = join(dir, ent.name);
      if (ent.isSymbolicLink()) { unreadable++; continue; }
      if (ent.isDirectory()) { await walk(full, depth + 1); continue; }
      if (!ent.isFile()) continue;
      if (!ent.name.endsWith(".ts") || ent.name.endsWith(".d.ts")) continue;
      const rel = relative(srcDir, full).replace(/\\/g, "/");
      set.add("dist/" + rel.replace(/\.ts$/, ".js"));
    }
  }
  await walk(srcDir, 0);
  return { set, unreadable };
}

// Compare the pack's dist-js paths against the expected-from-source set. `orphan` = shipped but no source (stale
// build output, the defect this closes); `missing` = a current source module absent from the pack. Both lists hold
// only in-repo dist/* build-output names (never a secret or foreign path).
function diffRuntimeSet(packDistJs, expectedSet) {
  const packSet = new Set(packDistJs);
  const orphan = packDistJs.filter((p) => !expectedSet.has(p)).sort();
  const missing = [...expectedSet].filter((p) => !packSet.has(p)).sort();
  return { orphan, missing };
}

// Parse `npm pack --dry-run --json` stdout into a sorted array of packlist paths. npm's JSON shape has varied by
// version: a top-level array of `{files:[{path}]}`, a bare `{files:[...]}`, or (npm 12) an object keyed by
// package name whose value carries `files`. We collect `files[].path` from whichever shape appears. Notices
// land on stderr; we isolate the JSON body defensively.
function collectFilesArray(node) {
  return node && typeof node === "object" && Array.isArray(node.files) ? node.files : [];
}
function parsePackManifest(stdout) {
  let parsed;
  try { parsed = JSON.parse(stdout); }
  catch {
    const oa = stdout.indexOf("["), ca = stdout.lastIndexOf("]");
    const oo = stdout.indexOf("{"), co = stdout.lastIndexOf("}");
    let slice = null;
    if (oa !== -1 && ca > oa && (oo === -1 || oa < oo)) slice = stdout.slice(oa, ca + 1);
    else if (oo !== -1 && co > oo) slice = stdout.slice(oo, co + 1);
    if (slice === null) throw new Error("pack-json-unparseable");
    parsed = JSON.parse(slice);
  }
  let files = [];
  if (Array.isArray(parsed)) files = parsed.flatMap(collectFilesArray);
  else if (Array.isArray(parsed?.files)) files = collectFilesArray(parsed);
  else if (parsed && typeof parsed === "object") files = Object.values(parsed).flatMap(collectFilesArray);
  return files.map((f) => String(f.path).replace(/\\/g, "/")).sort();
}

// ---- M5.1 stage A: declaration gate ---------------------------------------------------------------------
// A minimal runtime `files` allowlist MUST exist BEFORE any pack. Absent/empty => RED, and we refuse to pack.
// private:true must be preserved. Reports only shape facts (declared? private? count of patterns) — no paths.
async function declarationGate() {
  const pkg = await readPackageJson(repoRoot);
  const filesField = pkg.files;
  const declared = Array.isArray(filesField) && filesField.length > 0 && filesField.every((f) => typeof f === "string" && f.length > 0);
  const isPrivate = pkg.private === true;
  if (!declared) {
    record("m5.1-allowlist-declared", "FAIL", { reason: "package.json.files missing or empty", refuseToPack: true });
  } else {
    record("m5.1-allowlist-declared", "PASS", { patternCount: filesField.length });
  }
  if (!isPrivate) record("m5.1-private-preserved", "FAIL", { reason: "private:true not set" });
  else record("m5.1-private-preserved", "PASS");
  return { declared, isPrivate, patternCount: declared ? filesField.length : 0 };
}

// ---- M5.1 stage B: pack manifest verification -----------------------------------------------------------
// After a build, verify EVERY packlist path against the authoritative allowlist classifier, cross-check that
// every dist/*.js on disk is present (no missing runtime asset), and independently label any violation.
async function verifyPackManifest() {
  const res = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=warn"], repoRoot);
  if (res.code !== 0) {
    record("m5.1-pack-dryrun", "FAIL", { exit: res.code });
    return { ok: false, blocked: false, manifestCount: 0, violations: [], distJsInPack: 0, distJsOnDisk: 0 };
  }
  let paths;
  try { paths = parsePackManifest(res.out); }
  catch { record("m5.1-pack-dryrun", "FAIL", { reason: "manifest-unparseable" }); return { ok: false, blocked: false, manifestCount: 0, violations: [], distJsInPack: 0, distJsOnDisk: 0 }; }

  const violations = [];
  let distJsInPack = 0;
  for (const p of paths) {
    const category = classifyPackPath(p);
    if (category === null) violations.push({ label: forbiddenLabel(p) });
    else if (category === "runtime:dist-js") distJsInPack++;
  }
  const disk = await countDistJs(join(repoRoot, "dist"));
  const hasPackageJson = paths.includes("package.json");
  const complete = disk.unreadable === 0 && distJsInPack === disk.count && disk.count > 0;

  // Source-matched gate: the shipped dist-js set must equal the set expected from the CURRENT src tree. A `.js`
  // extension alone is NOT proof of content safety — a stale orphan (source since deleted) also ends in `.js` and
  // sits at an allowlisted `dist/**/*.js` path, yet must never ship. orphan>0 or missing>0 => FAIL.
  const packDistJs = paths.filter((p) => p.startsWith("dist/") && p.endsWith(".js")).sort();
  const expected = await expectedRuntimeJsSet(repoRoot);
  const { orphan, missing } = diffRuntimeSet(packDistJs, expected.set);
  const sourceMatched = expected.unreadable === 0 && expected.set.size > 0 && orphan.length === 0 && missing.length === 0;

  record("m5.1-pack-no-violations", violations.length === 0 ? "PASS" : "FAIL", { violationCount: violations.length, labels: [...new Set(violations.map((v) => v.label))].sort() });
  record("m5.1-pack-has-metadata", hasPackageJson ? "PASS" : "FAIL");
  record("m5.1-pack-runtime-complete", complete ? "PASS" : "FAIL", { distJsInPack, distJsOnDisk: disk.count, diskUnreadable: disk.unreadable });
  record("m5.1-pack-source-matched", sourceMatched ? "PASS" : "FAIL", {
    orphanCount: orphan.length, missingCount: missing.length, expectedCount: expected.set.size,
    packDistJs: packDistJs.length, srcUnreadable: expected.unreadable, orphan, missing,
  });

  const ok = violations.length === 0 && hasPackageJson && complete && sourceMatched;
  return { ok, blocked: false, manifestCount: paths.length, violations, distJsInPack, distJsOnDisk: disk.count, orphanCount: orphan.length, missingCount: missing.length };
}

// ---- M5.2 stage: installed CLI in a cold fixture-root ---------------------------------------------------
// Classify a NON-ZERO `npm install --offline` failure from its stderr SIGNATURE only. We read the text to
// match KNOWN codes and return a synthetic label; the raw stderr (which carries absolute cache/log paths) is
// NEVER stored, returned, or printed. Precedence is package-error > fs-error > cache-miss > unclassified, so a
// corrupt tarball or a permission failure can NEVER be laundered as an accepted cache-miss:
//   package-error       -> the tarball/manifest itself is bad (unreadable archive, integrity/checksum mismatch,
//                          unresolvable target): a REAL failure => FAIL.
//   fs-error            -> a filesystem/permission failure (EACCES/EPERM/ENOSPC/EROFS/...): a REAL failure => FAIL.
//                          npm's generic "only-if-cached" phrasing often rides along in --offline EACCES output,
//                          so this MUST be told apart from a true miss — it is never an accepted cache-miss.
//   offline-cache-miss  -> the SPECIFIC npm code ENOTCACHED: `--offline` had no cached packument for a required
//                          spec, a genuine environment-imposed BLOCKED. Recognized ONLY by ENOTCACHED, never by
//                          the generic "only-if-cached" phrase. Never an online fallback.
//   unclassified        -> a non-zero exit whose cause we cannot positively attribute => reported honestly as
//                          BLOCKED:offline-install-unclassified (never claimed as cache-miss, never accepted).
const CACHE_MISS_RE = /^\s*npm (?:error|ERR!) code ENOTCACHED(?:\s|$)/mi;
const FS_ERROR_RE = /\bEACCES\b|\bEPERM\b|\bENOSPC\b|\bEROFS\b|\bEMFILE\b|\bENFILE\b|\bEBUSY\b/;
const PACKAGE_ERROR_RE = /\bTAR_BAD_ARCHIVE\b|\bEINTEGRITY\b|\bETARGET\b|\bEBADPLATFORM\b|Unrecognized archive|integrity check(?:sum)?|checksum failed|zlib|gunzip|invalid (?:tar|gzip|archive|package)|corrupt(?:ed)?/i;
function classifyInstallFailure(stderr) {
  const text = typeof stderr === "string" ? stderr : "";
  if (PACKAGE_ERROR_RE.test(text)) return "package-error";
  if (FS_ERROR_RE.test(text)) return "fs-error";
  if (CACHE_MISS_RE.test(text)) return "offline-cache-miss";
  return "unclassified";
}

// Child env: start from ours, strip anything credential/plugin-shaped, then pin the three fixture data roots
// LAST (so a stripped name can't drop them). HOME/USERPROFILE are deliberately left as-is.
function childEnv(roots) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/API|TOKEN|SECRET|COOKIE|PASSWORD|CREDENTIAL|VAULT|PLUGIN/i.test(key)) delete env[key];
  }
  delete env.PROVIDER_DOCK_PLUGINS;
  env.PROVIDER_DOCK_HOME = roots.dock;
  env.CODEX_HOME = roots.codex;
  env.CLAUDE_CONFIG_DIR = roots.claude;
  return env;
}

// Commands we are willing to run through the installed bin: read-only, no provider/OMP/upstream/browser.
const SAFE_COMMANDS = [["--help"], ["providers", "list", "--json"]];
const UNSAFE_FIRST_TOKEN = new Set(["dashboard", "launch", "doctor", "probe", "recover", "health", "import", "open"]);
function assertStaticallySafe() {
  const unsafe = SAFE_COMMANDS.filter((cmd) => cmd.length === 0 || UNSAFE_FIRST_TOKEN.has(cmd[0]));
  record("m5.2-commands-static-safe", unsafe.length === 0 ? "PASS" : "FAIL", { commandCount: SAFE_COMMANDS.length });
  return unsafe.length === 0;
}

async function freshRoots(tag) {
  const dock = await makeRoot(`${tag}-dock`);
  const codex = await makeRoot(`${tag}-codex`);
  const claude = await makeRoot(`${tag}-claude`);
  return { dock, codex, claude };
}

// A FAIL return before any real install was attempted (static-unsafe, pack failure). All independent M5.2
// fields are present so the emitted JSON shape stays stable regardless of where we bailed.
function installFail(failedChecks) {
  return { status: "FAIL", installedBinVerified: false, npmOfflineInstall: "FAIL", installedArtifactSource: "none", depSource: "none", failedChecks };
}

async function verifyInstalledCli() {
  if (!assertStaticallySafe()) return installFail(["m5.2-commands-static-safe"]);

  const tmpPack = await makeRoot("pack");
  const packRes = await runNpm(["pack", "--pack-destination", tmpPack, "--ignore-scripts", "--loglevel=warn"], repoRoot);
  if (packRes.code !== 0) { record("m5.2-pack-tarball", "FAIL", { exit: packRes.code }); return installFail(["m5.2-pack-tarball"]); }
  const tarballs = (await readdir(tmpPack)).filter((f) => f.endsWith(".tgz"));
  if (tarballs.length !== 1) { record("m5.2-pack-tarball", "FAIL", { tgzCount: tarballs.length }); return installFail(["m5.2-pack-tarball"]); }
  record("m5.2-pack-tarball", "PASS", { tgzCount: 1 });
  const tarball = join(tmpPack, tarballs[0]);

  // The REAL, honest offline install of the just-built tarball. Its outcome is reported INDEPENDENTLY of the
  // tarball-extract bin check below: a green extract can never rename a blocked/failed offline install to PASS.
  const tmpInstall = await makeRoot("install");
  await writeFile(join(tmpInstall, "package.json"), JSON.stringify({ name: "install-probe", version: "1.0.0", private: true }), "utf8");
  const installRes = await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], tmpInstall);

  let installedCli = null;
  let npmOfflineInstall, installedArtifactSource, depSource;
  if (installRes.code === 0) {
    npmOfflineInstall = "PASS";
    record("m5.2-offline-install", "PASS", { npmOfflineInstall });
    const installedPkgDir = join(tmpInstall, "node_modules", "provider-dock");
    let binRel;
    try {
      const installedPkg = await readPackageJson(installedPkgDir);
      binRel = typeof installedPkg.bin === "string" ? installedPkg.bin : installedPkg.bin?.providerdock;
    } catch { binRel = undefined; }
    if (!binRel) { record("m5.2-installed-bin", "FAIL", { reason: "no-bin-entry" }); return { status: "FAIL", installedBinVerified: false, npmOfflineInstall, installedArtifactSource: "npm-offline", depSource: "npm-cache", failedChecks: ["m5.2-installed-bin"] }; }
    installedCli = join(installedPkgDir, binRel.replace(/\\/g, "/"));
    record("m5.2-installed-bin", "PASS", { source: "npm-offline" });
    installedArtifactSource = "npm-offline";
    depSource = "npm-cache";
  } else {
    // Non-zero exit: classify from the stderr SIGNATURE only (raw stderr, which carries absolute cache/log
    // paths, never leaves this process).
    const failureClass = classifyInstallFailure(installRes.err);
    if (failureClass === "package-error" || failureClass === "fs-error") {
      // A REAL failure — either the package/integrity itself (bad archive, checksum mismatch, unresolvable
      // target) or a filesystem/permission fault (EACCES/EPERM/ENOSPC/...). FAIL with no fallback and no raw
      // stderr — NEVER excused as a cache-miss even when npm's generic "only-if-cached" phrasing rides along.
      npmOfflineInstall = "FAIL";
      record("m5.2-offline-install", "FAIL", { exit: installRes.code, failureClass });
      return { status: "FAIL", installedBinVerified: false, npmOfflineInstall, installedArtifactSource: "none", depSource: "none", failedChecks: ["m5.2-offline-install"] };
    }
    // Honest BLOCKED: `--offline` had no cached packument for a required spec — a genuine cache-miss recognized
    // by the SPECIFIC ENOTCACHED code — or a non-zero exit we cannot positively attribute (unclassified —
    // reported as its own status, never as accepted or as cache-miss). NEVER an online fallback. We still
    // exercise the INSTALLED bin from the SAME packed artifact via fully-offline tarball extraction — the one
    // declared runtime dep (zod) comes from the machine's existing offline package store, not the source
    // checkout, not the network — so a real installed copy (not
    // repoRoot/dist) runs. This bin check is INDEPENDENT of the offline-install verdict and can never raise it.
    npmOfflineInstall = failureClass === "offline-cache-miss" ? "BLOCKED:offline-cache-miss" : "BLOCKED:offline-install-unclassified";
    record("m5.2-offline-install", failureClass === "offline-cache-miss" ? "BLOCKED" : "BLOCKED-UNCLASSIFIED", { exit: installRes.code, failureClass, npmOfflineInstall });
    const extracted = await extractInstalledArtifact(tarball);
    const blockedStatus = npmOfflineInstall === "BLOCKED:offline-cache-miss" ? "BLOCKED" : "BLOCKED-UNCLASSIFIED";
    if (!extracted.ok) { record("m5.2-tarball-extract", "BLOCKED", { reason: extracted.reason }); return { status: blockedStatus, installedBinVerified: false, npmOfflineInstall, installedArtifactSource: "none", depSource: "none", failedChecks: [] }; }
    record("m5.2-tarball-extract", "PASS");
    record("m5.2-installed-bin", "PASS", { source: "tarball-extract-offline" });
    installedCli = extracted.cli;
    installedArtifactSource = "tarball-extract-offline";
    depSource = "local-offline-store";
  }

  const scenarios = await runInstalledScenarios(installedCli);
  const installedBinVerified = scenarios.installedBinVerified === true;
  // Overall M5.2 verdict. PASS only when the REAL offline install passed AND the installed bin verified. A
  // verified bin over a BLOCKED offline install stays BLOCKED (honest env limitation); an unclassified block
  // keeps its own non-accepted status so it can never be silently counted as success.
  let status;
  if (!installedBinVerified) status = "FAIL";
  else if (npmOfflineInstall === "PASS") status = "PASS";
  else if (npmOfflineInstall === "BLOCKED:offline-cache-miss") status = "BLOCKED";
  else status = "BLOCKED-UNCLASSIFIED";
  return { status, installedBinVerified, npmOfflineInstall, installedArtifactSource, depSource, failedChecks: scenarios.failedChecks };
}

// Extract the packed tarball (the real distribution bytes) into an isolated temp node_modules and satisfy its
// single declared runtime dependency (zod) from the machine's existing offline package store. Returns the path
// to the INSTALLED bin, or a BLOCKED reason. No network, no source-checkout code standing in for the package.
async function extractInstalledArtifact(tarball) {
  const zodSrc = join(repoRoot, "node_modules", "zod");
  try { await stat(zodSrc); } catch { return { ok: false, reason: "local-dep-store-absent" }; }
  const root = await makeRoot("extract");
  const nm = join(root, "node_modules");
  await mkdir(nm, { recursive: true });
  // Extract with cwd=nm and a RELATIVE archive name so GNU tar can't read the Windows drive-letter colon as a
  // remote `host:file` spec (the classic tar-on-Windows failure). Works for GNU tar and bsdtar alike.
  await cp(tarball, join(nm, "pkg.tgz"));
  const tarRes = await runTool("tar", ["-xzf", "pkg.tgz"], nm);
  await rm(join(nm, "pkg.tgz"), { force: true });
  if (tarRes.code !== 0) return { ok: false, reason: "tar-failed" };
  try { await rename(join(nm, "package"), join(nm, "provider-dock")); }
  catch { return { ok: false, reason: "artifact-layout-unexpected" }; }
  try { await cp(zodSrc, join(nm, "zod"), { recursive: true }); }
  catch { return { ok: false, reason: "dep-copy-failed" }; }
  const cli = join(nm, "provider-dock", "dist", "cli.js");
  try { await stat(cli); } catch { return { ok: false, reason: "installed-bin-missing" }; }
  return { ok: true, cli };
}

// Exercise the INSTALLED bin in cold fixture roots: `--help`, an empty `providers list --json`, and one safe
// noninteractive user path (create a fictional provider, read it back, confirm the write landed in a temp dock
// root). Each is cross-checked against the SAME command on the SOURCE build; disagreement is a FAIL (installed
// errors are never masked by a green source smoke). Only booleans/counts are recorded — never the CLI's stdout
// bytes. Returns { installedBinVerified, failedChecks }; the caller keeps this independent of the offline-install
// verdict, so a verified bin can never rename a BLOCKED/FAILED `npm install --offline` to PASS.
async function runInstalledScenarios(installedCli) {
  const failed = [];
  const flag = (name, pass, detail) => { record(name, pass ? "PASS" : "FAIL", detail); if (!pass) failed.push(name); };

  // Installed --help
  const iRoots = await freshRoots("installed");
  const help = await runNode([installedCli, "--help"], childEnv(iRoots), tmpdir());
  const helpBody = help.out || "";
  flag("m5.2-installed-help", help.code === 0 && /ProviderDock management CLI/.test(helpBody) && /Usage:/.test(helpBody), { exit: help.code });

  // Installed `providers list --json` on an EMPTY fixture root -> [] ; must NOT self-describe as imported/ready.
  const listRoots = await freshRoots("installed-list");
  const list = await runNode([installedCli, "providers", "list", "--json"], childEnv(listRoots), tmpdir());
  let installedEmpty = false;
  try { const arr = JSON.parse((list.out || "").trim()); installedEmpty = Array.isArray(arr) && arr.length === 0; } catch { installedEmpty = false; }
  const overclaims = /imported|production-ready|"ready"\s*:\s*true/i.test(list.out || "");
  flag("m5.2-installed-list-empty", list.code === 0 && installedEmpty, { exit: list.code });
  flag("m5.2-installed-empty-not-overclaimed", !overclaims && installedEmpty);

  // SOURCE build, same command, its own cold root -> compare.
  const srcRoots = await freshRoots("source-list");
  const srcCli = join(repoRoot, "dist", "cli.js");
  const src = await runNode([srcCli, "providers", "list", "--json"], childEnv(srcRoots), repoRoot);
  let sourceEmpty = false;
  try { const arr = JSON.parse((src.out || "").trim()); sourceEmpty = Array.isArray(arr) && arr.length === 0; } catch { sourceEmpty = false; }
  const agree = src.code === list.code && sourceEmpty === installedEmpty;
  flag("m5.2-source-vs-installed-agree", agree, { sourceExit: src.code, installedExit: list.code });

  // A safe, noninteractive, fixture-only USER path: create a fictional provider through the installed bin, then
  // read it back. No network (the base URL is a non-routable .invalid host and no request is ever made) and no
  // secret (auth kind stays "none"). A unique canary rides in the display name + URL path so we can POSITIVELY
  // locate the persisted bytes UNDER the temp dock root — a real write-landed proof, not a vacuous absent scan.
  const canaryTok = "PDPROBE" + randomUUID().replace(/-/g, "");
  const fictionalId = "fixture-omp-probe";
  const setArgs = ["providers", "set", "--id", fictionalId, "--name", canaryTok, "--base-url", `https://fixture.invalid/${canaryTok}`];

  const uxRoots = await freshRoots("installed-userpath");
  const iSet = await runNode([installedCli, ...setArgs], childEnv(uxRoots), tmpdir());
  flag("m5.2-installed-set-writes", iSet.code === 0 && /Saved provider 'fixture-omp-probe'/.test(iSet.out || ""), { exit: iSet.code });
  const iShow = await runNode([installedCli, "providers", "show", fictionalId], childEnv(uxRoots), tmpdir());
  let iShowOk = false;
  try { const p = JSON.parse((iShow.out || "").trim()); iShowOk = !!p && p.id === fictionalId && typeof p.baseUrl === "string" && p.baseUrl.includes(canaryTok); } catch { iShowOk = false; }
  flag("m5.2-installed-show-reads-back", iShow.code === 0 && iShowOk, { exit: iShow.code });
  const iList = await runNode([installedCli, "providers", "list", "--json"], childEnv(uxRoots), tmpdir());
  let iListOne = false;
  try { const arr = JSON.parse((iList.out || "").trim()); iListOne = Array.isArray(arr) && arr.length === 1 && JSON.stringify(arr).includes(fictionalId); } catch { iListOne = false; }
  flag("m5.2-installed-list-after-set", iList.code === 0 && iListOne, { exit: iList.code });

  // POSITIVE control: the persisted profile MUST be found under the temp dock root (the canary is present there).
  // Had the data landed anywhere else, this scan reads 0 leaks and the check FAILS — the opposite of the old
  // absent-marker scan, which could never fail. Any unreadable region is UNKNOWN, never counted as "clean".
  const wrote = await canaryScan(uxRoots.dock, [canaryTok]);
  flag("m5.2-installed-write-lands-in-temp-root", wrote.leaks >= 1 && wrote.unreadable === 0, { leaks: wrote.leaks, unreadable: wrote.unreadable });

  // SOURCE build, SAME user path, its own cold root -> the installed bin must AGREE with source (persist + read
  // back the same fictional profile). Disagreement is a FAIL; a green source smoke never masks an installed break.
  const sxRoots = await freshRoots("source-userpath");
  await runNode([srcCli, ...setArgs], childEnv(sxRoots), repoRoot);
  const sShow = await runNode([srcCli, "providers", "show", fictionalId], childEnv(sxRoots), repoRoot);
  let sShowOk = false;
  try { const p = JSON.parse((sShow.out || "").trim()); sShowOk = !!p && p.id === fictionalId && typeof p.baseUrl === "string" && p.baseUrl.includes(canaryTok); } catch { sShowOk = false; }
  flag("m5.2-source-vs-installed-userpath-agree", sShow.code === iShow.code && sShowOk === iShowOk, { sourceExit: sShow.code, installedExit: iShow.code });

  // Foreign-home safety is NOT PROVEN by these fixtures: we did NOT (and must not) scan a real HOME/USERPROFILE
  // for our absence. What IS established: the data route is local and home-var driven (static analysis of
  // resolveProviderDockPaths -> PROVIDER_DOCK_HOME) and every write above landed under a temp dock root. The
  // installed bin ran with temp PROVIDER_DOCK_HOME/CODEX_HOME/CLAUDE_CONFIG_DIR; HOME/USERPROFILE were left as-is
  // in the env but their directories were deliberately never inspected. Reported honestly, never as PASS.
  record("m5.2-foreign-home-isolation", "NOT-PROVEN", { basis: "static-route+temp-root-write-verified", scannedRealHome: false });

  const installedBinVerified = failed.length === 0;
  return { installedBinVerified, failedChecks: failed };
}

// ---- negative suite: prove the allowlist has teeth ------------------------------------------------------
// Build a throwaway package (never the real repo) with a fictional decoy secret and a dummy runtime file. With
// NO `files` field npm carries the decoy (control: non-vacuous). With `files:["dist/**/*.js"]` — and NO
// .npmignore/.gitignore excluding it — the decoy MUST vanish from the manifest. Proves exclusion is the
// allowlist's doing, not an incidental ignore. No real `.env-key` is ever touched.
async function buildTempPackage(withAllowlist) {
  const dir = await makeRoot(withAllowlist ? "neg-allowlisted" : "neg-control");
  const canary = `PACKAGE_SAFETY_DECOY_${randomUUID()}`;
  const pkg = { name: "decoy-probe", version: "1.0.0", private: true, bin: { decoy: "dist/cli.js" } };
  if (withAllowlist) pkg.files = ["dist/**/*.js"];
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(join(dir, "dist", "cli.js"), "#!/usr/bin/env node\nprocess.exit(0);\n", "utf8");
  await writeFile(join(dir, "decoy-secret.txt"), canary + "\n", "utf8");
  return { dir, decoyName: "decoy-secret.txt", canary };
}

// Negative fixture for the SOURCE-MATCHED gate: a package whose dist/ carries a stale orphan `.js` with NO
// matching src/*.ts, sitting at an allowlisted `dist/**/*.js` path with no ignore-file excluding it. The blanket
// classifier waves it through (the old defect); the source-matched check must catch it. Removing the orphan then
// goes GREEN. A single root-level decoy is NOT enough — this proves a plausibly-allowlisted stale runtime file is
// still rejected.
async function buildTempOrphanPackage() {
  const dir = await makeRoot("neg-orphan");
  const pkg = { name: "orphan-probe", version: "1.0.0", private: true, files: ["dist/**/*.js"], bin: { orphan: "dist/cli.js" } };
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2), "utf8");
  await mkdir(join(dir, "src"), { recursive: true });
  await mkdir(join(dir, "dist", "ui"), { recursive: true });
  // One legitimate source-matched module: src/cli.ts -> dist/cli.js.
  await writeFile(join(dir, "src", "cli.ts"), "export const ok = 1;\n", "utf8");
  await writeFile(join(dir, "dist", "cli.js"), "export const ok = 1;\n", "utf8");
  // One STALE orphan: present in dist, absent from src (a plausible former module name).
  await writeFile(join(dir, "dist", "ui", "portal-legacy-login.js"), "export const gone = true;\n", "utf8");
  return { dir, orphanRel: "dist/ui/portal-legacy-login.js", validRel: "dist/cli.js" };
}
const packDistJsOf = (res) => (res.code === 0 ? parsePackManifest(res.out) : []).filter((p) => p.startsWith("dist/") && p.endsWith(".js")).sort();

async function negativeMain() {
  const result = { mode: "negative", checks, ok: false };
  try {
    const npmHome = await makeNpmHome();
    const priorRegistry = process.env.NPM_CONFIG_REGISTRY;
    process.env.NPM_CONFIG_REGISTRY = "https://fixture.invalid/never-used";
    try { npmEnv = makeNpmEnv(npmHome); }
    finally {
      if (priorRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = priorRegistry;
    }
    // Capture the REAL runNpm spawn options without launching npm. A missing `env` must stop the negative
    // suite before any actual npm child can inherit a user's cache/config; the old runNpm wiring goes RED.
    let capturedEnv;
    const fakeSpawn = (...args) => {
      capturedEnv = args.at(-1)?.env;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => child.emit("close", 0));
      return child;
    };
    await runNpm(["--version"], repoRoot, fakeSpawn);
    const pinned = ["cache", "userconfig", "globalconfig", "prefix"].every((key) =>
      capturedEnv?.[`npm_config_${key}`] === npmHome[key]);
    const noInheritedConfig = capturedEnv && !Object.keys(capturedEnv).some((key) =>
      /^npm_config_/i.test(key) && !["cache", "userconfig", "globalconfig", "prefix", "update_notifier"].includes(key.slice(11).toLowerCase()));
    const childEnvWired = pinned && noInheritedConfig && capturedEnv?.NPM_CONFIG_REGISTRY === undefined;
    record("neg-npm-child-env-isolated", childEnvWired ? "PASS" : "FAIL");
    if (!childEnvWired) throw new Error("fixture-env-not-isolated");
    await proveNpmIsolation(npmHome);
    // 1) Control: without an allowlist npm carries the decoy (otherwise the exclusion test would be vacuous).
    const control = await buildTempPackage(false);
    const cRes = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=warn"], control.dir);
    const cPaths = cRes.code === 0 ? parsePackManifest(cRes.out) : [];
    const decoyIncludedByDefault = cPaths.includes(control.decoyName);
    record("neg-control-decoy-included", decoyIncludedByDefault ? "PASS" : "FAIL", { manifestCount: cPaths.length });

    // 2) Test: with the allowlist the decoy is excluded while the runtime asset survives.
    const test = await buildTempPackage(true);
    const tRes = await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=warn"], test.dir);
    const tPaths = tRes.code === 0 ? parsePackManifest(tRes.out) : null;
    const decoyExcluded = Array.isArray(tPaths) && !tPaths.includes(test.decoyName);
    const runtimeKept = Array.isArray(tPaths) && tPaths.includes("dist/cli.js");
    const noCanaryInManifest = Array.isArray(tPaths) && !tPaths.some((p) => p.includes(test.canary));
    record("neg-allowlist-excludes-decoy", decoyExcluded ? "PASS" : "FAIL");
    record("neg-allowlist-keeps-runtime", runtimeKept ? "PASS" : "FAIL");
    record("neg-manifest-no-canary", noCanaryInManifest ? "PASS" : "FAIL");

    // 3) Declaration gate teeth: the real package.json with `files` stripped must read as NOT declared.
    const realPkg = await readPackageJson(repoRoot);
    const stripped = { ...realPkg }; delete stripped.files;
    const strippedDeclared = Array.isArray(stripped.files) && stripped.files.length > 0;
    record("neg-declaration-gate-teeth", !strippedDeclared ? "PASS" : "FAIL");

    // 4) Source-matched teeth: an allowlisted-but-orphan dist/*.js is caught, and removing it goes GREEN.
    const orphanFix = await buildTempOrphanPackage();
    const oPack = packDistJsOf(await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=warn"], orphanFix.dir));
    // (a) Non-vacuous: the orphan really lands in the manifest at an allowlisted path, and the OLD blanket
    //     classifier would have accepted it — so the source-matched check is what closes the gap.
    const orphanInManifest = oPack.includes(orphanFix.orphanRel);
    const blanketWouldPass = classifyPackPath(orphanFix.orphanRel) === "runtime:dist-js";
    record("neg-orphan-in-manifest", orphanInManifest ? "PASS" : "FAIL", { packDistJs: oPack.length });
    record("neg-orphan-blanket-would-pass", blanketWouldPass ? "PASS" : "FAIL");
    // (b) RED: the source-matched check flags the orphan.
    const expBefore = await expectedRuntimeJsSet(orphanFix.dir);
    const diffBefore = diffRuntimeSet(oPack, expBefore.set);
    const orphanCaught = diffBefore.orphan.includes(orphanFix.orphanRel);
    record("neg-orphan-source-check-catches", orphanCaught ? "PASS" : "FAIL", { orphanCount: diffBefore.orphan.length });
    // (c) GREEN: remove the orphan -> pack set equals source set, runtime kept.
    await rm(join(orphanFix.dir, "dist", "ui", "portal-legacy-login.js"), { force: true });
    const gPack = packDistJsOf(await runNpm(["pack", "--dry-run", "--json", "--ignore-scripts", "--loglevel=warn"], orphanFix.dir));
    const expAfter = await expectedRuntimeJsSet(orphanFix.dir);
    const diffAfter = diffRuntimeSet(gPack, expAfter.set);
    const orphanGreen = diffAfter.orphan.length === 0 && diffAfter.missing.length === 0 && gPack.includes(orphanFix.validRel);
    record("neg-orphan-removal-green", orphanGreen ? "PASS" : "FAIL", { orphanCount: diffAfter.orphan.length, missingCount: diffAfter.missing.length });

    // 5) Install-failure classifier teeth: the M5.2 classifier must tell a genuine offline cache-miss (BLOCKED)
    //    from a real package/integrity failure or a filesystem/permission fault (both FAIL), never laundering
    //    either as a cache-miss. First the pure decision function on synthetic signatures, then two REAL offline
    //    `npm install` failures.
    const uCacheMiss = classifyInstallFailure("npm error code ENOTCACHED\nnpm error request ... cache mode is 'only-if-cached' but no cached response is available") === "offline-cache-miss";
    const uBadArchive = classifyInstallFailure("npm error code TAR_BAD_ARCHIVE: Unrecognized archive format") === "package-error";
    const uIntegrity = classifyInstallFailure("npm error code EINTEGRITY sha512-deadbeef integrity checksum failed when unpacking") === "package-error";
    const uUnknown = classifyInstallFailure("npm error some unfamiliar failure with no known code") === "unclassified";
    // Precedence: stderr carrying BOTH the genuine cache-miss code (ENOTCACHED) AND a package-integrity token is
    // a package-error, never a cache-miss (a corrupt artifact is never excused as a miss, even mid-cache-miss).
    const uPrecedence = classifyInstallFailure("npm error code ENOTCACHED ... npm error code EINTEGRITY integrity checksum failed") === "package-error";
    record("neg-classify-cache-miss", uCacheMiss ? "PASS" : "FAIL");
    record("neg-classify-bad-archive", uBadArchive ? "PASS" : "FAIL");
    record("neg-classify-integrity", uIntegrity ? "PASS" : "FAIL");
    record("neg-classify-unknown", uUnknown ? "PASS" : "FAIL");
    record("neg-classify-package-error-precedence", uPrecedence ? "PASS" : "FAIL");

    // 5b) ENOTCACHED specificity (the M5-R2.2 fix). A permission fault whose --offline stderr ALSO carries npm's
    //     generic "only-if-cached" phrasing must NOT be laundered as an accepted cache-miss. RED (non-vacuous):
    //     the OLD blanket signature (ENOTCACHED | only-if-cached) WOULD have accepted this EACCES failure as a
    //     miss. GREEN: the tightened classifier keys on the SPECIFIC ENOTCACHED code and returns fs-error (=> FAIL).
    const eaccesOnlyIfCached = "npm error code EACCES\nnpm error syscall mkdir\nnpm error errno -4048\nnpm error request failed, cache mode is 'only-if-cached' but no cached response is available";
    const OLD_BLANKET_CACHE_RE = /\bENOTCACHED\b|only-if-cached/i;               // the pre-fix (defective) signature, for contrast only
    const blanketWouldLaunder = OLD_BLANKET_CACHE_RE.test(eaccesOnlyIfCached) && !PACKAGE_ERROR_RE.test(eaccesOnlyIfCached);
    const eaccesIsFsError = classifyInstallFailure(eaccesOnlyIfCached) === "fs-error";
    record("neg-classify-eacces-old-blanket-would-launder", blanketWouldLaunder ? "PASS" : "FAIL");
    record("neg-classify-eacces-is-fs-error", eaccesIsFsError ? "PASS" : "FAIL");
    // ENOSPC is a filesystem fault, never a cache-miss.
    const uEnospc = classifyInstallFailure("npm error code ENOSPC no space left on device while writing cache") === "fs-error";
    record("neg-classify-enospc-is-fs-error", uEnospc ? "PASS" : "FAIL");
    // The generic "only-if-cached" phrase ALONE (no ENOTCACHED code) is NOT positively attributable => unclassified
    // (non-accepted BLOCKED-UNCLASSIFIED), NEVER an accepted offline-cache-miss.
    const uOnlyIfCachedAlone = classifyInstallFailure("npm warn cache mode is 'only-if-cached' but no cached response is available") === "unclassified";
    record("neg-classify-only-if-cached-alone-not-cache-miss", uOnlyIfCachedAlone ? "PASS" : "FAIL");
    const uMentionOnly = classifyInstallFailure("npm error code EUNKNOWN\nnpm error hint ENOTCACHED may occur in another request") === "unclassified";
    record("neg-classify-enotcached-mention-not-code", uMentionOnly ? "PASS" : "FAIL");

    // REAL malformed tarball, installed --offline: npm fails and the classifier must say package-error (=> FAIL),
    // NOT cache-miss. Bytes are plainly non-gzip so the archive read fails deterministically. No network.
    const badRoot = await makeRoot("neg-bad-tarball");
    await writeFile(join(badRoot, "package.json"), JSON.stringify({ name: "bad-install-probe", version: "1.0.0", private: true }), "utf8");
    const badTgz = join(badRoot, "corrupt-1.0.0.tgz");
    await writeFile(badTgz, "this is not a gzip tarball " + randomUUID(), "utf8");
    const badRes = await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", badTgz], badRoot);
    const badClass = classifyInstallFailure(badRes.err);
    const malformedIsPackageError = badRes.code !== 0 && badClass === "package-error";
    record("neg-malformed-tarball-is-package-error", malformedIsPackageError ? "PASS" : "FAIL", { exit: badRes.code, failureClass: badClass });

    // REAL uncached spec, installed --offline: only-if-cached has no packument => ENOTCACHED. The classifier must
    // say offline-cache-miss (=> honest BLOCKED), never package-error. Random unpublished name; no network.
    const missRoot = await makeRoot("neg-uncached-spec");
    await writeFile(join(missRoot, "package.json"), JSON.stringify({ name: "miss-install-probe", version: "1.0.0", private: true }), "utf8");
    const missRes = await runNpm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", `pd-not-cached-${randomUUID().replace(/-/g, "")}@1.0.0`], missRoot);
    const missClass = classifyInstallFailure(missRes.err);
    const uncachedIsCacheMiss = missRes.code !== 0 && missClass === "offline-cache-miss";
    record("neg-uncached-spec-is-cache-miss", uncachedIsCacheMiss ? "PASS" : "FAIL", { exit: missRes.code, failureClass: missClass });

    const failing = checks.filter((c) => c.status === "FAIL");
    result.ok = failing.length === 0 && decoyIncludedByDefault && decoyExcluded && runtimeKept
      && orphanInManifest && blanketWouldPass && orphanCaught && orphanGreen
      && uCacheMiss && uBadArchive && uIntegrity && uUnknown && uPrecedence
       && blanketWouldLaunder && eaccesIsFsError && uEnospc && uOnlyIfCachedAlone && uMentionOnly
      && malformedIsPackageError && uncachedIsCacheMiss;
    result.summary = { checks: checks.length, failing: failing.length };
  } catch (error) {
    record("negative-fatal", "FAIL", { cause: safeCause(error) });
    result.ok = false;
  } finally {
    await cleanup();
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

// ---- default suite: M5.1 declaration+pack, then M5.2 installed CLI --------------------------------------
async function main() {
  const result = { mode: "default", checks, ok: false };
  try {
    const npmHome = await makeNpmHome();
    npmEnv = makeNpmEnv(npmHome);
    await proveNpmIsolation(npmHome);
    const gate = await declarationGate();
    if (!gate.declared) {
      // RED, by design: refuse to pack until a minimal runtime allowlist is declared.
      result.m51 = { status: "RED-not-declared", declared: false, private: gate.isPrivate, packed: false };
      result.m52 = { status: "SKIPPED", reason: "allowlist-not-declared" };
      const failing = checks.filter((c) => c.status === "FAIL");
      result.summary = { checks: checks.length, failing: failing.length, failingNames: failing.map((c) => c.name) };
      result.ok = false;
      process.stdout.write(JSON.stringify(result) + "\n");
      process.exitCode = 1;
      return;
    }

    const pack = await verifyPackManifest();
    result.m51 = {
      status: pack.ok ? "PASS" : "FAIL", declared: true, private: gate.isPrivate, patternCount: gate.patternCount,
      manifestCount: pack.manifestCount, distJsInPack: pack.distJsInPack, distJsOnDisk: pack.distJsOnDisk,
      violationCount: pack.violations.length, orphanCount: pack.orphanCount, missingCount: pack.missingCount,
    };

    if (pack.ok) {
      const installed = await verifyInstalledCli();
      result.m52 = {
        status: installed.status,
        packageVerified: pack.ok === true,
        installedBinVerified: installed.installedBinVerified === true,
        npmOfflineInstall: installed.npmOfflineInstall,
        installedArtifactSource: installed.installedArtifactSource,
        depSource: installed.depSource,
        foreignHomeIsolation: "NOT-PROVEN",
      };
    } else {
      result.m52 = { status: "SKIPPED", reason: "m5.1-not-clean" };
    }

    const canary = await canaryScan(repoRoot + sep + "dist", ["__never_present_marker__"]);
    result.distScan = { scanned: canary.scanned, unreadable: canary.unreadable };

    const failing = checks.filter((c) => c.status === "FAIL");
    // Accepted M5.2 states: a genuine PASS, or an HONEST cache-miss BLOCKED. A package/integrity FAIL, a
    // FAILED bin, or an unclassified block ("BLOCKED-UNCLASSIFIED") is NEVER silently accepted here.
    const m52ok = result.m52.status === "PASS" || result.m52.status === "BLOCKED";
    result.ok = gate.declared && gate.isPrivate && pack.ok && m52ok && failing.length === 0;
    result.summary = { checks: checks.length, failing: failing.length, failingNames: failing.map((c) => c.name) };
  } catch (error) {
    record("default-fatal", "FAIL", { cause: safeCause(error) });
    result.ok = false;
    result.summary = { checks: checks.length, failing: checks.filter((c) => c.status === "FAIL").length };
  } finally {
    await cleanup();
  }
  process.stdout.write(JSON.stringify(result) + "\n");
  process.exitCode = result.ok ? 0 : 1;
}

const wantNegative = process.argv.includes("--negative");
(wantNegative ? negativeMain() : main()).catch((error) => {
  process.stdout.write(JSON.stringify({ mode: wantNegative ? "negative" : "default", ok: false, fatal: safeCause(error) }) + "\n");
  process.exitCode = 1;
});
