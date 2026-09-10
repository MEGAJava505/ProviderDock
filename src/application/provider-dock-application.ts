import { assertModelEnabled } from "../core/providers/model-access.js";
import { automaticClient } from "../core/providers/automatic-client.js";
import { portalConnectionSchema, PortalConfigurationError } from "../core/portals/portal-types.js";
import type { ProviderPortalService } from "../core/portals/provider-portal-service.js";
import { resolve } from "node:path";
import type { ProviderProbeResult, ProviderProbeService } from "../core/health/provider-probe-service.js";
import {
  ProviderProbePolicy,
  type ProviderProbePolicyDecision,
} from "../core/health/provider-probe-policy.js";
import {
  MemoryProviderHealthRepository,
  type ProviderHealthRecord,
  type ProviderHealthRepository,
} from "../core/health/provider-health-repository.js";
import {
  orderedLogicalRoutes,
  parseLogicalModelGroup,
  type LogicalModelGroup,
} from "../core/fallback/logical-model.js";
import type { FallbackNotification } from "../core/fallback/fallback-session-router.js";
import {
  MemoryLogicalModelRepository,
  type LogicalModelRepository,
} from "../core/fallback/logical-model-repository.js";
import type { ProviderProfile } from "../core/providers/provider-profile.js";
import { parseProviderProfile } from "../core/providers/provider-profile.js";
import type { ProviderProfileRepository } from "../core/providers/provider-profile-repository.js";
import type { ProviderAdapterRegistry } from "../core/providers/provider-adapter-registry.js";
import type { SecretVault } from "../core/security/secret-store.js";
import { secretReferenceSchema } from "../core/providers/provider-profile.js";
import {
  parsePromptProfile,
  type PromptProfile,
} from "../core/profiles/prompt-profile.js";
import {
  MemoryPromptProfileRepository,
  type PromptProfileRepository,
} from "../core/profiles/prompt-profile-repository.js";
import type { ProjectProfile } from "../core/profiles/project-profile.js";
import { projectDirectoryKey } from "../core/profiles/project-profile.js";
import {
  MemoryProjectProfileRepository,
  type ProjectProfileRepository,
} from "../core/profiles/project-profile-repository.js";
import {
  createProfileBundle,
  parseProfileBundle,
  type ProfileBundle,
} from "../core/profiles/profile-bundle.js";
import type {
  CodexLauncher,
  CodexProcessExit,
  LaunchCodexInput,
} from "../clients/codex/codex-launcher.js";
import { CodexRuntimeConfigurationError } from "../clients/codex/codex-runtime-config.js";
import type { CodexRecoveryOutcome } from "../clients/codex/codex-runtime-session.js";
import {
  ClaudeRuntimeConfigurationError,
  type ClaudeLauncher,
  type ClaudeProcessExit,
  type LaunchClaudeInput,
} from "../clients/claude/claude-launcher.js";
import type {
  DoctorReport,
  ProviderDoctor,
  RunDoctorOptions,
} from "../diagnostics/provider-doctor.js";
import { doctorReportToCapabilitySnapshot } from "../diagnostics/doctor-capability-snapshot.js";
import type { ClientCompatibilityStatus } from "../core/providers/model-catalog.js";
import {
  MemoryUsageRepository,
  type UsageFilter,
  type UsageRepository,
  type UsageSummaryRow,
} from "../core/usage/usage-repository.js";
import type { UsageTelemetryEvent } from "../core/usage/usage-event.js";
import type {
  LoadedProviderPlugin,
  ProviderPluginDescriptor,
} from "../core/plugins/provider-plugin-sdk.js";

export class ProviderNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`Provider '${providerId}' is not configured.`);
    this.name = "ProviderNotFoundError";
  }
}

export class SecretVaultUnavailableError extends Error {
  constructor() {
    super("A writable OS secret vault is not available on this platform.");
    this.name = "SecretVaultUnavailableError";
  }
}

export class LogicalModelNotFoundError extends Error {
  constructor(readonly logicalModelId: string) {
    super(`Logical model '${logicalModelId}' is not configured.`);
    this.name = "LogicalModelNotFoundError";
  }
}

export class ProviderInUseByLogicalModelError extends Error {
  constructor(
    readonly providerId: string,
    readonly logicalModelIds: readonly string[],
  ) {
    super(
      `Provider '${providerId}' is used by logical model${
        logicalModelIds.length === 1 ? "" : "s"
      } ${logicalModelIds.map((id) => `'${id}'`).join(", ")}. Remove those routes first.`,
    );
    this.name = "ProviderInUseByLogicalModelError";
  }
}

export class PromptProfileNotFoundError extends Error {
  constructor(readonly promptProfileId: string) {
    super(`Prompt profile '${promptProfileId}' is not configured.`);
    this.name = "PromptProfileNotFoundError";
  }
}

export class ProviderInUseByPromptProfileError extends Error {
  constructor(
    readonly providerId: string,
    readonly promptProfileIds: readonly string[],
  ) {
    super(
      `Provider '${providerId}' is preferred by prompt profile${
        promptProfileIds.length === 1 ? "" : "s"
      } ${promptProfileIds.map((id) => `'${id}'`).join(", ")}. Update those profiles first.`,
    );
    this.name = "ProviderInUseByPromptProfileError";
  }
}

export class LogicalModelInUseByPromptProfileError extends Error {
  constructor(
    readonly logicalModelId: string,
    readonly promptProfileIds: readonly string[],
  ) {
    super(
      `Logical model '${logicalModelId}' is preferred by prompt profile${
        promptProfileIds.length === 1 ? "" : "s"
      } ${promptProfileIds.map((id) => `'${id}'`).join(", ")}. Update those profiles first.`,
    );
    this.name = "LogicalModelInUseByPromptProfileError";
  }
}

export class PromptProfileLaunchConfigurationError extends Error {
  constructor(readonly promptProfileId: string, message: string) {
    super(`Prompt profile '${promptProfileId}' cannot launch: ${message}`);
    this.name = "PromptProfileLaunchConfigurationError";
  }
}

export class ProjectProfileNotFoundError extends Error {
  constructor(readonly projectDirectory: string) {
    super(`Project profile for '${projectDirectory}' is not configured.`);
    this.name = "ProjectProfileNotFoundError";
  }
}

export class PromptProfileInUseByProjectProfileError extends Error {
  constructor(
    readonly promptProfileId: string,
    readonly projectDirectories: readonly string[],
  ) {
    super(
      `Prompt profile '${promptProfileId}' is assigned to project${
        projectDirectories.length === 1 ? "" : "s"
      } ${projectDirectories.map((directory) => `'${directory}'`).join(", ")}. Update those project profiles first.`,
    );
    this.name = "PromptProfileInUseByProjectProfileError";
  }
}

export class AutomaticClientResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AutomaticClientResolutionError";
  }
}

export class ProviderHealthNotFoundError extends Error {
  constructor(readonly providerId: string) {
    super(`No persisted health snapshot exists for provider '${providerId}'.`);
    this.name = "ProviderHealthNotFoundError";
  }
}

export class ProfileBundleConflictError extends Error {
  constructor(readonly conflicts: readonly string[]) {
    super(
      `Profile bundle conflicts with existing configuration: ${conflicts.join(", ")}. Re-run with overwrite enabled to replace those entries.`,
    );
    this.name = "ProfileBundleConflictError";
  }
}

export class ProfileBundleValidationError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`Profile bundle has invalid references: ${problems.join("; ")}`);
    this.name = "ProfileBundleValidationError";
  }
}

export class ProfileBundleImportError extends Error {
  constructor(
    message: string,
    options: { readonly cause?: unknown } = {},
  ) {
    super(message, options);
    this.name = "ProfileBundleImportError";
  }
}

export type ResolvedLaunchClient = "codex" | "claude-code";

export interface AutomaticLaunchOptions {
  readonly projectDirectory: string;
  readonly executable?: string;
  readonly parentEnvironment?: NodeJS.ProcessEnv;
  readonly onFallback?: (notification: FallbackNotification) => void;
  readonly onStarted?: (client: ResolvedLaunchClient) => void;
}

export interface AutomaticLaunchResult {
  readonly client: ResolvedLaunchClient;
  readonly exit: CodexProcessExit | ClaudeProcessExit;
}

export interface ImportProfileBundleOptions {
  readonly overwrite?: boolean;
}

export interface ProfileBundleImportCounts {
  readonly created: number;
  readonly updated: number;
}

export interface ProfileBundleImportResult {
  readonly providers: ProfileBundleImportCounts;
  readonly logicalModels: ProfileBundleImportCounts;
  readonly promptProfiles: ProfileBundleImportCounts;
  readonly projectProfiles: ProfileBundleImportCounts;
}

export interface DueProviderProbeResult {
  readonly providerId: string;
  readonly decision: ProviderProbePolicyDecision;
  readonly result?: ProviderProbeResult;
}

export class ProviderDockApplication {
  constructor(
    private readonly profiles: ProviderProfileRepository,
    private readonly probes: ProviderProbeService,
    private readonly secretVault?: SecretVault,
    private readonly codexLauncher?: CodexLauncher,
    private readonly adapters?: ProviderAdapterRegistry,
    private readonly doctor?: ProviderDoctor,
    private readonly claudeLauncher?: ClaudeLauncher,
    private readonly logicalModels: LogicalModelRepository =
      new MemoryLogicalModelRepository(),
    private readonly promptProfiles: PromptProfileRepository =
      new MemoryPromptProfileRepository(),
    private readonly projectProfiles: ProjectProfileRepository =
      new MemoryProjectProfileRepository(),
    private readonly healthRecords: ProviderHealthRepository =
      new MemoryProviderHealthRepository(),
    private readonly usageRecords: UsageRepository =
      new MemoryUsageRepository(),
    private readonly providerPlugins: readonly LoadedProviderPlugin[] = [],
    private readonly probePolicy: ProviderProbePolicy =
      new ProviderProbePolicy(),
    private readonly portals?: ProviderPortalService,
  ) {}

  listProviderPlugins(): readonly ProviderPluginDescriptor[] {
    return this.providerPlugins.map((plugin) => ({
      id: plugin.manifest.id,
      name: plugin.manifest.name,
      version: plugin.manifest.version,
      description: plugin.manifest.description,
      modulePath: plugin.modulePath,
      adapterIds: [...plugin.manifest.adapterIds],
    }));
  }

  async listProviders(): Promise<readonly ProviderProfile[]> {
    return (await this.profiles.list()).map((profile) => this.prepareProfile(profile));
  }

  async getProvider(id: string): Promise<ProviderProfile> {
    const profile = await this.profiles.get(id);
    if (!profile) throw new ProviderNotFoundError(id);
    return this.prepareProfile(profile);
  }

  async setProvider(input: unknown): Promise<ProviderProfile> {
    return this.profiles.upsert(this.prepareProfile(parseProviderProfile(input)));
  }

  private modelControlQueue: Promise<unknown> = Promise.resolve();

  async setProviderModelEnabled(providerId: string, modelId: string, enabled: boolean): Promise<ProviderProfile> {
    const operation = this.modelControlQueue.then(async () => {
      const profile = await this.getProvider(providerId);
      const disabled = new Set(profile.disabledModelIds);
      if (enabled) disabled.delete(modelId); else disabled.add(modelId);
      return this.setProvider({ ...profile, disabledModelIds: [...disabled] });
    });
    this.modelControlQueue = operation.catch(() => undefined);
    return operation;
  }

  async listProviderPortals() { return this.portals?.list() ?? []; }
  listPortalAdapters() { return this.portals?.listAdapters() ?? []; }
  async setProviderPortal(input: unknown) {
    const connection = portalConnectionSchema.parse(input);
    await this.getProvider(connection.providerId);
    if (!this.portals) throw new PortalConfigurationError("Account connections are unavailable in this runtime.");
    return this.portals.configure(connection);
  }
  async refreshProviderPortal(providerId: string) {
    await this.getProvider(providerId);
    if (!this.portals) throw new PortalConfigurationError("Account connections are unavailable in this runtime.");
    return this.portals.refresh(providerId);
  }
  async removeProviderPortal(providerId: string) {
    await this.getProvider(providerId);
    await this.portals?.disconnect(providerId);
  }
  async refreshDueProviderPortals() {
    const enabledIds = (await this.listProviders()).filter((profile) => profile.enabled).map((profile) => profile.id);
    await this.portals?.refreshDue(enabledIds);
  }

  async removeProvider(id: string): Promise<void> {
    const storedProfile = await this.profiles.get(id);
    if (storedProfile === undefined) throw new ProviderNotFoundError(id);
    const references = (await this.logicalModels.list())
      .filter((logicalModel) =>
        logicalModel.routes.some((route) => route.providerId === id),
      )
      .map((logicalModel) => logicalModel.id);
    if (references.length > 0) {
      throw new ProviderInUseByLogicalModelError(id, references);
    }
    const promptReferences = (await this.promptProfiles.list())
      .filter((profile) => profile.preferredProviderId === id)
      .map((profile) => profile.id);
    if (promptReferences.length > 0) {
      throw new ProviderInUseByPromptProfileError(id, promptReferences);
    }
    if (!(await this.profiles.delete(id))) throw new ProviderNotFoundError(id);
    try {
      await this.healthRecords.delete(id);
      await this.portals?.disconnect(id);
    } catch (error) {
      await this.profiles.upsert(storedProfile).catch(() => undefined);
      throw error;
    }
  }

  async listLogicalModels(): Promise<readonly LogicalModelGroup[]> {
    return this.logicalModels.list();
  }

  async getLogicalModel(id: string): Promise<LogicalModelGroup> {
    const logicalModel = await this.logicalModels.get(id);
    if (!logicalModel) throw new LogicalModelNotFoundError(id);
    return logicalModel;
  }

  async setLogicalModel(input: unknown): Promise<LogicalModelGroup> {
    const logicalModel = parseLogicalModelGroup(input);
    const providerIds = [...new Set(logicalModel.routes.map((route) => route.providerId))];
    await Promise.all(
      providerIds.map(async (providerId) => {
        if (!(await this.profiles.get(providerId))) throw new ProviderNotFoundError(providerId);
      }),
    );
    return this.logicalModels.upsert(logicalModel);
  }

  async removeLogicalModel(id: string): Promise<void> {
    const promptReferences = (await this.promptProfiles.list())
      .filter((profile) => profile.preferredLogicalModelId === id)
      .map((profile) => profile.id);
    if (promptReferences.length > 0) {
      throw new LogicalModelInUseByPromptProfileError(id, promptReferences);
    }
    if (!(await this.logicalModels.delete(id))) throw new LogicalModelNotFoundError(id);
  }

  listPromptProfiles(): Promise<readonly PromptProfile[]> {
    return this.promptProfiles.list();
  }

  async getPromptProfile(id: string): Promise<PromptProfile> {
    const profile = await this.promptProfiles.get(id);
    if (!profile) throw new PromptProfileNotFoundError(id);
    return profile;
  }

  async setPromptProfile(input: unknown): Promise<PromptProfile> {
    const profile = parsePromptProfile(input);
    if (profile.preferredProviderId !== undefined) {
      await this.getProvider(profile.preferredProviderId);
    }
    if (profile.preferredLogicalModelId !== undefined) {
      await this.getLogicalModel(profile.preferredLogicalModelId);
    }
    return this.promptProfiles.upsert(profile);
  }

  async removePromptProfile(id: string): Promise<void> {
    const projectReferences = (await this.projectProfiles.list())
      .filter((profile) => profile.promptProfileId === id)
      .map((profile) => profile.projectDirectory);
    if (projectReferences.length > 0) {
      throw new PromptProfileInUseByProjectProfileError(id, projectReferences);
    }
    if (!(await this.promptProfiles.delete(id))) {
      throw new PromptProfileNotFoundError(id);
    }
  }

  listProjectProfiles(): Promise<readonly ProjectProfile[]> {
    return this.projectProfiles.list();
  }

  async getProjectProfile(projectDirectory: string): Promise<ProjectProfile> {
    const normalized = resolve(projectDirectory);
    const profile = await this.projectProfiles.get(normalized);
    if (!profile) throw new ProjectProfileNotFoundError(normalized);
    return profile;
  }

  async setProjectProfile(input: {
    readonly projectDirectory: string;
    readonly promptProfileId: string;
  }): Promise<ProjectProfile> {
    const projectDirectory = resolve(input.projectDirectory);
    await this.getPromptProfile(input.promptProfileId);
    return this.projectProfiles.upsert({
      projectDirectory,
      promptProfileId: input.promptProfileId,
    });
  }

  async removeProjectProfile(projectDirectory: string): Promise<void> {
    const normalized = resolve(projectDirectory);
    if (!(await this.projectProfiles.delete(normalized))) {
      throw new ProjectProfileNotFoundError(normalized);
    }
  }

  async exportProfileBundle(now: Date = new Date()): Promise<ProfileBundle> {
    const [providers, logicalModels, promptProfiles, projectProfiles] =
      await Promise.all([
        this.profiles.list(),
        this.logicalModels.list(),
        this.promptProfiles.list(),
        this.projectProfiles.list(),
      ]);
    return createProfileBundle(
      { providers, logicalModels, promptProfiles, projectProfiles },
      now,
    );
  }

  async importProfileBundle(
    input: unknown,
    options: ImportProfileBundleOptions = {},
  ): Promise<ProfileBundleImportResult> {
    const bundle = parseProfileBundle(input);
    const [providers, logicalModels, promptProfiles, projectProfiles] =
      await Promise.all([
        this.profiles.list(),
        this.logicalModels.list(),
        this.promptProfiles.list(),
        this.projectProfiles.list(),
      ]);
    const existingProviders = new Map(
      providers.map((profile) => [profile.id, profile] as const),
    );
    const existingLogicalModels = new Map(
      logicalModels.map((model) => [model.id, model] as const),
    );
    const existingPromptProfiles = new Map(
      promptProfiles.map((profile) => [profile.id, profile] as const),
    );
    const existingProjectProfiles = new Map(
      projectProfiles.map(
        (profile) => [projectDirectoryKey(profile.projectDirectory), profile] as const,
      ),
    );

    if (!options.overwrite) {
      const conflicts = [
        ...bundle.providers
          .filter((profile) => existingProviders.has(profile.id))
          .map((profile) => `provider:${profile.id}`),
        ...bundle.logicalModels
          .filter((model) => existingLogicalModels.has(model.id))
          .map((model) => `logical-model:${model.id}`),
        ...bundle.promptProfiles
          .filter((profile) => existingPromptProfiles.has(profile.id))
          .map((profile) => `prompt-profile:${profile.id}`),
        ...bundle.projectProfiles
          .filter((profile) =>
            existingProjectProfiles.has(
              projectDirectoryKey(profile.projectDirectory),
            ),
          )
          .map((profile) => `project:${profile.projectDirectory}`),
      ];
      if (conflicts.length > 0) throw new ProfileBundleConflictError(conflicts);
    }

    this.validateProfileBundleReferences(bundle, {
      providerIds: new Set([
        ...existingProviders.keys(),
        ...bundle.providers.map((profile) => profile.id),
      ]),
      logicalModelIds: new Set([
        ...existingLogicalModels.keys(),
        ...bundle.logicalModels.map((model) => model.id),
      ]),
      promptProfileIds: new Set([
        ...existingPromptProfiles.keys(),
        ...bundle.promptProfiles.map((profile) => profile.id),
      ]),
    });

    const rollback: Array<() => Promise<void>> = [];
    try {
      for (const profile of bundle.providers) {
        const previous = existingProviders.get(profile.id);
        await this.profiles.upsert(profile);
        rollback.push(async () => {
          if (previous === undefined) await this.profiles.delete(profile.id);
          else await this.profiles.upsert(previous);
        });
      }
      for (const model of bundle.logicalModels) {
        const previous = existingLogicalModels.get(model.id);
        await this.logicalModels.upsert(model);
        rollback.push(async () => {
          if (previous === undefined) await this.logicalModels.delete(model.id);
          else await this.logicalModels.upsert(previous);
        });
      }
      for (const profile of bundle.promptProfiles) {
        const previous = existingPromptProfiles.get(profile.id);
        await this.promptProfiles.upsert(profile);
        rollback.push(async () => {
          if (previous === undefined) await this.promptProfiles.delete(profile.id);
          else await this.promptProfiles.upsert(previous);
        });
      }
      for (const profile of bundle.projectProfiles) {
        const key = projectDirectoryKey(profile.projectDirectory);
        const previous = existingProjectProfiles.get(key);
        await this.projectProfiles.upsert(profile);
        rollback.push(async () => {
          if (previous === undefined) {
            await this.projectProfiles.delete(profile.projectDirectory);
          } else {
            await this.projectProfiles.upsert(previous);
          }
        });
      }
    } catch (error) {
      const rollbackFailures: unknown[] = [];
      for (const restore of rollback.reverse()) {
        await restore().catch((rollbackError) => {
          rollbackFailures.push(rollbackError);
        });
      }
      throw new ProfileBundleImportError(
        rollbackFailures.length === 0
          ? "Profile bundle import failed; all completed changes were rolled back."
          : `Profile bundle import failed and ${rollbackFailures.length} rollback operation(s) also failed.`,
        { cause: error },
      );
    }

    return {
      providers: importCounts(bundle.providers, existingProviders),
      logicalModels: importCounts(bundle.logicalModels, existingLogicalModels),
      promptProfiles: importCounts(bundle.promptProfiles, existingPromptProfiles),
      projectProfiles: {
        created: bundle.projectProfiles.filter(
          (profile) =>
            !existingProjectProfiles.has(
              projectDirectoryKey(profile.projectDirectory),
            ),
        ).length,
        updated: bundle.projectProfiles.filter((profile) =>
          existingProjectProfiles.has(
            projectDirectoryKey(profile.projectDirectory),
          ),
        ).length,
      },
    };
  }

  async probeProvider(id: string): Promise<ProviderProbeResult> {
    const result = await this.probes.probe(await this.getProvider(id));
    await this.healthRecords.record(result);
    return result;
  }

  async probeDueProviders(
    now: Date = new Date(),
  ): Promise<readonly DueProviderProbeResult[]> {
    const outcomes: DueProviderProbeResult[] = [];
    for (const profile of await this.listProviders()) {
      const decision = this.probePolicy.decide(
        profile,
        await this.healthRecords.get(profile.id),
        now,
      );
      if (decision.action === "skip") {
        outcomes.push({ providerId: profile.id, decision });
        continue;
      }
      const result = await this.probes.probe(profile);
      await this.healthRecords.record(result);
      outcomes.push({ providerId: profile.id, decision, result });
    }
    return outcomes;
  }

  listProviderHealth(): Promise<readonly ProviderHealthRecord[]> {
    return this.healthRecords.list();
  }

  async getProviderHealth(id: string): Promise<ProviderHealthRecord> {
    const record = await this.healthRecords.get(id);
    if (!record) throw new ProviderHealthNotFoundError(id);
    return record;
  }

  listUsage(
    filter: UsageFilter = {},
  ): Promise<readonly UsageTelemetryEvent[]> {
    return this.usageRecords.list(filter);
  }

  summarizeUsage(
    filter: UsageFilter = {},
  ): Promise<readonly UsageSummaryRow[]> {
    return this.usageRecords.summarize(filter);
  }

  async diagnoseProvider(id: string, options: RunDoctorOptions = {}): Promise<DoctorReport> {
    if (!this.doctor) throw new Error("The provider doctor is not configured.");
    const report = await this.doctor.run(await this.getProvider(id), options);
    const snapshot = doctorReportToCapabilitySnapshot(report);
    if (snapshot !== undefined) {
      await this.healthRecords.recordDiagnostics(snapshot);
    }
    return report;
  }

  async setSecret(reference: string, value: string): Promise<void> {
    await this.requireSecretVault().set(secretReferenceSchema.parse(reference), value);
    await this.portals?.invalidateSecret(reference);
  }

  listSecretReferences(): Promise<readonly string[]> {
    return this.requireSecretVault().listReferences();
  }

  async removeSecret(reference: string): Promise<boolean> {
    const removed = await this.requireSecretVault().delete(secretReferenceSchema.parse(reference));
    await this.portals?.invalidateSecret(reference);
    return removed;
  }

  async launchCodex(
    input: Omit<LaunchCodexInput, "profile"> & { readonly providerId: string },
  ): Promise<CodexProcessExit> {
    const { providerId, ...launchInput } = input;
    assertModelEnabled(await this.getProvider(providerId), input.modelId);
    return this.requireCodexLauncher().launch({
      ...launchInput,
      profile: await this.getProvider(providerId),
    });
  }

  async launchCodexLogicalModel(
    input: Omit<
      LaunchCodexInput,
      "profile" | "modelId" | "fallback"
    > & { readonly logicalModelId: string },
  ): Promise<CodexProcessExit> {
    const { logicalModelId, ...launchInput } = input;
    const configured = await this.getLogicalModel(logicalModelId);
    const resolved = await Promise.all(
      orderedLogicalRoutes(configured).map(async (route) => ({
        route,
        profile: await this.getProvider(route.providerId),
      })),
    );
    const active = resolved.filter(({ profile, route }) => profile.enabled && !profile.disabledModelIds.includes(route.modelId));
    if (active.length === 0) {
      throw new CodexRuntimeConfigurationError(
        `Logical model '${logicalModelId}' has no enabled provider routes.`,
      );
    }

    const logicalModel = parseLogicalModelGroup({
      id: configured.id,
      routes: active.map(({ route }) => route),
    });
    const profiles = [
      ...new Map(active.map(({ profile }) => [profile.id, profile] as const)).values(),
    ];
    const primary = active[0];
    if (primary === undefined) {
      throw new CodexRuntimeConfigurationError(
        `Logical model '${logicalModelId}' has no primary provider route.`,
      );
    }
    return this.requireCodexLauncher().launch({
      ...launchInput,
      profile: primary.profile,
      modelId: logicalModel.id,
      fallback: { logicalModel, profiles },
    });
  }

  async launchCodexPromptProfile(
    input: Omit<
      LaunchCodexInput,
      | "profile"
      | "modelId"
      | "fallback"
      | "sessionInstructions"
      | "defaultReasoningLevel"
      | "forceManagedBridge"
      | "additionalArgs"
      | "route"
    > & {
      readonly promptProfileId: string;
      readonly additionalArgs?: readonly string[];
    },
  ): Promise<CodexProcessExit> {
    const { promptProfileId, additionalArgs, ...launchInput } = input;
    const promptProfile = await this.getPromptProfile(promptProfileId);
    const profileArgs = [
      ...promptProfile.clientFlags.codex,
      ...(additionalArgs ?? []),
    ];
    const shared = {
      ...launchInput,
      sessionInstructions: promptProfile.instructions,
      ...(promptProfile.reasoningLevel === undefined
        ? {}
        : { defaultReasoningLevel: promptProfile.reasoningLevel }),
      ...(profileArgs.length === 0 ? {} : { additionalArgs: profileArgs }),
    };

    if (promptProfile.fallbackPolicy === "logical-model") {
      const logicalModelId = promptProfile.preferredLogicalModelId;
      if (logicalModelId === undefined) {
        throw new PromptProfileLaunchConfigurationError(
          promptProfile.id,
          "logical-model fallback requires a preferred logical model.",
        );
      }
      return this.launchCodexLogicalModel({
        ...shared,
        logicalModelId,
        route: { kind: "auto" },
      });
    }

    if (
      promptProfile.preferredProviderId === undefined ||
      promptProfile.preferredModelId === undefined
    ) {
      throw new PromptProfileLaunchConfigurationError(
        promptProfile.id,
        "disabled fallback requires both a preferred provider and preferred model.",
      );
    }
    return this.launchCodex({
      ...shared,
      providerId: promptProfile.preferredProviderId,
      modelId: promptProfile.preferredModelId,
      route: { kind: "auto" },
      forceManagedBridge: true,
    });
  }

  async launchCodexProjectProfile(
    input: Omit<
      Parameters<ProviderDockApplication["launchCodexPromptProfile"]>[0],
      "promptProfileId"
    >,
  ): Promise<CodexProcessExit> {
    const projectProfile = await this.getProjectProfile(input.projectDirectory);
    return this.launchCodexPromptProfile({
      ...input,
      promptProfileId: projectProfile.promptProfileId,
    });
  }

  recoverCodexSessions(): Promise<readonly CodexRecoveryOutcome[]> {
    return this.requireCodexLauncher().recover();
  }

  async launchClaude(
    input: Omit<LaunchClaudeInput, "profile"> & { readonly providerId: string },
  ): Promise<ClaudeProcessExit> {
    const { providerId, ...launchInput } = input;
    assertModelEnabled(await this.getProvider(providerId), input.modelId);
    return this.requireClaudeLauncher().launch({
      ...launchInput,
      profile: await this.getProvider(providerId),
    });
  }

  async launchClaudeLogicalModel(
    input: Omit<
      LaunchClaudeInput,
      "profile" | "modelId" | "fallback"
    > & { readonly logicalModelId: string },
  ): Promise<ClaudeProcessExit> {
    const { logicalModelId, ...launchInput } = input;
    const configured = await this.getLogicalModel(logicalModelId);
    const resolved = await Promise.all(
      orderedLogicalRoutes(configured).map(async (route) => ({
        route,
        profile: await this.getProvider(route.providerId),
      })),
    );
    const active = resolved.filter(({ profile, route }) => profile.enabled && !profile.disabledModelIds.includes(route.modelId));
    if (active.length === 0) {
      throw new ClaudeRuntimeConfigurationError(
        `Logical model '${logicalModelId}' has no enabled provider routes.`,
      );
    }

    const logicalModel = parseLogicalModelGroup({
      id: configured.id,
      routes: active.map(({ route }) => route),
    });
    const profiles = [
      ...new Map(active.map(({ profile }) => [profile.id, profile] as const)).values(),
    ];
    const primary = active[0];
    if (primary === undefined) {
      throw new ClaudeRuntimeConfigurationError(
        `Logical model '${logicalModelId}' has no primary provider route.`,
      );
    }
    return this.requireClaudeLauncher().launch({
      ...launchInput,
      profile: primary.profile,
      modelId: logicalModel.id,
      fallback: { logicalModel, profiles },
    });
  }

  async launchClaudePromptProfile(
    input: Omit<
      LaunchClaudeInput,
      | "profile"
      | "modelId"
      | "fallback"
      | "sessionInstructions"
      | "additionalArgs"
    > & {
      readonly promptProfileId: string;
      readonly additionalArgs?: readonly string[];
    },
  ): Promise<ClaudeProcessExit> {
    const { promptProfileId, additionalArgs, ...launchInput } = input;
    const promptProfile = await this.getPromptProfile(promptProfileId);
    const profileArgs = [
      ...promptProfile.clientFlags.claudeCode,
      ...(additionalArgs ?? []),
    ];
    const shared = {
      ...launchInput,
      sessionInstructions: promptProfile.instructions,
      ...(profileArgs.length === 0 ? {} : { additionalArgs: profileArgs }),
    };

    if (promptProfile.fallbackPolicy === "logical-model") {
      const logicalModelId = promptProfile.preferredLogicalModelId;
      if (logicalModelId === undefined) {
        throw new PromptProfileLaunchConfigurationError(
          promptProfile.id,
          "logical-model fallback requires a preferred logical model.",
        );
      }
      return this.launchClaudeLogicalModel({ ...shared, logicalModelId });
    }

    if (
      promptProfile.preferredProviderId === undefined ||
      promptProfile.preferredModelId === undefined
    ) {
      throw new PromptProfileLaunchConfigurationError(
        promptProfile.id,
        "disabled fallback requires both a preferred provider and preferred model.",
      );
    }
    return this.launchClaude({
      ...shared,
      providerId: promptProfile.preferredProviderId,
      modelId: promptProfile.preferredModelId,
    });
  }

  async launchClaudeProjectProfile(
    input: Omit<
      Parameters<ProviderDockApplication["launchClaudePromptProfile"]>[0],
      "promptProfileId"
    >,
  ): Promise<ClaudeProcessExit> {
    const projectProfile = await this.getProjectProfile(input.projectDirectory);
    return this.launchClaudePromptProfile({
      ...input,
      promptProfileId: projectProfile.promptProfileId,
    });
  }

  async resolveProviderClient(
    providerId: string,
    modelId?: string,
  ): Promise<ResolvedLaunchClient> {
    return this.resolveClientFromProfile(
      await this.getProvider(providerId),
      modelId,
    );
  }

  async resolveLogicalModelClient(
    logicalModelId: string,
  ): Promise<ResolvedLaunchClient> {
    const logicalModel = await this.getLogicalModel(logicalModelId);
    for (const route of orderedLogicalRoutes(logicalModel)) {
      const provider = await this.getProvider(route.providerId);
      if (!provider.enabled || provider.disabledModelIds.includes(route.modelId)) continue;
      return this.resolveClientFromProfile(provider, route.modelId);
    }
    throw new AutomaticClientResolutionError(
      `Logical model '${logicalModelId}' has no enabled provider route for automatic client selection.`,
    );
  }

  async resolvePromptProfileClient(
    promptProfileId: string,
  ): Promise<ResolvedLaunchClient> {
    const promptProfile = await this.getPromptProfile(promptProfileId);
    if (promptProfile.preferredClient !== "auto") {
      return promptProfile.preferredClient;
    }
    if (
      promptProfile.fallbackPolicy === "logical-model" &&
      promptProfile.preferredLogicalModelId !== undefined
    ) {
      return this.resolveLogicalModelClient(
        promptProfile.preferredLogicalModelId,
      );
    }
    if (promptProfile.preferredProviderId !== undefined) {
      return this.resolveProviderClient(
        promptProfile.preferredProviderId,
        promptProfile.preferredModelId,
      );
    }
    if (promptProfile.preferredLogicalModelId !== undefined) {
      return this.resolveLogicalModelClient(
        promptProfile.preferredLogicalModelId,
      );
    }
    throw new PromptProfileLaunchConfigurationError(
      promptProfile.id,
      "automatic client selection requires a preferred provider or logical model.",
    );
  }

  async launchProviderAutomatic(
    input: AutomaticLaunchOptions & {
      readonly providerId: string;
      readonly modelId: string;
    },
  ): Promise<AutomaticLaunchResult> {
    const { providerId, modelId, ...options } = input;
    const client = await this.resolveProviderClient(providerId, modelId);
    const exit =
      client === "codex"
        ? await this.launchCodex({
            ...options,
            providerId,
            modelId,
            route: { kind: "auto" },
          })
        : await this.launchClaude({ ...options, providerId, modelId });
    return { client, exit };
  }

  async launchLogicalModelAutomatic(
    input: AutomaticLaunchOptions & { readonly logicalModelId: string },
  ): Promise<AutomaticLaunchResult> {
    const { logicalModelId, ...options } = input;
    const client = await this.resolveLogicalModelClient(logicalModelId);
    const exit =
      client === "codex"
        ? await this.launchCodexLogicalModel({
            ...options,
            logicalModelId,
            route: { kind: "auto" },
          })
        : await this.launchClaudeLogicalModel({ ...options, logicalModelId });
    return { client, exit };
  }

  async launchPromptProfileAutomatic(
    input: AutomaticLaunchOptions & { readonly promptProfileId: string },
  ): Promise<AutomaticLaunchResult> {
    const { promptProfileId, ...options } = input;
    const client = await this.resolvePromptProfileClient(promptProfileId);
    const exit =
      client === "codex"
        ? await this.launchCodexPromptProfile({ ...options, promptProfileId })
        : await this.launchClaudePromptProfile({ ...options, promptProfileId });
    return { client, exit };
  }

  async launchProjectProfileAutomatic(
    input: AutomaticLaunchOptions,
  ): Promise<AutomaticLaunchResult> {
    const projectProfile = await this.getProjectProfile(input.projectDirectory);
    return this.launchPromptProfileAutomatic({
      ...input,
      promptProfileId: projectProfile.promptProfileId,
    });
  }

  private requireSecretVault(): SecretVault {
    if (!this.secretVault) throw new SecretVaultUnavailableError();
    return this.secretVault;
  }

  private requireCodexLauncher(): CodexLauncher {
    if (!this.codexLauncher) {
      throw new Error("The Codex runtime launcher is not configured.");
    }
    return this.codexLauncher;
  }

  private requireClaudeLauncher(): ClaudeLauncher {
    if (!this.claudeLauncher) {
      throw new Error("The Claude Code runtime launcher is not configured.");
    }
    return this.claudeLauncher;
  }

  private prepareProfile(profile: ProviderProfile): ProviderProfile {
    return this.adapters?.prepareProfile(profile) ?? profile;
  }

  private validateProfileBundleReferences(
    bundle: ProfileBundle,
    available: {
      readonly providerIds: ReadonlySet<string>;
      readonly logicalModelIds: ReadonlySet<string>;
      readonly promptProfileIds: ReadonlySet<string>;
    },
  ): void {
    const problems: string[] = [];
    for (const logicalModel of bundle.logicalModels) {
      for (const route of logicalModel.routes) {
        if (!available.providerIds.has(route.providerId)) {
          problems.push(
            `logical model '${logicalModel.id}' references missing provider '${route.providerId}'`,
          );
        }
      }
    }
    for (const profile of bundle.promptProfiles) {
      if (
        profile.preferredProviderId !== undefined &&
        !available.providerIds.has(profile.preferredProviderId)
      ) {
        problems.push(
          `prompt profile '${profile.id}' references missing provider '${profile.preferredProviderId}'`,
        );
      }
      if (
        profile.preferredLogicalModelId !== undefined &&
        !available.logicalModelIds.has(profile.preferredLogicalModelId)
      ) {
        problems.push(
          `prompt profile '${profile.id}' references missing logical model '${profile.preferredLogicalModelId}'`,
        );
      }
    }
    for (const profile of bundle.projectProfiles) {
      if (!available.promptProfileIds.has(profile.promptProfileId)) {
        problems.push(
          `project '${profile.projectDirectory}' references missing prompt profile '${profile.promptProfileId}'`,
        );
      }
    }
    if (problems.length > 0) throw new ProfileBundleValidationError(problems);
  }

  private async resolveClientFromProfile(
    profile: ProviderProfile,
    modelId?: string,
  ): Promise<ResolvedLaunchClient> {
    const heuristic = automaticClient(profile, modelId);
    if (modelId === undefined) return heuristic;

    const record = await this.healthRecords.get(profile.id);
    const diagnostic = record?.diagnostics.find(
      (snapshot) => snapshot.modelId === modelId,
    );
    if (diagnostic === undefined) return heuristic;

    const codexRank = compatibilityRank(diagnostic.codexCompatibility);
    const claudeRank = compatibilityRank(diagnostic.claudeCompatibility);
    if (codexRank === 0 && claudeRank === 0) {
      throw new AutomaticClientResolutionError(
        `Model '${modelId}' at provider '${profile.id}' is diagnosed as incompatible with both Codex CLI and Claude Code.`,
      );
    }
    return automaticClient(profile, modelId, diagnostic);
  }
}

function importCounts<T extends { readonly id: string }>(
  imported: readonly T[],
  existing: ReadonlyMap<string, unknown>,
): ProfileBundleImportCounts {
  return {
    created: imported.filter((entry) => !existing.has(entry.id)).length,
    updated: imported.filter((entry) => existing.has(entry.id)).length,
  };
}

function compatibilityRank(status: ClientCompatibilityStatus): number {
  switch (status) {
    case "NATIVE":
      return 3;
    case "ADAPTER":
      return 2;
    case "UNKNOWN":
      return 1;
    case "INCOMPATIBLE":
      return 0;
  }
}
