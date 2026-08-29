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
import { ProviderDockApplication } from "./provider-dock-application.js";

export interface ProviderDockPaths {
  readonly dataDirectory: string;
  readonly providersFile: string;
  readonly secretsDirectory: string;
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
  const dataDirectory = configuredDirectory
    ? isAbsolute(configuredDirectory)
      ? configuredDirectory
      : resolve(configuredDirectory)
    : join(userHome, ".provider-switcher");

  return {
    dataDirectory,
    providersFile: join(dataDirectory, "providers", "providers.json"),
    secretsDirectory: join(dataDirectory, "secrets"),
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
  const openAiAdapter = new GenericOpenAiAdapter({
    secretStore: secrets,
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  const adapters = new ProviderAdapterRegistry().register(openAiAdapter);
  const probes = new ProviderProbeService(adapters);

  return new ProviderDockApplication(profiles, probes, secretVault);
}
