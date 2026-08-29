import { ProviderRequestError } from "../errors/provider-error.js";
import type { SecretStore } from "../security/secret-store.js";
import type { ProviderProfile } from "./provider-profile.js";

export interface BuildProviderRequestOptions {
  readonly accept?: string;
  readonly contentType?: string;
}

export interface BuiltProviderRequest {
  readonly url: URL;
  readonly headers: Headers;
}

/** Builds an upstream request without persisting secret values in provider profiles. */
export class ProviderHttpRequestBuilder {
  constructor(private readonly secrets: SecretStore) {}

  async build(
    profile: ProviderProfile,
    endpoint: string,
    options: BuildProviderRequestOptions = {},
  ): Promise<BuiltProviderRequest> {
    const base = profile.baseUrl.endsWith("/") ? profile.baseUrl : `${profile.baseUrl}/`;
    const url = new URL(endpoint, base);
    const headers = new Headers({
      Accept: options.accept ?? "application/json",
      ...profile.staticHeaders,
    });

    if (options.contentType !== undefined) {
      headers.set("Content-Type", options.contentType);
    }

    for (const [name, value] of Object.entries(profile.queryParameters)) {
      url.searchParams.set(name, value);
    }

    if (profile.auth.kind === "bearer") {
      headers.set(
        "Authorization",
        `Bearer ${await this.requireSecret(profile.auth.secretRef)}`,
      );
    } else if (profile.auth.kind === "header") {
      headers.set(profile.auth.headerName, await this.requireSecret(profile.auth.secretRef));
    } else if (profile.auth.kind === "query") {
      url.searchParams.set(
        profile.auth.parameterName,
        await this.requireSecret(profile.auth.secretRef),
      );
    }

    for (const [headerName, secretRef] of Object.entries(profile.secretHeaders)) {
      headers.set(headerName, await this.requireSecret(secretRef));
    }

    return { url, headers };
  }

  private async requireSecret(reference: string): Promise<string> {
    const secret = await this.secrets.get(reference);
    if (!secret) {
      throw new ProviderRequestError(
        "AUTH_ERROR",
        `Required secret reference '${reference}' is not available.`,
      );
    }
    return secret;
  }
}
