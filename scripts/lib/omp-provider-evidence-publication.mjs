import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";

const maximumArtifactBytes = 4 * 1024 * 1024;
const forbiddenNames = new Set([
  "omp-provider-evidence.json",
  "omp-route-decisions.json",
]);

/**
 * Publication is intentionally limited to a separately-created assessment
 * directory. This synchronous check is lexical; the async writer also checks
 * the parent directory and destination identities before opening files.
 */
export function assertAssessmentOutputPath(filePath) {
  if (typeof filePath !== "string" || !isAbsolute(filePath) || filePath.length > 32_768) {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
  if (filePath.includes("\0") || /[?*<>|]/.test(filePath)) {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
  const parts = filePath.split(/[\\/]+/u);
  if (parts.some((part) => part === ".." || part === ".")) {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
  const normalized = resolve(filePath);
  const name = basename(normalized).toLowerCase();
  if (!name || forbiddenNames.has(name) || parts.some((part) => part.toLowerCase() === "migration")) {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
  // Windows alternate data streams and device-like names are not assessment
  // artifacts, even when the host accepts the spelling.
  const afterDrive = normalized.replace(/^[A-Za-z]:/u, "");
  if (afterDrive.includes(":")) throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  return normalized;
}

/**
 * Create the sanitized evidence and verification artifacts without replacing
 * an existing publication. A failed call may leave a new unverified artifact;
 * callers must never treat mere existence as verification.
 */
export async function writeExclusiveAssessmentArtifacts({
  snapshotPath,
  verificationPath,
  snapshotText,
  verificationText,
}) {
  const snapshot = assertAssessmentOutputPath(snapshotPath);
  const verification = assertAssessmentOutputPath(verificationPath);
  if (samePath(snapshot, verification) ||
      typeof snapshotText !== "string" || typeof verificationText !== "string" ||
      Buffer.byteLength(snapshotText, "utf8") > maximumArtifactBytes ||
      Buffer.byteLength(verificationText, "utf8") > maximumArtifactBytes) {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }

  const parent = dirname(snapshot);
  if (dirname(verification) !== parent) throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  await assertSafeAssessmentDirectory(parent);
  await assertDestinationAbsent(snapshot);
  await assertDestinationAbsent(verification);

  const handles = [];
  try {
    handles.push(await open(snapshot, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    handles.push(await open(verification, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600));
    await handles[0].writeFile(snapshotText, "utf8");
    await handles[0].sync();
    await handles[1].writeFile(verificationText, "utf8");
    await handles[1].sync();
  } catch (error) {
    if (hasCode(error, "EEXIST")) throw new Error("EVIDENCE_OUTPUT_EXISTS");
    throw new Error("EVIDENCE_OUTPUT_FAILED");
  } finally {
    await Promise.all(handles.map((handle) => handle.close().catch(() => undefined)));
  }
}

async function assertSafeAssessmentDirectory(directory) {
  let stat;
  try {
    stat = await lstat(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink !== 1n) {
      throw new Error();
    }
    const canonical = await realpath(directory);
    if (pathKey(canonical) !== pathKey(directory)) throw new Error();
  } catch {
    throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
}

async function assertDestinationAbsent(filePath) {
  try {
    const stat = await lstat(filePath, { bigint: true });
    if (stat.isSymbolicLink() || stat.nlink !== 1n) throw new Error();
    throw new Error("EVIDENCE_OUTPUT_EXISTS");
  } catch (error) {
    if (error?.message === "EVIDENCE_OUTPUT_EXISTS") throw error;
    if (!hasCode(error, "ENOENT")) throw new Error("UNSAFE_EVIDENCE_OUTPUT_PATH");
  }
}

function samePath(left, right) {
  return pathKey(left) === pathKey(right);
}

function pathKey(value) {
  const normalized = resolve(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function hasCode(error, code) {
  return error !== null && typeof error === "object" && "code" in error && error.code === code;
}
