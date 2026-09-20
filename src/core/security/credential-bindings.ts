import { randomUUID } from "node:crypto";
import type { PortalRepository } from "../portals/portal-repository.js";
import type { ProviderProfileRepository } from "../providers/provider-profile-repository.js";
import type {
  CredentialBinding,
  CredentialBindingAdapter,
} from "./credential-manager.js";

/** Bridges the manager's purpose-aware bindings to the existing profile seams. */
export class ApplicationCredentialBindings implements CredentialBindingAdapter {
  constructor(
    private readonly profiles: ProviderProfileRepository,
    private readonly portals: PortalRepository,
  ) {}

  async list(): Promise<readonly CredentialBinding[]> {
    const bindings: CredentialBinding[] = [];
    for (const profile of await this.profiles.list()) {
      if (profile.auth.kind !== "none") {
        bindings.push({
          providerId: profile.id,
          purpose: "provider-api",
          secretRef: profile.auth.secretRef,
        });
      }
    }
    for (const record of await this.portals.list()) {
      if (record.connection.auth.kind !== "none") {
        bindings.push({
          providerId: record.connection.providerId,
          purpose: "portal-session",
          secretRef: record.connection.auth.secretRef,
        });
      }
    }
    return bindings;
  }

  async activate(binding: CredentialBinding): Promise<void> {
    if (binding.purpose === "provider-api") {
      const profile = await this.profiles.get(binding.providerId);
      if (profile === undefined) throw new Error("Provider profile was not found.");
      if (profile.auth.kind === "none") throw new Error("Provider has no configured API auth binding.");
      await this.profiles.upsert({
        ...profile,
        auth: { ...profile.auth, secretRef: binding.secretRef },
      });
      return;
    }

    const record = await this.portals.get(binding.providerId);
    if (record === undefined) throw new Error("Portal session was not found.");
    if (record.connection.auth.kind === "none") throw new Error("Portal has no configured session binding.");
    await this.portals.update(binding.providerId, (current) => {
      if (current === undefined || current.connection.auth.kind === "none") return current;
      return {
        ...current,
        revision: randomUUID(),
        connection: {
          ...current.connection,
          auth: { ...current.connection.auth, secretRef: binding.secretRef },
        },
        latest: undefined,
        lastWallet: undefined,
        failures: 0,
        nextRefreshAt: undefined,
      };
    });
  }

  async isReferenced(secretRef: string): Promise<boolean> {
    const bindings = await this.list();
    return bindings.some((binding) => binding.secretRef === secretRef);
  }
}
