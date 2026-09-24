// The verified capability verdict for the pinned OMP importer (0c6c981e).
//
// This is a typed, fixture-independent restatement of what `planTranscriptImport`
// and the user preview are allowed to promise about a NATIVE OMP import. The
// facts here were verified by static inspection of the pinned checkout and are
// re-checked by `scripts/omp-import-probe.mjs`; see
// docs/omp-step5-import-blocker-2026-09-24.md for the evidence. Nothing here
// runs OMP, reads a real session, or hand-writes an OMP session file.

/** How a candidate can (or cannot) reach a real new OMP session, offline, here. */
export type OmpImportRoute =
  | "unsupported-automated-native-import"
  | "supported-context-transfer-adapter"; // A future, separately-approved path.

export interface OmpImportCapability {
  /** Upstream commit the verdict was verified against. */
  readonly pinnedCommit: string;
  /** The route reachable from this Node/vitest harness today. */
  readonly route: OmpImportRoute;
  /** Machine-readable, content-free reasons the automated route is blocked. */
  readonly blockers: readonly OmpImportBlocker[];
  /** Facts that ARE true of the importer, so we neither over- nor under-claim. */
  readonly supported: {
    /** The store classes accept an explicit source root (constructor arg). */
    readonly explicitSourceRootAtClassLevel: boolean;
    /** Import can target an isolated session dir (sessionDir option). */
    readonly isolatedTargetSessionDir: boolean;
    /** No network call or model inference on the import path. */
    readonly noNetworkOrInferenceOnImport: boolean;
  };
}

export type OmpImportBlocker =
  | "cli-factory-hardcodes-home-source-root"
  | "codex-store-requires-bun-sqlite-runtime"
  | "from-codex-from-claude-are-interactive-pickers";

export const PINNED_OMP_COMMIT = "0c6c981ee5838d97700180383077eb0a3790637c";

// Frozen so no caller can quietly upgrade the verdict to "supported".
export const OMP_IMPORT_CAPABILITY: OmpImportCapability = Object.freeze({
  pinnedCommit: PINNED_OMP_COMMIT,
  route: "unsupported-automated-native-import",
  blockers: Object.freeze([
    // createForeignSessionStore() builds the stores with no rootDirectory, so
    // the only Node-reachable entry reads ~/.codex / ~/.claude — which we may
    // not redirect without swapping the global HOME (forbidden).
    "cli-factory-hardcodes-home-source-root",
    // codex-session-store imports "bun:sqlite"; the package is Bun-only and
    // cannot be driven as a library from this Node harness.
    "codex-store-requires-bun-sqlite-runtime",
    // --from-codex/--from-claude open an interactive picker (exit 0 != import).
    "from-codex-from-claude-are-interactive-pickers",
  ]) as readonly OmpImportBlocker[],
  supported: Object.freeze({
    explicitSourceRootAtClassLevel: true,
    isolatedTargetSessionDir: true,
    noNetworkOrInferenceOnImport: true,
  }),
});

/** True only if a real, verified new-OMP-session import is reachable here. */
export function isAutomatedNativeImportSupported(
  capability: OmpImportCapability = OMP_IMPORT_CAPABILITY,
): boolean {
  return (
    capability.route !== "unsupported-automated-native-import" && capability.blockers.length === 0
  );
}
