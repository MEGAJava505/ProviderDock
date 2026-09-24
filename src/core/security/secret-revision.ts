import { createHash } from "node:crypto";
import type { ProviderProfile } from "../providers/provider-profile.js";
import type { SecretStore } from "./secret-store.js";

/** Opaque, non-secret binding to every referenced credential generation. */
export async function providerSecretRevisionFingerprint(
  profile: Pick<ProviderProfile, "auth" | "secretHeaders">,
  secrets: SecretStore,
): Promise<string | undefined> {
  const references = new Set<string>(Object.values(profile.secretHeaders));
  if (profile.auth.kind !== "none") references.add(profile.auth.secretRef);
  const parts: Array<readonly [string, string]> = [];
  for (const reference of [...references].sort()) {
    let revision: string | undefined;
    try { revision = await secrets.revision?.(reference); } catch { return undefined; }
    if (typeof revision !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(revision)) return undefined;
    parts.push([reference, revision]);
  }
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}
