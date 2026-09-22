import { z } from "zod";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { basename, dirname } from "node:path";
import { portalConnectionSchema, portalRecordSchema, type PortalConnection } from "../core/portals/portal-types.js";
import { providerProfileSchema, secretReferenceSchema } from "../core/providers/provider-profile.js";
import {
  inventoryMigrationSource, MigrationSafetyError, readVerifiedMigrationMetadata,
  replacePortalMetadataWithVerifiedBackup, verifyMigrationSource, writeExclusivePortalStage,
  type MigrationManifest, type MigrationManifestEntry, type MigrationSourcePolicy,
} from "./migration-manifest.js";

export interface PortalRecoveryInput {
  readonly source: MigrationSourcePolicy;
  readonly manifest: MigrationManifest;
  readonly activeRelativePath: string;
  readonly evidence: {
    readonly providerMetadataPath: string;
    readonly knownAdapterIds: readonly string[];
    /** Operator-attested reference-to-ciphertext mapping; never decrypt to discover it. */
    readonly secretFiles: readonly { readonly reference: string; readonly relativePath: string }[];
  };
  readonly recovery:
    | { readonly kind: "connections"; readonly connections: readonly unknown[] }
    | { readonly kind: "backup"; readonly relativePath: string };
}

export interface PortalRecoveryIssue {
  readonly code: string;
  readonly severity: "error" | "warning";
  readonly recordIndex?: number;
}

export interface PortalRecoveryReport {
  readonly status: "ready" | "blocked";
  readonly source: "connections" | "backup";
  readonly connectionCount: number;
  readonly issues: readonly PortalRecoveryIssue[];
  readonly requiresOperatorAcceptance: true;
  readonly activeReplaced: false;
  readonly refreshDisabled: true;
}

export interface StagedPortalRecovery {
  readonly report: PortalRecoveryReport;
  readonly stagedFile: MigrationManifestEntry;
}

export interface PortalRecoveryAcceptanceInput {
  readonly recovery: PortalRecoveryInput;
  readonly stagedPath: string;
  readonly stagedFile: MigrationManifestEntry;
  readonly backupDestination: string;
  readonly operatorAccepted: boolean;
}

export interface AcceptedPortalRecovery {
  readonly status: "accepted";
  readonly connectionCount: number;
  readonly activeReplaced: true;
  readonly requiresOperatorAcceptance: false;
  readonly refreshDisabled: true;
  readonly stagedFile: MigrationManifestEntry;
  readonly backupManifest: MigrationManifest;
  readonly activeFile: MigrationManifestEntry;
}

/** Read-only; ready means stageable, NOT accepted for active replacement. */
export async function dryRunPortalRecovery(input: PortalRecoveryInput): Promise<PortalRecoveryReport> {
  return (await prepareRecovery(input)).report;
}

/** Recompute the plan from evidence; a prior dry-run is not a reusable write authorization. */
export async function stagePortalRecovery(input: PortalRecoveryInput, destination: string): Promise<StagedPortalRecovery> {
  input = validateInput(input);
  const { report, connections } = await prepareRecovery(input);
  if (report.status !== "ready") throw new MigrationSafetyError("RECOVERY_BLOCKED");
  const document = {
    version: 2,
    records: connections.map((connection) => portalRecordSchema.parse({
      connection, revision: randomUUID(), failures: 0,
    })),
  };
  const stagedFile = await writeExclusivePortalStage(input.source, input.manifest, destination, document);
  return { report, stagedFile };
}

/** Explicit destructive boundary: revalidate intent/evidence, preserve bytes, then replace atomically. */
export async function acceptStagedPortalRecovery(
  input: PortalRecoveryAcceptanceInput,
): Promise<AcceptedPortalRecovery> {
  const acceptance = validateAcceptanceInput(input);
  if (acceptance.operatorAccepted !== true) throw new MigrationSafetyError("OPERATOR_ACCEPTANCE_REQUIRED");
  const recovery = validateInput(acceptance.recovery);
  const activeEvidence = recovery.manifest.files.find(
    (file) => file.relativePath === recovery.activeRelativePath && file.kind === "portal-metadata",
  );
  if (activeEvidence?.validation === "valid") throw new MigrationSafetyError("ACTIVE_NOT_CORRUPT");
  const { report, connections } = await prepareRecovery(recovery);
  if (report.status !== "ready") throw new MigrationSafetyError("RECOVERY_BLOCKED");

  const stagedSource: MigrationSourcePolicy = {
    root: dirname(acceptance.stagedPath),
    files: [{ relativePath: basename(acceptance.stagedPath), kind: "portal-metadata" }],
  };
  const stagedManifest = await inventoryMigrationSource(stagedSource);
  const stagedFile = stagedManifest.files[0]!;
  if (!sameManifestEntry(stagedFile, acceptance.stagedFile)) throw new MigrationSafetyError("STAGE_CHANGED");
  const stagedDocument = acceptedStageSchema.safeParse(
    await readVerifiedMigrationMetadata(stagedSource, stagedManifest, stagedFile.relativePath),
  );
  if (!stagedDocument.success || stagedDocument.data.records.length !== connections.length ||
      stagedDocument.data.records.some((record, index) =>
        record.failures !== 0 || record.latest !== undefined || record.lastWallet !== undefined ||
        record.nextRefreshAt !== undefined || !isDeepStrictEqual(record.connection, connections[index]))) {
    throw new MigrationSafetyError("STAGE_MISMATCH");
  }

  const replacement = await replacePortalMetadataWithVerifiedBackup(
    recovery.source,
    recovery.manifest,
    recovery.activeRelativePath,
    stagedDocument.data,
    acceptance.backupDestination,
  );
  return {
    status: "accepted",
    connectionCount: connections.length,
    activeReplaced: true,
    requiresOperatorAcceptance: false,
    refreshDisabled: true,
    stagedFile,
    ...replacement,
  };
}

const acceptedStageSchema = z.object({
  version: z.literal(2),
  records: z.array(portalRecordSchema).min(1).max(1_000),
}).strict().refine(
  ({ records }) => new Set(records.map((record) => record.connection.providerId)).size === records.length,
);

function sameManifestEntry(a: MigrationManifestEntry, b: MigrationManifestEntry): boolean {
  return a.relativePath === b.relativePath && a.byteLength === b.byteLength && a.sha256 === b.sha256 &&
    a.kind === b.kind && a.validation === b.validation;
}

// Defaults for adapter/auth would invent unknown durable connections.
const explicitConnectionSchema = portalConnectionSchema.extend({
  adapterId: portalConnectionSchema.shape.adapterId.removeDefault(),
  auth: portalConnectionSchema.shape.auth.removeDefault(),
});
const inputSchema = z.object({
  source: z.custom<MigrationSourcePolicy>(),
  manifest: z.custom<MigrationManifest>(),
  activeRelativePath: z.string(),
  evidence: z.object({
    providerMetadataPath: z.string(),
    knownAdapterIds: z.array(z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)).max(1_000),
    secretFiles: z.array(z.object({ reference: secretReferenceSchema, relativePath: z.string() }).strict())
      .max(100_000).refine((files) => new Set(files.map((file) => file.reference)).size === files.length),
  }).strict(),
  recovery: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("connections"), connections: z.array(z.unknown()).max(1_000) }).strict(),
    z.object({ kind: z.literal("backup"), relativePath: z.string() }).strict(),
  ]),
}).strict();

const manifestEntrySchema = z.object({
  relativePath: z.string(),
  byteLength: z.number().int().nonnegative().safe(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  kind: z.enum(["portal-metadata", "provider-metadata", "protected-secret", "session", "opaque"]),
  validation: z.enum(["nul-bytes", "not-inspected", "valid", "invalid-json", "invalid-schema", "too-large"]),
}).strict();

const acceptanceInputSchema = z.object({
  recovery: inputSchema,
  stagedPath: z.string(),
  stagedFile: manifestEntrySchema,
  backupDestination: z.string(),
  operatorAccepted: z.boolean(),
}).strict();

function validateInput(input: PortalRecoveryInput): PortalRecoveryInput {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new MigrationSafetyError("INVALID_RECOVERY_INPUT");
  try { return structuredClone(parsed.data); }
  catch { throw new MigrationSafetyError("INVALID_RECOVERY_INPUT"); }
}

function validateAcceptanceInput(input: PortalRecoveryAcceptanceInput): PortalRecoveryAcceptanceInput {
  const parsed = acceptanceInputSchema.safeParse(input);
  if (!parsed.success) throw new MigrationSafetyError("INVALID_RECOVERY_ACCEPTANCE");
  try { return structuredClone(parsed.data); }
  catch { throw new MigrationSafetyError("INVALID_RECOVERY_ACCEPTANCE"); }
}

async function prepareRecovery(input: PortalRecoveryInput): Promise<{
  report: PortalRecoveryReport; connections: PortalConnection[];
}> {
  // Capture caller-owned input before the first await so subsequent mutation cannot
  // substitute evidence or connection records mid-operation.
  input = validateInput(input);
  await verifyMigrationSource(input.source, input.manifest);
  const issues: PortalRecoveryIssue[] = [];
  const issue = (code: string, recordIndex?: number, severity: "error" | "warning" = "error") => {
    issues.push(recordIndex === undefined ? { code, severity } : { code, severity, recordIndex });
  };
  const active = input.manifest.files.find((file) => file.relativePath === input.activeRelativePath);
  if (active?.kind !== "portal-metadata") issue("MISSING_ACTIVE_EVIDENCE");
  const providerFile = input.manifest.files.find((file) => file.relativePath === input.evidence.providerMetadataPath);
  let providerIds = new Set<string>();
  if (providerFile?.kind !== "provider-metadata" || providerFile.validation !== "valid") {
    issue("INVALID_PROVIDER_EVIDENCE");
  } else {
    const providers = z.array(providerProfileSchema).parse(
      await readVerifiedMigrationMetadata(input.source, input.manifest, providerFile.relativePath),
    );
    providerIds = new Set(providers.map((provider) => provider.id));
  }
  let candidates: readonly unknown[] = [];
  if (input.recovery.kind === "connections") candidates = input.recovery.connections;
  else {
    const path = input.recovery.relativePath;
    const backup = input.manifest.files.find((file) => file.relativePath === path);
    if (path === input.activeRelativePath || backup?.kind !== "portal-metadata" || backup.validation !== "valid") {
      issue("INVALID_BACKUP");
    } else {
      // Read raw verified metadata so schema defaults cannot disguise absent
      // adapter/auth fields. Inventory already validated v1/v2 durable records.
      const stored = await readVerifiedMigrationMetadata(input.source, input.manifest, path) as {
        records: { connection: unknown }[];
      };
      candidates = stored.records.map((record) => record.connection);
    }
  }
  if (candidates.length === 0) issue("EMPTY_RECOVERY");
  const connections: PortalConnection[] = [];
  const seen = new Set<string>();
  for (const [index, candidate] of candidates.slice(0, 1_000).entries()) {
    const parsed = explicitConnectionSchema.safeParse(candidate);
    if (!parsed.success) { issue("INVALID_CONNECTION", index); continue; }
    const connection = parsed.data;
    if (seen.has(connection.providerId)) issue("DUPLICATE_PROVIDER", index);
    seen.add(connection.providerId);
    if (!providerIds.has(connection.providerId)) issue("UNKNOWN_PROVIDER", index);
    if (!input.evidence.knownAdapterIds.includes(connection.adapterId)) issue("UNKNOWN_ADAPTER", index);
    if (connection.auth.kind !== "none") {
      const reference = connection.auth.secretRef;
      const links = input.evidence.secretFiles.filter((file) => file.reference === reference);
      if (links.length === 0) issue("UNKNOWN_SECRET_REFERENCE", index);
      else {
        const secret = input.manifest.files.find((file) => file.relativePath === links[0]?.relativePath);
        if (links.length !== 1 || secret?.kind !== "protected-secret" || secret.byteLength === 0) {
          issue("MISSING_SECRET_EVIDENCE", index);
        }
      }
    }
    if (connection.userId === undefined) issue("UNKNOWN_USER_ID", index, "warning");
    connections.push({ ...connection, autoRefresh: false });
  }
  return {
    connections,
    report: {
      status: issues.some((item) => item.severity === "error") ? "blocked" : "ready",
      source: input.recovery.kind, connectionCount: connections.length, issues,
      requiresOperatorAcceptance: true, activeReplaced: false, refreshDisabled: true,
    },
  };
}
