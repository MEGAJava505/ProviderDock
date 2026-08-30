import type { ProviderProbeResult, ProviderProbeService } from "../core/health/provider-probe-service.js";
import {
  parseLogicalModelGroup,
  type LogicalModelGroup,
} from "../core/fallback/logical-model.js";
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
import type {
  CodexLauncher,
  CodexProcessExit,
  LaunchCodexInput,
} from "../clients/codex/codex-launcher.js";
import type { CodexRecoveryOutcome } from "../clients/codex/codex-runtime-session.js";
import type {
  ClaudeLauncher,
  ClaudeProcessExit,
  LaunchClaudeInput,
} from "../clients/claude/claude-launcher.js";
import type {
  DoctorReport,
  ProviderDoctor,
  RunDoctorOptions,
} from "../diagnostics/provider-doctor.js";

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
  ) {}

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

  async removeProvider(id: string): Promise<void> {
    const references = (await this.logicalModels.list())
      .filter((logicalModel) =>
        logicalModel.routes.some((route) => route.providerId === id),
      )
      .map((logicalModel) => logicalModel.id);
    if (references.length > 0) {
      throw new ProviderInUseByLogicalModelError(id, references);
    }
    if (!(await this.profiles.delete(id))) throw new ProviderNotFoundError(id);
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
    if (!(await this.logicalModels.delete(id))) throw new LogicalModelNotFoundError(id);
  }

  async probeProvider(id: string): Promise<ProviderProbeResult> {
    return this.probes.probe(await this.getProvider(id));
  }

  async diagnoseProvider(id: string, options: RunDoctorOptions = {}): Promise<DoctorReport> {
    if (!this.doctor) throw new Error("The provider doctor is not configured.");
    return this.doctor.run(await this.getProvider(id), options);
  }

  async setSecret(reference: string, value: string): Promise<void> {
    await this.requireSecretVault().set(secretReferenceSchema.parse(reference), value);
  }

  listSecretReferences(): Promise<readonly string[]> {
    return this.requireSecretVault().listReferences();
  }

  async removeSecret(reference: string): Promise<boolean> {
    return this.requireSecretVault().delete(secretReferenceSchema.parse(reference));
  }

  async launchCodex(
    input: Omit<LaunchCodexInput, "profile"> & { readonly providerId: string },
  ): Promise<CodexProcessExit> {
    const { providerId, ...launchInput } = input;
    return this.requireCodexLauncher().launch({
      ...launchInput,
      profile: await this.getProvider(providerId),
    });
  }

  recoverCodexSessions(): Promise<readonly CodexRecoveryOutcome[]> {
    return this.requireCodexLauncher().recover();
  }

  async launchClaude(
    input: Omit<LaunchClaudeInput, "profile"> & { readonly providerId: string },
  ): Promise<ClaudeProcessExit> {
    const { providerId, ...launchInput } = input;
    return this.requireClaudeLauncher().launch({
      ...launchInput,
      profile: await this.getProvider(providerId),
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
}
