import { randomUUID } from "node:crypto";
import type { PortalRepository } from "../portals/portal-repository.js";
import { PortalRepositoryCorruptionError } from "../portals/portal-repository.js";
import type { ProviderProfileRepository } from "../providers/provider-profile-repository.js";
import type {
  CredentialBinding,
  CredentialBindingAdapter,
} from "./credential-manager.js";
import { CredentialManagerError } from "./credential-manager.js";

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
    let portalRecords = [] as Awaited<ReturnType<PortalRepository["list"]>>;
    try {
      portalRecords = await this.portals.list();
    } catch (error) {
      // A corrupt portal catalog must not hide otherwise recoverable provider API bindings.
      if (!(error instanceof PortalRepositoryCorruptionError)) throw error;
    }
    for (const record of portalRecords) {
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
    // A destructive reference-check must be COMPLETE: `false` may only ever mean the VERIFIED absence of any
    // reference. Any read we cannot finish — a corrupt catalog, a directory where a file was expected (EISDIR),
    // a permission/I-O error (EACCES/EIO), an unparseable provider store — leaves usage UNKNOWN, and an unknown
    // must fail-closed to CONFLICT so a key of unknown usage can never be deleted. This deliberately does NOT
    // reuse the corruption-tolerant list() (which swallows PortalRepositoryCorruptionError to keep provider-API
    // bindings READABLE) — that seam's "false may mean maybe-referenced" is exactly the hazard we avoid here.
    // The fixed causes below carry no file path, raw error text, stack, or secret material.
    let profiles: Awaited<ReturnType<ProviderProfileRepository["list"]>>;
    try {
      profiles = await this.profiles.list();
    } catch {
      // Pin the profile read separately: an unreadable provider store means we cannot even rule usage IN, so we
      // must not fall through to the portal read and risk returning a premature `false`.
      throw new CredentialManagerError(
        "CONFLICT",
        "Использование ключа невозможно проверить, пока список провайдеров недоступен; сначала восстановите хранилище.",
      );
    }
    for (const profile of profiles) {
      // A KNOWN profile reference is a definite answer and short-circuits before any portal read.
      if (profile.auth.kind !== "none" && profile.auth.secretRef === secretRef) return true;
    }
    let portalRecords: Awaited<ReturnType<PortalRepository["list"]>>;
    try {
      portalRecords = await this.portals.list();
    } catch {
      // Minimal error projection on the destructive seam: ANY unreadable portal catalog (corruption, EISDIR,
      // EACCES, EIO, …) — not only PortalRepositoryCorruptionError — projects to one fixed safe cause. Never
      // surface the raw error: its message may embed the catalog file path or, for a dependency-seam fault,
      // injected canary/secret material.
      throw new CredentialManagerError(
        "CONFLICT",
        "Использование ключа невозможно проверить, пока каталог кабинетов недоступен; сначала восстановите каталог.",
      );
    }
    return portalRecords.some(
      (record) =>
        record.connection.auth.kind !== "none" && record.connection.auth.secretRef === secretRef,
    );
  }
}
