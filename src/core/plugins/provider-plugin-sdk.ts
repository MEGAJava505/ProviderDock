import { z } from "zod";
import {
  ProviderRequestError,
} from "../errors/provider-error.js";
import type { DiscoveredProviderModel } from "../providers/model-catalog.js";
import type { ProviderAdapter } from "../providers/provider-adapter.js";
import { ProviderHttpRequestBuilder } from "../providers/provider-http-request.js";
import {
  parseProviderProfile,
  pluginAdapterIdPattern,
  type ProviderProfile,
} from "../providers/provider-profile.js";
import type { SecretStore } from "../security/secret-store.js";

export const providerPluginApiVersion = 1 as const;

const pluginIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/);

export const providerPluginManifestSchema = z
  .object({
    apiVersion: z.literal(providerPluginApiVersion),
    id: pluginIdSchema,
    name: z.string().trim().min(1).max(128),
    version: z
      .string()
      .trim()
      .regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/),
    description: z.string().trim().max(4_096).default(""),
    adapterIds: z
      .array(z.string().regex(pluginAdapterIdPattern))
      .min(1)
      .max(64),
  })
  .strict()
  .superRefine((manifest, context) => {
    const ids = new Set<string>();
    for (const [index, adapterId] of manifest.adapterIds.entries()) {
      if (!adapterId.startsWith(`plugin:${manifest.id}/`)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Adapter '${adapterId}' must use namespace 'plugin:${manifest.id}/'.`,
          path: ["adapterIds", index],
        });
      }
      if (ids.has(adapterId)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Duplicate adapter ID '${adapterId}'.`,
          path: ["adapterIds", index],
        });
      }
      ids.add(adapterId);
    }
  });

export type ProviderPluginManifest = z.infer<
  typeof providerPluginManifestSchema
>;

export interface ProviderPluginRequestOptions {
  readonly method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly accept?: string;
  readonly contentType?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface ProviderPluginHttpClient {
  /**
   * Sends a same-origin request with ProviderDock-managed authentication.
   * Secret values are injected by the host and never returned to the plugin.
   */
  request(
    profile: ProviderProfile,
    endpoint: string,
    options?: ProviderPluginRequestOptions,
  ): Promise<Response>;
}

export interface ProviderPluginContext {
  readonly apiVersion: typeof providerPluginApiVersion;
  readonly http: ProviderPluginHttpClient;
}

export interface ProviderPluginDefinition {
  readonly manifest: ProviderPluginManifest;
  createAdapters(
    context: ProviderPluginContext,
  ): readonly ProviderAdapter[] | Promise<readonly ProviderAdapter[]>;
}

export interface LoadedProviderPlugin {
  readonly manifest: ProviderPluginManifest;
  readonly modulePath: string;
  readonly adapters: readonly ProviderAdapter[];
}

export interface ProviderPluginDescriptor {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly description: string;
  readonly modulePath: string;
  readonly adapterIds: readonly string[];
}

export class ProviderPluginValidationError extends Error {
  constructor(message: string, options: ErrorOptions = {}) {
    super(message, options);
    this.name = "ProviderPluginValidationError";
  }
}

export class ProviderPluginExecutionError extends Error {
  constructor(
    readonly pluginId: string,
    readonly adapterId: string | undefined,
    message: string,
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "ProviderPluginExecutionError";
  }
}

export interface CreateProviderPluginContextOptions {
  readonly secretStore: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

export function createProviderPluginContext(
  options: CreateProviderPluginContextOptions,
): ProviderPluginContext {
  return {
    apiVersion: providerPluginApiVersion,
    http: new HostProviderPluginHttpClient(options),
  };
}

export function validateProviderPluginDefinition(
  input: unknown,
): ProviderPluginDefinition {
  if (!isRecord(input)) {
    throw new ProviderPluginValidationError(
      "Plugin module must export a provider plugin object.",
    );
  }
  const parsedManifest = providerPluginManifestSchema.safeParse(input.manifest);
  if (!parsedManifest.success) {
    throw new ProviderPluginValidationError(
      `Plugin manifest is invalid: ${parsedManifest.error.issues
        .map((issue) => `${issue.path.join(".") || "manifest"}: ${issue.message}`)
        .join("; ")}`,
      { cause: parsedManifest.error },
    );
  }
  const manifest = parsedManifest.data;
  if (typeof input.createAdapters !== "function") {
    throw new ProviderPluginValidationError(
      `Plugin '${manifest.id}' must export createAdapters(context).`,
    );
  }
  return {
    manifest,
    createAdapters: input.createAdapters as ProviderPluginDefinition["createAdapters"],
  };
}

export async function instantiateProviderPlugin(
  definition: ProviderPluginDefinition,
  context: ProviderPluginContext,
  modulePath: string,
): Promise<LoadedProviderPlugin> {
  let rawAdapters: readonly ProviderAdapter[];
  try {
    rawAdapters = await definition.createAdapters(context);
  } catch (error) {
    throw new ProviderPluginExecutionError(
      definition.manifest.id,
      undefined,
      `Plugin '${definition.manifest.id}' failed while creating adapters.`,
      { cause: error },
    );
  }
  if (!Array.isArray(rawAdapters) || rawAdapters.length === 0) {
    throw new ProviderPluginValidationError(
      `Plugin '${definition.manifest.id}' returned no adapters.`,
    );
  }
  if (rawAdapters.length > 64) {
    throw new ProviderPluginValidationError(
      `Plugin '${definition.manifest.id}' returned more than 64 adapters.`,
    );
  }

  const actualIds = new Set<string>();
  const adapters = rawAdapters.map((adapter) => {
    validateAdapterShape(definition.manifest, adapter);
    if (actualIds.has(adapter.id)) {
      throw new ProviderPluginValidationError(
        `Plugin '${definition.manifest.id}' returned duplicate adapter '${adapter.id}'.`,
      );
    }
    actualIds.add(adapter.id);
    return new ValidatedPluginAdapter(definition.manifest.id, adapter);
  });
  const missing = definition.manifest.adapterIds.filter(
    (adapterId) => !actualIds.has(adapterId),
  );
  const undeclared = [...actualIds].filter(
    (adapterId) => !definition.manifest.adapterIds.includes(adapterId),
  );
  if (missing.length > 0 || undeclared.length > 0) {
    throw new ProviderPluginValidationError(
      `Plugin '${definition.manifest.id}' adapter manifest mismatch` +
        `${missing.length === 0 ? "" : `; missing: ${missing.join(", ")}`}` +
        `${undeclared.length === 0 ? "" : `; undeclared: ${undeclared.join(", ")}`}.`,
    );
  }
  return { manifest: definition.manifest, modulePath, adapters };
}

class HostProviderPluginHttpClient implements ProviderPluginHttpClient {
  private readonly requests: ProviderHttpRequestBuilder;
  private readonly fetchImpl: typeof fetch;

  constructor(options: CreateProviderPluginContextOptions) {
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async request(
    profile: ProviderProfile,
    endpoint: string,
    options: ProviderPluginRequestOptions = {},
  ): Promise<Response> {
    const built = await this.requests.build(profile, endpoint, {
      ...(options.accept === undefined ? {} : { accept: options.accept }),
      ...(options.contentType === undefined
        ? {}
        : { contentType: options.contentType }),
    });
    for (const [name, value] of Object.entries(options.headers ?? {})) {
      if (forbiddenPluginHeaderNames.has(name.toLowerCase())) {
        throw new ProviderRequestError(
          "INVALID_REQUEST",
          `Plugin request cannot override protected header '${name}'.`,
        );
      }
      built.headers.set(name, value);
    }
    const timeout = AbortSignal.timeout(profile.timeoutMs);
    const signal =
      options.signal === undefined
        ? timeout
        : AbortSignal.any([options.signal, timeout]);
    try {
      const response = await this.fetchImpl(built.url, {
        method: options.method ?? "GET",
        headers: built.headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        signal,
      });
      // Reconstructing the response prevents query-auth values from being
      // exposed through Response.url while preserving the response payload.
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new ProviderRequestError(
          "TIMEOUT",
          "Plugin provider request timed out.",
          { cause: error },
        );
      }
      throw new ProviderRequestError(
        "NETWORK_ERROR",
        "Plugin provider request failed.",
        { cause: error },
      );
    }
  }
}

class ValidatedPluginAdapter implements ProviderAdapter {
  readonly id: string;

  constructor(
    private readonly pluginId: string,
    private readonly adapter: ProviderAdapter,
  ) {
    this.id = adapter.id;
  }

  supports(profile: ProviderProfile): boolean {
    if (profile.adapterId !== this.id) return false;
    let supported: unknown;
    try {
      supported = this.adapter.supports(cloneProviderProfile(profile));
    } catch (error) {
      throw this.executionError("supports() failed.", error);
    }
    if (typeof supported !== "boolean") {
      throw this.executionError("supports() returned a non-boolean value.");
    }
    return supported;
  }

  prepareProfile(profile: ProviderProfile): ProviderProfile {
    if (this.adapter.prepareProfile === undefined) return profile;
    const original = cloneProviderProfile(profile);
    let prepared: ProviderProfile;
    try {
      prepared = parseProviderProfile(
        this.adapter.prepareProfile(cloneProviderProfile(profile)),
      );
    } catch (error) {
      throw this.executionError(
        "prepareProfile() returned an invalid provider profile.",
        error,
      );
    }
    if (
      prepared.id !== original.id ||
      prepared.baseUrl !== original.baseUrl ||
      prepared.adapterId !== original.adapterId ||
      !recordsEqual(prepared.auth, original.auth) ||
      !recordsEqual(prepared.secretHeaders, original.secretHeaders)
    ) {
      throw this.executionError(
        "prepareProfile() attempted to change provider identity, base URL, adapter, or secret references.",
      );
    }
    return prepared;
  }

  compatibilityFixes(profile: ProviderProfile): readonly string[] {
    if (this.adapter.compatibilityFixes === undefined) return [];
    let fixes: readonly string[];
    try {
      fixes = this.adapter.compatibilityFixes(cloneProviderProfile(profile));
    } catch (error) {
      throw this.executionError("compatibilityFixes() failed.", error);
    }
    if (
      !Array.isArray(fixes) ||
      fixes.length > 256 ||
      fixes.some(
        (fix) =>
          typeof fix !== "string" || fix.length === 0 || fix.length > 256,
      )
    ) {
      throw this.executionError(
        "compatibilityFixes() returned an invalid fix list.",
      );
    }
    return fixes;
  }

  async discoverModels(
    profile: ProviderProfile,
  ): Promise<readonly DiscoveredProviderModel[]> {
    let models: readonly DiscoveredProviderModel[];
    try {
      models = await this.adapter.discoverModels(cloneProviderProfile(profile));
    } catch (error) {
      if (error instanceof ProviderRequestError) throw error;
      throw this.executionError("discoverModels() failed.", error);
    }
    const parsed = discoveredModelsSchema.safeParse(models);
    if (!parsed.success) {
      throw this.executionError(
        "discoverModels() returned invalid model metadata.",
        parsed.error,
      );
    }
    const ids = new Set<string>();
    for (const model of parsed.data) {
      if (ids.has(model.modelId)) {
        throw this.executionError(
          `discoverModels() returned duplicate model '${model.modelId}'.`,
        );
      }
      ids.add(model.modelId);
    }
    return parsed.data;
  }

  private executionError(
    message: string,
    cause?: unknown,
  ): ProviderPluginExecutionError {
    return new ProviderPluginExecutionError(
      this.pluginId,
      this.id,
      `Plugin adapter '${this.id}' ${message}`,
      cause === undefined ? {} : { cause },
    );
  }
}

const discoveredModelsSchema = z
  .array(
    z
      .object({
        modelId: z.string().trim().min(1).max(256),
        displayName: z.string().trim().min(1).max(512),
        raw: z.record(z.string(), z.unknown()),
      })
      .strict(),
  )
  .max(5_000);

const forbiddenPluginHeaderNames = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "cookie",
  "host",
  "connection",
  "content-length",
]);

function validateAdapterShape(
  manifest: ProviderPluginManifest,
  adapter: unknown,
): asserts adapter is ProviderAdapter {
  if (
    !isRecord(adapter) ||
    typeof adapter.id !== "string" ||
    !pluginAdapterIdPattern.test(adapter.id) ||
    !adapter.id.startsWith(`plugin:${manifest.id}/`) ||
    typeof adapter.supports !== "function" ||
    typeof adapter.discoverModels !== "function" ||
    (adapter.prepareProfile !== undefined &&
      typeof adapter.prepareProfile !== "function") ||
    (adapter.compatibilityFixes !== undefined &&
      typeof adapter.compatibilityFixes !== "function")
  ) {
    throw new ProviderPluginValidationError(
      `Plugin '${manifest.id}' returned an invalid adapter object.`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneProviderProfile(profile: ProviderProfile): ProviderProfile {
  return parseProviderProfile(profile);
}

function recordsEqual(
  left: Readonly<Record<string, unknown>>,
  right: Readonly<Record<string, unknown>>,
): boolean {
  const leftEntries = Object.entries(left).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right).sort(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}
