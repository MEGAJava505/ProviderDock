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
