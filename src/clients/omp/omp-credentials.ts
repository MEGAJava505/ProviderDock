import type { SecretStore } from "../../core/security/secret-store.js";
import { secretReferenceSchema } from "../../core/providers/provider-profile.js";
import type { OmpSecretRequirement } from "./omp-config-compiler.js";

const inheritedNames = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "OS",
]);

export type OmpCredentialErrorCode =
  | "INVALID_REQUIREMENTS" | "INVALID_ENVIRONMENT"
  | "CREDENTIAL_MISSING" | "CREDENTIAL_INVALID" | "CREDENTIAL_UNAVAILABLE";

export class OmpCredentialError extends Error {
  constructor(readonly code: OmpCredentialErrorCode) {
    super(`OMP credentials rejected: ${code}.`);
    this.name = "OmpCredentialError";
  }
}

function validateRequirements(requirements: readonly OmpSecretRequirement[]): Map<string, string> {
  const referencesByEnv = new Map<string, string>();
  for (const requirement of requirements) {
    const parsed = secretReferenceSchema.safeParse(requirement.secretRef);
    if (
      !parsed.success || parsed.data !== requirement.secretRef ||
      !/^PROVIDERDOCK_OMP_[A-F0-9]{64}$/.test(requirement.envName) ||
      (referencesByEnv.has(requirement.envName) &&
        referencesByEnv.get(requirement.envName) !== requirement.secretRef)
    ) throw new OmpCredentialError("INVALID_REQUIREMENTS");
    referencesByEnv.set(requirement.envName, requirement.secretRef);
  }
  return referencesByEnv;
}

/**
 * Ephemeral child environment only. Do not persist, log, serialize for UI, or put
 * it in argv. No implicit process.env access or environment-backed key fallback.
 * The runtime must add its own managed home/PI/XDG paths AFTER this boundary.
 */
export async function resolveOmpChildEnvironment(
  requiredSecrets: readonly OmpSecretRequirement[],
  secretStore: SecretStore,
  ambientEnvironment: Readonly<NodeJS.ProcessEnv> = {},
): Promise<NodeJS.ProcessEnv> {
  // Validate the complete request BEFORE the first vault read (including duplicates).
  const references = validateRequirements(requiredSecrets);
  const environment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(ambientEnvironment).sort()) {
    const canonicalName = name.toUpperCase();
    if (!inheritedNames.has(canonicalName)) continue;
    const value = ambientEnvironment[name];
    if (value !== undefined) {
      if (
        typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value) ||
        (Object.hasOwn(environment, canonicalName) && environment[canonicalName] !== value)
      ) throw new OmpCredentialError("INVALID_ENVIRONMENT");
      environment[canonicalName] = value;
    }
  }
  const resolved = new Map<string, string>();
  for (const [envName, reference] of references) {
    let value = resolved.get(reference);
    if (value === undefined) {
      try {
        value = await secretStore.get(reference);
      } catch {
        // SecretStore/DPAPI errors can contain plaintext. Do not attach a cause.
        throw new OmpCredentialError("CREDENTIAL_UNAVAILABLE");
      }
      if (value === undefined || (typeof value === "string" && !value.trim())) {
        throw new OmpCredentialError("CREDENTIAL_MISSING");
      }
      if (
        typeof value !== "string" || value.trim() !== value || /[^\x20-\x7e]/.test(value) ||
        // Pin-special values change routing/auth semantics; OAuth is outside this slice.
        value === "N/A" || value.includes("sk-ant-oat")
      ) throw new OmpCredentialError("CREDENTIAL_INVALID");
      resolved.set(reference, value);
    }
    environment[envName] = value;
  }
  return environment;
}
