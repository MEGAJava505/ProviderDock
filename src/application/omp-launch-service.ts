import type { ProviderDockApplication } from "./provider-dock-application.js";
import type { OmpPreflightResult, OmpRuntimeSelection } from "../clients/omp/omp-runtime.js";
import type { OmpProcessSupervisor } from "../clients/omp/omp-process-supervisor.js";
import type { OmpRunRecord } from "../clients/omp/omp-run-repository.js";
import {
  createOperationDiagnostic,
  sanitizeOperationDiagnostic,
  type OperationDiagnostic,
} from "../core/errors/operation-diagnostic.js";
import {
  evaluateOmpRouteDecisionForPilot,
  OmpRouteDecisionError,
  type OmpRouteDecisionSource,
} from "../migration/omp-route-decisions.js";
import { OmpProviderEvidenceError, type OmpProviderLocalSmokeEvidenceSource } from "../migration/omp-provider-evidence.js";
import type { ProviderHealthRepository } from "../core/health/provider-health-repository.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import { fingerprintOmpProviderProfile } from "../migration/omp-provider-mapping.js";

export interface OmpLaunchInput {
  readonly providerId: string;
  readonly modelId: string;
  readonly accountId: string;
  readonly projectDirectory: string;
  readonly permissionAcknowledgement?: "read-only-pilot-no-sandbox" | undefined;
}

export type OmpLaunchResult =
  | { readonly ok: true; readonly runId: string }
  | { readonly ok: false; readonly runId: string; readonly diagnostic: OperationDiagnostic };

interface OmpLaunchRuntime {
  preflight(selection: OmpRuntimeSelection): Promise<OmpPreflightResult>;
}

interface OmpLaunchSupervisor {
  start(selection: OmpRuntimeSelection): Promise<OmpLaunchResult>;
  listRuns(): Promise<readonly OmpRunRecord[]>;
  getRun(runId: string): Promise<OmpRunRecord | undefined>;
  cancel(runId: string): Promise<OmpRunRecord | undefined>;
  reconcileAfterRestart(): Promise<readonly OmpRunRecord[]>;
}

export interface OmpLaunchServiceOptions {
  readonly application: Pick<ProviderDockApplication, "listProviders">;
  readonly runtime: OmpLaunchRuntime;
  readonly supervisor: OmpLaunchSupervisor;
  readonly routeDecisions: OmpRouteDecisionSource;
  readonly evidence: OmpProviderLocalSmokeEvidenceSource;
  readonly healthRecords: Pick<ProviderHealthRepository, "get">;
  readonly credentialFingerprint: (profile: ProviderProfile) => Promise<string | undefined>;
  readonly artifact: {
    readonly sha256: string;
    readonly sourceCommit: string;
  };
}

function failure(code: string): { ok: false; diagnostic: OperationDiagnostic } {
  return { ok: false, diagnostic: createOperationDiagnostic({ code, stage: "validation" }) };
}

/** Public launch seam. `prepare()`, child environments, and raw RPC stay private. */
export class OmpLaunchService {
  readonly #application: OmpLaunchServiceOptions["application"];
  readonly #runtime: OmpLaunchRuntime;
  readonly #supervisor: OmpLaunchSupervisor;
  readonly #routeDecisions: OmpRouteDecisionSource;
  readonly #evidence: OmpProviderLocalSmokeEvidenceSource;
  readonly #healthRecords: OmpLaunchServiceOptions["healthRecords"];
  readonly #credentialFingerprint: OmpLaunchServiceOptions["credentialFingerprint"];
  readonly #artifact: OmpLaunchServiceOptions["artifact"];

  constructor(options: OmpLaunchServiceOptions) {
    this.#application = options.application;
    this.#runtime = options.runtime;
    this.#supervisor = options.supervisor;
    this.#routeDecisions = options.routeDecisions;
    this.#evidence = options.evidence;
    this.#healthRecords = options.healthRecords;
    this.#credentialFingerprint = options.credentialFingerprint;
    this.#artifact = { ...options.artifact };
  }

  async preflight(input: OmpLaunchInput): Promise<OmpPreflightResult> {
    const selection = await this.selection(input);
    if (!("route" in selection)) return selection;
    return this.#runtime.preflight(selection);
  }

  async launch(input: OmpLaunchInput): Promise<OmpLaunchResult> {
    const preflight = await this.preflight(input);
    if (!preflight.ok) {
      return { ok: false, runId: "00000000-0000-4000-8000-000000000000", diagnostic: preflight.diagnostic };
    }
    const selection = await this.selection(input);
    if (!("route" in selection)) {
      return { ok: false, runId: "00000000-0000-4000-8000-000000000000", diagnostic: selection.diagnostic };
    }
    const result = await this.#supervisor.start(selection);
    return result.ok ? result : {
      ok: false,
      runId: result.runId,
      diagnostic: sanitizeOperationDiagnostic(result.diagnostic),
    };
  }

  listRuns(): Promise<readonly OmpRunRecord[]> { return this.#supervisor.listRuns(); }
  getRun(runId: string): Promise<OmpRunRecord | undefined> { return this.#supervisor.getRun(runId); }
  cancel(runId: string): Promise<OmpRunRecord | undefined> { return this.#supervisor.cancel(runId); }
  reconcileAfterRestart(): Promise<readonly OmpRunRecord[]> {
    return this.#supervisor.reconcileAfterRestart();
  }

  async selection(input: OmpLaunchInput): Promise<
    OmpRuntimeSelection | { ok: false; diagnostic: OperationDiagnostic }
  > {
    if (input.permissionAcknowledgement !== "read-only-pilot-no-sandbox") {
      return failure("OMP_PERMISSION_CONFIRMATION_REQUIRED");
    }
    for (const key of ["providerId", "modelId", "accountId", "projectDirectory"] as const) {
      if (typeof input[key] !== "string" || input[key].trim().length === 0) return failure("OMP_CONFIG_INVALID");
    }
    const profile = (await this.#application.listProviders()).find((item) => item.id === input.providerId);
    if (profile === undefined || !profile.enabled) return failure("OMP_CONFIG_INVALID");
    let candidate;
    try {
      candidate = await this.#routeDecisions.get(
        input.providerId,
        input.accountId,
        input.modelId,
      );
    } catch (error) {
      return failure(error instanceof OmpRouteDecisionError &&
        error.code === "LEGACY_OMP_ROUTE_DECISIONS"
        ? "OMP_MIGRATION_EVIDENCE_V2_REQUIRED" : "OMP_ROUTE_NOT_ACCEPTED");
    }
    if (candidate === undefined) return failure("OMP_ROUTE_NOT_ACCEPTED");
    let evidence;
    try {
      evidence = await this.#evidence.get();
    } catch (error) {
      return failure(error instanceof OmpProviderEvidenceError &&
        error.code === "LEGACY_LOCAL_SMOKE_EVIDENCE"
        ? "OMP_MIGRATION_EVIDENCE_V2_REQUIRED" : "OMP_ROUTE_NOT_ACCEPTED");
    }
    const doctorSnapshot = (await this.#healthRecords.get(input.providerId)
      .catch(() => undefined))?.diagnostics.find((snapshot) => snapshot.modelId === input.modelId);
    const currentCredentialFingerprint = await this.#credentialFingerprint(profile).catch(() => undefined);
    const evaluated = evaluateOmpRouteDecisionForPilot({
      profile,
      decision: candidate,
      evidence,
      doctorSnapshot,
      currentCredentialFingerprint,
      selection: {
        providerId: input.providerId,
        accountId: input.accountId,
        modelId: input.modelId,
      },
      artifact: this.#artifact,
    });
    if (!evaluated.accepted) return failure("OMP_ROUTE_NOT_ACCEPTED");
    return {
      route: evaluated.route,
      protocolMappings: evaluated.protocolMappings,
      projectDirectory: input.projectDirectory,
      mode: "tui",
      permissionAcknowledgement: input.permissionAcknowledgement,
      expectedCredentialFingerprint: currentCredentialFingerprint,
      expectedProfileSha256: fingerprintOmpProviderProfile(profile),
    };
  }
}
