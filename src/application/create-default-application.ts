import { knownModelProtocol, type ModelProtocolResolver } from "../core/providers/model-protocol.js";
import { assertModelEnabled } from "../core/providers/model-access.js";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { ProviderProbeService } from "../core/health/provider-probe-service.js";
import { FileLogicalModelRepository } from "../core/fallback/logical-model-repository.js";
import { FilePromptProfileRepository } from "../core/profiles/prompt-profile-repository.js";
import { FileProjectProfileRepository } from "../core/profiles/project-profile-repository.js";
import { FileProviderHealthRepository } from "../core/health/provider-health-repository.js";
import { FileUsageRepository } from "../core/usage/usage-repository.js";
import { ProviderAdapterRegistry } from "../core/providers/provider-adapter-registry.js";
import { FileProviderProfileRepository } from "../core/providers/provider-profile-repository.js";
import { DpapiFileSecretVault, WindowsDpapiProtector } from "../core/security/dpapi-secret-vault.js";
import {
  ChainedSecretStore,
  EnvironmentSecretStore,
  type SecretStore,
  type SecretVault,
} from "../core/security/secret-store.js";
import { GenericOpenAiAdapter } from "../providers/generic-openai/generic-openai-adapter.js";
import { GenericAnthropicAdapter } from "../providers/generic-anthropic/generic-anthropic-adapter.js";
import { AgentRouterAdapter } from "../providers/agentrouter/agentrouter-adapter.js";
import { GoRouterAdapter } from "../providers/gorouter/gorouter-adapter.js";
import {
  CodexLauncher,
  NodeCodexProcessRunner,
} from "../clients/codex/codex-launcher.js";
import { ResponsesCodexBridgeFactory } from "../clients/codex/codex-bridge-factory.js";
import {
  ClaudeLauncher,
  NodeClaudeProcessRunner,
} from "../clients/claude/claude-launcher.js";
import { AnthropicClaudeBridgeFactory } from "../clients/claude/claude-bridge-factory.js";
import { CodexRuntimeSessionManager } from "../clients/codex/codex-runtime-session.js";
import {
  AgentSessionHomeManager,
  claudeAgentSessionLayout,
} from "../clients/agent-session-home.js";
import { ProviderDoctor } from "../diagnostics/provider-doctor.js";
import { ProviderDockApplication } from "./provider-dock-application.js";
import {
  loadProviderPlugins,
  type ProviderPluginModuleImporter,
} from "../core/plugins/provider-plugin-loader.js";
import type { LoadedProviderPlugin } from "../core/plugins/provider-plugin-sdk.js";
import { FilePortalRepository } from "../core/portals/portal-repository.js";
import { ProviderPortalService } from "../core/portals/provider-portal-service.js";
import { ProviderPortalAdapterRegistry } from "../core/portals/portal-types.js";
import { NewApiPortalAdapter } from "../core/portals/new-api-portal-adapter.js";
import { NofxPortalAdapter } from "../core/portals/nofx-portal-adapter.js";
import { HelyxPortalAdapter } from "../core/portals/helyx-portal-adapter.js";

export interface ProviderDockPaths {
  readonly dataDirectory: string;
  readonly providersFile: string;
  readonly logicalModelsFile: string;
  readonly promptProfilesFile: string;
  readonly projectProfilesFile: string;
  readonly healthHistoryFile: string;
  readonly usageHistoryFile: string;
  readonly secretsDirectory: string;
  readonly runtimeDirectory: string;
  readonly codexHome: string;
  readonly claudeHome: string;
}

export interface ResolveProviderDockPathsOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly userHome?: string;
}

export function resolveProviderDockPaths(
  options: ResolveProviderDockPathsOptions = {},
): ProviderDockPaths {
  const environment = options.environment ?? process.env;
  const userHome = options.userHome ?? homedir();
  const configuredDirectory = environment.PROVIDER_DOCK_HOME?.trim();
  const configuredCodexHome = environment.CODEX_HOME?.trim();
  const configuredClaudeHome = environment.CLAUDE_CONFIG_DIR?.trim();
  const dataDirectory = configuredDirectory
    ? isAbsolute(configuredDirectory)
      ? configuredDirectory
      : resolve(configuredDirectory)
    : join(userHome, ".provider-switcher");

  return {
    dataDirectory,
    providersFile: join(dataDirectory, "providers", "providers.json"),
    logicalModelsFile: join(dataDirectory, "fallback", "logical-models.json"),
    promptProfilesFile: join(dataDirectory, "prompts", "profiles.json"),
    projectProfilesFile: join(dataDirectory, "projects", "profiles.json"),
    healthHistoryFile: join(dataDirectory, "health", "history.json"),
    usageHistoryFile: join(dataDirectory, "usage", "events.json"),
    secretsDirectory: join(dataDirectory, "secrets"),
    runtimeDirectory: join(dataDirectory, "runtime"),
    codexHome: configuredCodexHome
      ? isAbsolute(configuredCodexHome)
        ? configuredCodexHome
        : resolve(configuredCodexHome)
      : join(dataDirectory, "runtime", "codex-home"),
    claudeHome: configuredClaudeHome
      ? isAbsolute(configuredClaudeHome)
        ? configuredClaudeHome
        : resolve(configuredClaudeHome)
      : join(dataDirectory, "runtime", "claude-home"),
  };
}

export interface CreateDefaultApplicationOptions extends ResolveProviderDockPathsOptions {
  readonly fetchImpl?: typeof fetch;
  readonly platform?: NodeJS.Platform;
}

export function createDefaultApplication(
  options: CreateDefaultApplicationOptions = {},
): ProviderDockApplication {
  return assembleDefaultApplication(createDefaultApplicationRuntime(options), []);
}

export interface CreateDefaultApplicationAsyncOptions
  extends CreateDefaultApplicationOptions {
  readonly pluginPaths?: readonly string[];
  readonly pluginImporter?: ProviderPluginModuleImporter;
}

export async function createDefaultApplicationAsync(
  options: CreateDefaultApplicationAsyncOptions = {},
): Promise<ProviderDockApplication> {
  const runtime = createDefaultApplicationRuntime(options);
  const pluginPaths =
    options.pluginPaths ??
    resolveProviderPluginPaths(options.environment ?? process.env);
  const providerPlugins = await loadProviderPlugins({
    modulePaths: pluginPaths,
    adapterRegistry: runtime.adapters,
    secretStore: runtime.secrets,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    ...(options.pluginImporter === undefined
      ? {}
      : { importer: options.pluginImporter }),
  });
  return assembleDefaultApplication(runtime, providerPlugins);
}

export function resolveProviderPluginPaths(
  environment: NodeJS.ProcessEnv = process.env,
): readonly string[] {
  const configured = environment.PROVIDER_DOCK_PLUGINS;
  if (configured === undefined || configured.trim() === "") return [];
  return configured.split(delimiter).map((entry) => entry.trim());
}

interface DefaultApplicationRuntime {
  readonly paths: ProviderDockPaths;
  readonly profiles: FileProviderProfileRepository;
  readonly logicalModels: FileLogicalModelRepository;
  readonly promptProfiles: FilePromptProfileRepository;
  readonly projectProfiles: FileProjectProfileRepository;
  readonly healthRecords: FileProviderHealthRepository;
  readonly usageRecords: FileUsageRepository;
  readonly secrets: SecretStore;
  readonly secretVault: SecretVault | undefined;
  readonly adapters: ProviderAdapterRegistry;
  readonly fetchImpl: typeof fetch | undefined;
}

function createDefaultApplicationRuntime(
  options: CreateDefaultApplicationOptions,
): DefaultApplicationRuntime {
  const environment = options.environment ?? process.env;
  const paths = resolveProviderDockPaths(options);
  const profiles = new FileProviderProfileRepository(paths.providersFile);
  const logicalModels = new FileLogicalModelRepository(paths.logicalModelsFile);
  const promptProfiles = new FilePromptProfileRepository(paths.promptProfilesFile);
  const projectProfiles = new FileProjectProfileRepository(paths.projectProfilesFile);
  const healthRecords = new FileProviderHealthRepository(paths.healthHistoryFile);
  const usageRecords = new FileUsageRepository(paths.usageHistoryFile);
  const environmentSecrets = new EnvironmentSecretStore(environment);
  const platform = options.platform ?? process.platform;
  let secretVault: SecretVault | undefined;
  let secrets: SecretStore = environmentSecrets;
  if (platform === "win32") {
    secretVault = new DpapiFileSecretVault(
      paths.secretsDirectory,
      new WindowsDpapiProtector({ platform }),
    );
    secrets = new ChainedSecretStore([secretVault, environmentSecrets]);
  }
  const adapterOptions = {
    secretStore: secrets,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  };
  const adapters = new ProviderAdapterRegistry()
    .register(new AgentRouterAdapter(adapterOptions))
    .register(new GoRouterAdapter(adapterOptions))
    .register(new GenericOpenAiAdapter(adapterOptions))
    .register(new GenericAnthropicAdapter(adapterOptions));
  return {
    paths,
    profiles,
    logicalModels,
    promptProfiles,
    projectProfiles,
    healthRecords,
    usageRecords,
    secrets,
    secretVault,
    adapters,
    fetchImpl: options.fetchImpl,
  };
}

function assembleDefaultApplication(
  runtime: DefaultApplicationRuntime,
  providerPlugins: readonly LoadedProviderPlugin[],
): ProviderDockApplication {
  const {
    paths,
    profiles,
    logicalModels,
    promptProfiles,
    projectProfiles,
    healthRecords,
    usageRecords,
    secrets,
    secretVault,
    adapters,
  } = runtime;
  const usageSink = async (
    event: Parameters<FileUsageRepository["record"]>[0],
  ): Promise<void> => {
    await usageRecords.record(event);
  };
  const healthSignalSink = async (
    signal: Parameters<FileProviderHealthRepository["recordRuntimeSignal"]>[0],
  ): Promise<void> => {
    await healthRecords.recordRuntimeSignal(signal);
  };
  const modelAccessCheck = async (providerId: string, modelId: string) => {
    const profile = await profiles.get(providerId);
    if (!profile) throw new Error("Provider was removed.");
    assertModelEnabled(profile, modelId);
  };
  const portalRecords = new FilePortalRepository(join(paths.dataDirectory, "portals", "accounts.json"));
  const protocolResolver: ModelProtocolResolver = async (profile, modelId, client) => {
    const [health, portal] = await Promise.all([healthRecords.get(profile.id), portalRecords.get(profile.id)]);
    return knownModelProtocol(health, portal, modelId, client);
  };
  const probes = new ProviderProbeService(adapters);
  const codexLauncher = new CodexLauncher(
    new CodexRuntimeSessionManager({
      codexHome: paths.codexHome,
      runtimeRoot: join(paths.runtimeDirectory, "codex"),
      secrets,
    }),
    new NodeCodexProcessRunner(),
    new ResponsesCodexBridgeFactory({
      secretStore: secrets,
      adapterRegistry: adapters,
      runtimeRoot: join(paths.runtimeDirectory, "codex"),
      usageSink,
      healthSignalSink,
      modelAccessCheck,
      protocolResolver,
      ...(runtime.fetchImpl === undefined
        ? {}
        : { fetchImpl: runtime.fetchImpl }),
    }),
  );

  const claudeSessionHomes = new AgentSessionHomeManager({
    rootDirectory: paths.claudeHome,
    layout: claudeAgentSessionLayout,
  });
  const claudeLauncher = new ClaudeLauncher(
    new AnthropicClaudeBridgeFactory({
      secretStore: secrets,
      adapterRegistry: adapters,
      runtimeRoot: join(paths.runtimeDirectory, "claude"),
      usageSink,
      healthSignalSink,
      modelAccessCheck,
      protocolResolver,
      ...(runtime.fetchImpl === undefined
        ? {}
        : { fetchImpl: runtime.fetchImpl }),
    }),
    new NodeClaudeProcessRunner(),
    claudeSessionHomes,
  );

  const doctor = new ProviderDoctor({
    secretStore: secrets,
    adapterRegistry: adapters,
    ...(runtime.fetchImpl === undefined
      ? {}
      : { fetchImpl: runtime.fetchImpl }),
  });

  return new ProviderDockApplication(
    profiles,
    probes,
    secretVault,
    codexLauncher,
    adapters,
    doctor,
    claudeLauncher,
    logicalModels,
    promptProfiles,
    projectProfiles,
    healthRecords,
    usageRecords,
    providerPlugins,
    undefined,
    new ProviderPortalService(
      portalRecords,
      new ProviderPortalAdapterRegistry()
        .register(new NewApiPortalAdapter(secrets,
          runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}))
        .register(new NofxPortalAdapter(secrets,
          runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {}))
        .register(new HelyxPortalAdapter(secrets,
          runtime.fetchImpl ? { fetchImpl: runtime.fetchImpl } : {})),
    ),
  );
}
