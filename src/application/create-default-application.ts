import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { ProviderProbeService } from "../core/health/provider-probe-service.js";
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
import { AgentRouterAdapter } from "../providers/agentrouter/agentrouter-adapter.js";
import { GoRouterAdapter } from "../providers/gorouter/gorouter-adapter.js";
import {
  CodexLauncher,
  NodeCodexProcessRunner,
} from "../clients/codex/codex-launcher.js";
import { ResponsesCodexBridgeFactory } from "../clients/codex/codex-bridge-factory.js";
import { CodexRuntimeSessionManager } from "../clients/codex/codex-runtime-session.js";
import { ProviderDoctor } from "../diagnostics/provider-doctor.js";
import { ProviderDockApplication } from "./provider-dock-application.js";

export interface ProviderDockPaths {
  readonly dataDirectory: string;
  readonly providersFile: string;
  readonly secretsDirectory: string;
  readonly runtimeDirectory: string;
  readonly codexHome: string;
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
  const dataDirectory = configuredDirectory
    ? isAbsolute(configuredDirectory)
      ? configuredDirectory
      : resolve(configuredDirectory)
    : join(userHome, ".provider-switcher");

  return {
    dataDirectory,
    providersFile: join(dataDirectory, "providers", "providers.json"),
    secretsDirectory: join(dataDirectory, "secrets"),
    runtimeDirectory: join(dataDirectory, "runtime"),
    codexHome: configuredCodexHome
      ? isAbsolute(configuredCodexHome)
        ? configuredCodexHome
        : resolve(configuredCodexHome)
      : join(userHome, ".codex"),
  };
}

export interface CreateDefaultApplicationOptions extends ResolveProviderDockPathsOptions {
  readonly fetchImpl?: typeof fetch;
  readonly platform?: NodeJS.Platform;
}

export function createDefaultApplication(
  options: CreateDefaultApplicationOptions = {},
): ProviderDockApplication {
  const environment = options.environment ?? process.env;
  const paths = resolveProviderDockPaths(options);
  const profiles = new FileProviderProfileRepository(paths.providersFile);
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
    .register(new GenericOpenAiAdapter(adapterOptions));
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
      ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
    }),
  );

  const doctor = new ProviderDoctor({
    secretStore: secrets,
    adapterRegistry: adapters,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  return new ProviderDockApplication(
    profiles,
    probes,
    secretVault,
    codexLauncher,
    adapters,
    doctor,
  );
}
