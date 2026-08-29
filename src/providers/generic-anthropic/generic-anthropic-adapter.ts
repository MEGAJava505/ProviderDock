import { z } from "zod";
import {
  normalizeHttpStatus,
  ProviderRequestError,
} from "../../core/errors/provider-error.js";
import type { DiscoveredProviderModel } from "../../core/providers/model-catalog.js";
import type { ProviderAdapter } from "../../core/providers/provider-adapter.js";
import type { ProviderProfile } from "../../core/providers/provider-profile.js";
import type { SecretStore } from "../../core/security/secret-store.js";
import { ProviderHttpRequestBuilder } from "../../core/providers/provider-http-request.js";

export const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";

const modelSchema = z
  .object({
    id: z.string().trim().min(1),
    display_name: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
  })
  .passthrough();

const dataModelListSchema = z.object({ data: z.array(modelSchema) }).passthrough();
const namedModelListSchema = z.object({ models: z.array(modelSchema) }).passthrough();
const arrayModelListSchema = z.array(modelSchema);

export interface GenericAnthropicAdapterOptions {
  readonly secretStore: SecretStore;
  readonly fetchImpl?: typeof fetch;
}

/**
 * Adapter for providers that natively speak the Anthropic Messages protocol.
 *
 * Model discovery targets the Anthropic `/v1/models` shape and always sends
 * an `anthropic-version` header (unless the profile already pins one).
 */
export class GenericAnthropicAdapter implements ProviderAdapter {
  readonly id = "generic-anthropic";
  private readonly requests: ProviderHttpRequestBuilder;
  private readonly fetchImpl: typeof fetch;

  constructor(options: GenericAnthropicAdapterOptions) {
    this.requests = new ProviderHttpRequestBuilder(options.secretStore);
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  supports(profile: ProviderProfile): boolean {
    if (profile.adapterId === "generic-anthropic") {
      return ["auto", "anthropic-messages"].includes(profile.apiType);
    }
    return profile.adapterId === "auto" && profile.apiType === "anthropic-messages";
  }

  async discoverModels(profile: ProviderProfile): Promise<readonly DiscoveredProviderModel[]> {
    const { url, headers } = await this.requests.build(profile, profile.modelsEndpoint);
    if (!headers.has("anthropic-version")) {
      headers.set("anthropic-version", DEFAULT_ANTHROPIC_VERSION);
    }

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
