import { realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ProviderAdapterRegistry } from "../providers/provider-adapter-registry.js";
import type { SecretStore } from "../security/secret-store.js";
import {
  createProviderPluginContext,
  instantiateProviderPlugin,
  validateProviderPluginDefinition,
  type LoadedProviderPlugin,
} from "./provider-plugin-sdk.js";

export type ProviderPluginModuleImporter = (
  moduleUrl: string,
) => Promise<unknown>;

export interface LoadProviderPluginsOptions {
  readonly modulePaths: readonly string[];
  readonly adapterRegistry: ProviderAdapterRegistry;
  readonly secretStore: SecretStore;
  readonly fetchImpl?: typeof fetch;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly importer?: ProviderPluginModuleImporter;
  readonly realpathImpl?: typeof realpath;
  readonly statImpl?: typeof stat;
}

export class ProviderPluginLoadError extends Error {
  constructor(
    readonly modulePath: string | undefined,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderPluginLoadError";
  }
}

/**
 * Loads only the local module paths explicitly supplied by the caller.
 * ProviderDock never scans directories or executes provider profile metadata.
 */
export async function loadProviderPlugins(
  options: LoadProviderPluginsOptions,
): Promise<readonly LoadedProviderPlugin[]> {
  if (options.modulePaths.length === 0) return [];

  const canonicalModules = await resolveExplicitPluginPaths(options);
  const importer = options.importer ?? importProviderPluginModule;
  const context = createProviderPluginContext({
    secretStore: options.secretStore,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  const loaded: LoadedProviderPlugin[] = [];
  const pluginIds = new Set<string>();
  const adapterIds = new Set(options.adapterRegistry.listAdapterIds());

  for (const modulePath of canonicalModules) {
    let plugin: LoadedProviderPlugin;
    try {
      const imported = await importer(pathToFileURL(modulePath).href);
      const definition = validateProviderPluginDefinition(
        selectPluginExport(imported, modulePath),
      );
      plugin = await instantiateProviderPlugin(definition, context, modulePath);
    } catch (error) {
      if (error instanceof ProviderPluginLoadError) throw error;
      throw new ProviderPluginLoadError(
        modulePath,
        `Unable to load provider plugin '${modulePath}': ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }

    if (pluginIds.has(plugin.manifest.id)) {
      throw new ProviderPluginLoadError(
        modulePath,
        `Provider plugin ID '${plugin.manifest.id}' is already loaded.`,
      );
    }
    for (const adapter of plugin.adapters) {
      if (adapterIds.has(adapter.id)) {
        throw new ProviderPluginLoadError(
          modulePath,
          `Provider adapter ID '${adapter.id}' is already registered.`,
        );
      }
    }
    pluginIds.add(plugin.manifest.id);
    for (const adapter of plugin.adapters) adapterIds.add(adapter.id);
    loaded.push(plugin);
  }

  // All modules are imported and validated before the shared registry changes.
  for (const plugin of loaded) {
    for (const adapter of plugin.adapters) {
      options.adapterRegistry.register(adapter);
    }
  }
  return loaded;
}

async function resolveExplicitPluginPaths(
  options: LoadProviderPluginsOptions,
): Promise<readonly string[]> {
  const cwd = options.cwd ?? process.cwd();
  const platform = options.platform ?? process.platform;
  const resolveRealpath = options.realpathImpl ?? realpath;
  const readStat = options.statImpl ?? stat;
  const canonicalPaths: string[] = [];
  const dedupe = new Set<string>();

  for (const configuredPath of options.modulePaths) {
    const value = configuredPath.trim();
    if (value.length === 0) {
      throw new ProviderPluginLoadError(
        configuredPath,
        "Provider plugin paths cannot be empty.",
      );
    }
    if (!isAbsolute(value) && looksLikeUrl(value)) {
      throw new ProviderPluginLoadError(
        value,
        `Provider plugin '${value}' must be a local file path, not a URL.`,
      );
    }
    if (!isAbsolute(value) && !isExplicitRelativePath(value)) {
      throw new ProviderPluginLoadError(
        value,
        `Provider plugin '${value}' must be an absolute path or start with './' or '../'.`,
      );
    }

    const requestedPath = isAbsolute(value) ? value : resolve(cwd, value);
    let canonicalPath: string;
    try {
      canonicalPath = await resolveRealpath(requestedPath);
      if (!(await readStat(canonicalPath)).isFile()) {
        throw new Error("path is not a file");
      }
    } catch (error) {
      throw new ProviderPluginLoadError(
        requestedPath,
        `Provider plugin module '${requestedPath}' is not an accessible file.`,
        { cause: error },
      );
    }
    const key = platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    if (dedupe.has(key)) {
      throw new ProviderPluginLoadError(
        canonicalPath,
        `Provider plugin module '${canonicalPath}' was configured more than once.`,
      );
    }
    dedupe.add(key);
    canonicalPaths.push(canonicalPath);
  }
  return canonicalPaths;
}

function selectPluginExport(imported: unknown, modulePath: string): unknown {
  if (!isRecord(imported)) {
    throw new ProviderPluginLoadError(
      modulePath,
      "Provider plugin module did not expose module exports.",
    );
  }
  const defaultExport = imported.default;
  const namedExport = imported.providerDockPlugin;
  if (
    defaultExport !== undefined &&
    namedExport !== undefined &&
    defaultExport !== namedExport
  ) {
    throw new ProviderPluginLoadError(
      modulePath,
      "Provider plugin module has conflicting default and providerDockPlugin exports.",
    );
  }
  const selected = defaultExport ?? namedExport;
  if (selected === undefined) {
    throw new ProviderPluginLoadError(
      modulePath,
      "Provider plugin module must export default or providerDockPlugin.",
    );
  }
  return selected;
}

function isExplicitRelativePath(value: string): boolean {
  return /^(?:\.{1,2})[\\/]/.test(value);
}

function looksLikeUrl(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function importProviderPluginModule(moduleUrl: string): Promise<unknown> {
  return import(moduleUrl);
}
