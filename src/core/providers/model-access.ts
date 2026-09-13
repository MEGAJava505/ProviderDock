import { ProviderRequestError } from "../errors/provider-error.js";
import type { ProviderProfile } from "./provider-profile.js";

export type ModelAccessCheck = (providerId: string, modelId: string) => Promise<void>;

/** A local choice, not a provider outage or a failed upstream request. */
export class ModelDisabledError extends ProviderRequestError {
  constructor(profile: ProviderProfile, modelId: string) {
    super("INVALID_REQUEST", `Модель «${modelId}» у провайдера «${profile.displayName}» отключена в настройках.`);
    this.name = "ModelDisabledError";
  }
}

export function assertModelEnabled(profile: ProviderProfile, modelId: string): void {
  if (!profile.enabled || profile.disabledModelIds.includes(modelId)) {
    throw new ModelDisabledError(profile, modelId);
  }
}

/** A configured provider was healthy enough to publish a catalog, but the requested model was not in it. */
export class ModelUnavailableError extends ProviderRequestError {
  readonly availableModelIds: readonly string[];

  constructor(
    profile: ProviderProfile,
    modelId: string,
    availableModelIds: readonly string[],
  ) {
    const available = [...new Set(availableModelIds)].sort();
    super(
      "MODEL_NOT_FOUND",
      available.length === 0
        ? `Model '${modelId}' is not available for provider '${profile.displayName}'. No models are currently available.`
        : `Model '${modelId}' is not available for provider '${profile.displayName}'. Available models: ${available.join(", ")}.`,
    );
    this.name = "ModelUnavailableError";
    this.availableModelIds = available;
  }
}

export function assertModelAvailable(
  profile: ProviderProfile,
  modelId: string,
  availableModelIds: readonly string[],
): void {
  assertModelEnabled(profile, modelId);
  if (!availableModelIds.includes(modelId)) {
    throw new ModelUnavailableError(profile, modelId, availableModelIds);
  }
}
