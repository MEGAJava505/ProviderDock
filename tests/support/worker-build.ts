// Guarantees the compiled build a spawned worker imports is current.
//
// A cross-process test worker imports dist/ (there is no TS runtime for a child
// process), but `vitest run` never builds. This detects a stale or missing
// build and rebuilds once via `tsc -p tsconfig.build.json`.
//
// Staleness is judged against the WHOLE source tree, not one file's mtime: tsc
// emits the entire dist as a unit, so a change to ANY transitive dependency of
// the worker (not just the entry module) must trigger a rebuild. We compare the
// newest src/**/*.ts mtime against the oldest of the worker's required dist
// artifacts; a later source edit anywhere raises the former above the latter.
import { spawnSync } from "node:child_process";
import { stat } from "node:fs/promises";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function newestSourceMtime(dir: string): number {
  let newest = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, newestSourceMtime(full));
    else if (entry.name.endsWith(".ts")) newest = Math.max(newest, statSync(full).mtimeMs);
  }
  return newest;
}

export interface WorkerBuildResult {
  readonly rebuilt: boolean;
  readonly reason: string;
}

// `requiredDistFiles` are the worker's dist imports; a rebuild happens if any is
// missing OR older than the newest source file. Returns why, so a test can
// surface whether it ran on a fresh or already-current build.
export async function ensureWorkerBuild(
  root: string,
  requiredDistFiles: readonly string[],
): Promise<WorkerBuildResult> {
  const distStats = await Promise.all(
    requiredDistFiles.map((file) => stat(file).catch(() => undefined)),
  );
  const missing = requiredDistFiles.find((_, index) => distStats[index] === undefined);
  const srcNewest = newestSourceMtime(join(root, "src"));
  const distOldest = missing === undefined
    ? Math.min(...distStats.map((entry) => entry!.mtimeMs))
    : 0;
  if (missing === undefined && srcNewest <= distOldest) {
    return { rebuilt: false, reason: "dist current" };
  }
  const build = spawnSync(
    process.execPath,
    [join(root, "node_modules", "typescript", "bin", "tsc"), "-p", "tsconfig.build.json"],
    { cwd: root, encoding: "utf8" },
  );
  if (build.status !== 0) {
    throw new Error(`worker build failed (${build.status}): ${build.stderr || build.stdout}`);
  }
  return {
    rebuilt: true,
    reason: missing !== undefined ? `missing ${missing}` : "source newer than dist",
  };
}
