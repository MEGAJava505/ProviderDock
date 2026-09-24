// Read-only user preview over a fixture import plan.
//
// This produces a view model for a UI/service to render. It NEVER performs an
// import, NEVER reveals transcript content, tool arguments, secrets, or absolute
// paths, and NEVER promises that sessions are "restored" or that prior rights
// are re-activated. Every ready candidate is framed as a one-way transfer of
// transcript context into a NEW OMP session — not a native resume of the old
// CLI, which is unsupported (see ./omp-import-capability.ts).
import {
  isAutomatedNativeImportSupported,
  OMP_IMPORT_CAPABILITY,
  type OmpImportCapability,
} from "./omp-import-capability.js";
import type { ImportPlan, ImportPlanItem } from "./transcript-import-plan.js";

export type PreviewDisposition =
  | "context-transfer-ready"
  | "already-imported"
  | "duplicate"
  | "unsupported"
  | "corrupt"
  | "skipped";

export interface ImportPreviewRow {
  readonly client: ImportPlanItem["client"];
  /** Root-relative path only — never an absolute path outside the passed root. */
  readonly relativePath: string;
  /** Identifier only; never message content. */
  readonly sessionId?: string;
  readonly disposition: PreviewDisposition;
  /** Safe, content-free code explaining a non-ready disposition. */
  readonly reason?: string;
  /** Always explicit: this is context transfer into a NEW session, never resume. */
  readonly nativeResume: "unsupported";
  /** The verified new OMP identity — set ONLY for already-imported rows. */
  readonly ompIdentity?: string;
}

export interface ImportPreviewSummary {
  readonly contextTransferReady: number;
  readonly alreadyImported: number;
  readonly duplicate: number;
  readonly unsupported: number;
  readonly corrupt: number;
  readonly skipped: number;
}

export interface ImportPreview {
  /** Whether a real automated native import is reachable at all. */
  readonly automatedNativeImport: "supported" | "unsupported";
  /**
   * What is explicitly NOT carried or auto-activated by a context transfer.
   * Rendered as a visible banner so the user is never misled about rights.
   */
  readonly notCarried: readonly string[];
  readonly summary: ImportPreviewSummary;
  readonly rows: readonly ImportPreviewRow[];
  /** Structural guard: the preview can never claim a full restore. */
  readonly promisesFullRestore: false;
}

// Old capabilities that a transcript context transfer never revives on its own.
// A future import requires a fresh, explicit grant — never inheritance.
const NOT_CARRIED: readonly string[] = Object.freeze([
  "permissions",
  "full-auto-approvals",
  "mcp-servers",
  "extensions",
  "hooks",
  "provider-credentials",
  "oauth-tokens",
  "project-bindings",
]);

const DISPOSITION_BY_STATUS: Record<ImportPlanItem["status"], PreviewDisposition> = {
  ready: "context-transfer-ready",
  "already-imported": "already-imported",
  duplicate: "duplicate",
  unsupported: "unsupported",
  corrupt: "corrupt",
  skipped: "skipped",
};

/**
 * Build the read-only preview. Pure and side-effect free. When the pinned OMP
 * importer cannot perform an automated native import (the current, verified
 * state), even `ready` rows are presented as staged context-transfer candidates
 * — never as completed or "restorable" sessions.
 */
export function buildImportPreview(
  plan: ImportPlan,
  capability: OmpImportCapability = OMP_IMPORT_CAPABILITY,
): ImportPreview {
  const rows = plan.items.map((item) => toRow(item));
  const summary: ImportPreviewSummary = {
    contextTransferReady: count(rows, "context-transfer-ready"),
    alreadyImported: count(rows, "already-imported"),
    duplicate: count(rows, "duplicate"),
    unsupported: count(rows, "unsupported"),
    corrupt: count(rows, "corrupt"),
    skipped: count(rows, "skipped"),
  };
  return {
    automatedNativeImport: isAutomatedNativeImportSupported(capability) ? "supported" : "unsupported",
    notCarried: NOT_CARRIED,
    summary,
    rows,
    promisesFullRestore: false,
  };
}

function toRow(item: ImportPlanItem): ImportPreviewRow {
  const row = {
    client: item.client,
    relativePath: item.relativePath,
    disposition: DISPOSITION_BY_STATUS[item.status],
    nativeResume: "unsupported" as const,
    // Optional keys are added only when present — never as explicit undefined,
    // and never carrying anything beyond an identifier / safe code.
    ...(item.sessionId !== undefined ? { sessionId: item.sessionId } : {}),
    ...(item.reason !== undefined ? { reason: item.reason } : {}),
    ...(item.status === "already-imported" && item.ompSessionId !== undefined
      ? { ompIdentity: item.ompSessionId }
      : {}),
  };
  return row;
}

function count(rows: readonly ImportPreviewRow[], disposition: PreviewDisposition): number {
  return rows.filter((row) => row.disposition === disposition).length;
}
