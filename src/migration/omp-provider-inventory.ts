import { createHash } from "node:crypto";
import { providerProfileSchema } from "../core/providers/provider-profile.js";
import {
  inventoryMigrationSource,
  readVerifiedMigrationMetadata,
  verifyMigrationSource,
  MigrationSafetyError,
  type MigrationSourcePolicy,
} from "./migration-manifest.js";
import { assessOmpProviderMappings } from "./omp-provider-mapping.js";

/** Explicit-file, read-only evidence; this operation never opens a vault. */
export async function inventoryOmpProviderMappings(
  source: MigrationSourcePolicy,
  options: { readonly expectedProviderCount?: number } = {},
) {
  const providerFiles = source.files.filter((file) => file.kind === "provider-metadata");
  if (providerFiles.length !== 1) throw new MigrationSafetyError("AMBIGUOUS_PROVIDER_SOURCE");
  const manifest = await inventoryMigrationSource(source);
  const raw = await readVerifiedMigrationMetadata(source, manifest, providerFiles[0]!.relativePath);
  const assessment = assessOmpProviderMappings(raw, options);
  // Assessment has already checked all critical fields before schema defaults.
  const profiles = providerProfileSchema.array().parse(raw);
  const protectedFiles = new Set(manifest.files.filter((file) => file.kind === "protected-secret")
    .map((file) => file.relativePath));
  const credentialEvidence = profiles.map((profile) => {
    const requirements = [
      ...(profile.auth.kind === "none" ? [] : [{ role: "auth", reference: profile.auth.secretRef }]),
      ...Object.values(profile.secretHeaders).map((reference) => ({ role: "secret-header", reference })),
    ];
    return {
      providerId: profile.id,
      requirements: requirements.map(({ role, reference }) => ({
        role,
        // File naming follows DpapiSecretVault.filePath. Presence is NOT proof
        // of decryption, valid credentials, remote identity or portal ownership.
        fileStatus: protectedFiles.has(`secrets/${createHash("sha256").update(reference).digest("hex")}.json`)
          ? "present-not-decrypted" as const : "not-in-inventory" as const,
      })),
    };
  });
  await verifyMigrationSource(source, manifest);
  return {
    assessment, manifest, credentialEvidence,
    sourceUnchangedAtVerification: true as const,
    quiescentBackup: false as const,
  };
}
