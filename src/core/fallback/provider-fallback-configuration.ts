import type { ProviderProfile } from "../providers/provider-profile.js";
import type { LogicalModelGroup } from "./logical-model.js";

/** Provider-independent runtime inputs shared by Codex and Claude bridges. */
export interface ProviderFallbackConfiguration {
  readonly logicalModel: LogicalModelGroup;
  readonly profiles: readonly ProviderProfile[];
}
