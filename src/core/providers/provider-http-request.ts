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
  /** In-memory only; pass to the central error redactor and never serialize. */
  readonly redactionValues: readonly string[];
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
    const baseUrl = new URL(base);
    const url = new URL(endpoint, baseUrl);
    if (url.origin !== baseUrl.origin) {
      throw new ProviderRequestError(
        "INVALID_REQUEST",
        "Provider endpoint must remain on the configured base URL origin.",
      );
    }
    const headers = new Headers({
      Accept: options.accept ?? "application/json",
      ...profile.staticHeaders,
    });
    const redactionValues: string[] = [];
    const requireSensitiveValue = async (reference: string): Promise<string> => {
      const value = await this.requireSecret(reference);
      if (!redactionValues.includes(value)) redactionValues.push(value);
      return value;
    };

    if (options.contentType !== undefined) {
      headers.set("Content-Type", options.contentType);
    }

    for (const [name, value] of Object.entries(profile.queryParameters)) {
      url.searchParams.set(name, value);
    }

    if (profile.auth.kind === "bearer") {
      headers.set(
        "Authorization",
        `Bearer ${await requireSensitiveValue(profile.auth.secretRef)}`,
      );
    } else if (profile.auth.kind === "header") {
      headers.set(profile.auth.headerName, await requireSensitiveValue(profile.auth.secretRef));
    } else if (profile.auth.kind === "query") {
      url.searchParams.set(
        profile.auth.parameterName,
        await requireSensitiveValue(profile.auth.secretRef),
      );
    }

    for (const [headerName, secretRef] of Object.entries(profile.secretHeaders)) {
      headers.set(headerName, await requireSensitiveValue(secretRef));
    }

    return { url, headers, redactionValues };
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
