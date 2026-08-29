import { z } from "zod";
import {
  normalizeHttpStatus,
  ProviderRequestError,
} from "../../core/errors/provider-error.js";
import type { DiscoveredProviderModel } from "../../core/providers/model-catalog.js";
import type { ProviderAdapter } from "../../core/providers/provider-adapter.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    name: z.string().trim().min(1).optional(),
    display_name: z.string().trim().min(1).optional(),
  })
  .passthrough();

const dataModelListSchema = z.object({ data: z.array(modelSchema) }).passthrough();
const namedModelListSchema = z.object({ models: z.array(modelSchema) }).passthrough();
const arrayModelListSchema = z.array(modelSchema);

export interface GenericOpenAiAdapterOptions {
  readonly secretStore: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

export class GenericOpenAiAdapter implements ProviderAdapter {
  readonly id = "generic-openai";
  private readonly secretStore: SecretStore;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GenericOpenAiAdapterOptions) {
    this.secretStore = options.secretStore;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(profile: ProviderProfile): boolean {
    return (
      ["auto", "generic-openai"].includes(profile.adapterId) &&
      ["auto", "openai-responses", "openai-chat-completions"].includes(profile.apiType)
    );
  }

  async discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredProviderModel[]> {
    const url = await this.createModelsUrl(profile);
    const headers = await this.createHeaders(profile);
    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(profile.timeoutMs),
      });
    } catch (error) {
      if (isAbortOrTimeoutError(error)) {
        throw new ProviderRequestError("TIMEOUT", "Provider model discovery timed out.", {
          cause: error,
        });
      }
      throw new ProviderRequestError("NETWORK_ERROR", "Provider model discovery failed.", {
        cause: error,
      });
    }

    if (!response.ok) {
      throw new ProviderRequestError(
        normalizeHttpStatus(response.status),
        `Provider model discovery returned HTTP ${response.status}.`,
        { httpStatus: response.status },
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await response.text());
    } catch (error) {
      throw new ProviderRequestError(
        "PROTOCOL_ERROR",
        "Provider model discovery returned invalid JSON.",
        { cause: error, httpStatus: response.status },
      );
    }

    const rawModels = parseModelList(payload);
    if (!rawModels) {
      throw new ProviderRequestError(
        "PROTOCOL_ERROR",
        "Provider model discovery returned an unsupported schema.",
        { httpStatus: response.status },
      );
    }
    const uniqueModels = new Map<string, DiscoveredProviderModel>();

    for (const model of rawModels) {
      uniqueModels.set(model.id, {
        modelId: model.id,
        displayName: model.display_name ?? model.name ?? model.id,
        raw: model,
      });
    }

    return [...uniqueModels.values()];
  }

  private async createHeaders(profile: ProviderProfile): Promise<Headers> {
    const headers = new Headers({ Accept: "application/json", ...profile.staticHeaders });

    if (profile.auth.kind === "bearer") {
      headers.set("Authorization", `Bearer ${await this.requireSecret(profile.auth.secretRef)}`);
    } else if (profile.auth.kind === "header") {
      headers.set(profile.auth.headerName, await this.requireSecret(profile.auth.secretRef));
    }

    for (const [headerName, secretRef] of Object.entries(profile.secretHeaders)) {
      headers.set(headerName, await this.requireSecret(secretRef));
    }

    return headers;
  }

  private async createModelsUrl(profile: ProviderProfile): Promise<URL> {
    const base = profile.baseUrl.endsWith("/") ? profile.baseUrl : `${profile.baseUrl}/`;
    const url = new URL(profile.modelsEndpoint, base);

    for (const [name, value] of Object.entries(profile.queryParameters)) {
      url.searchParams.set(name, value);
    }

    if (profile.auth.kind === "query") {
      url.searchParams.set(
        profile.auth.parameterName,
        await this.requireSecret(profile.auth.secretRef),
      );
    }

    return url;
  }

  private async requireSecret(reference: string): Promise<string> {
    const secret = await this.secretStore.get(reference);
    if (!secret) {
      throw new ProviderRequestError(
        "AUTH_ERROR",
        `Required secret reference '${reference}' is not available.`,
      );
    }
    return secret;
  }
}

function isAbortOrTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}

function parseModelList(payload: unknown): readonly z.infer<typeof modelSchema>[] | undefined {
  const dataEnvelope = dataModelListSchema.safeParse(payload);
  if (dataEnvelope.success) return dataEnvelope.data.data;

  const namedEnvelope = namedModelListSchema.safeParse(payload);
  if (namedEnvelope.success) return namedEnvelope.data.models;

  const array = arrayModelListSchema.safeParse(payload);
  return array.success ? array.data : undefined;
}
