import { describe, expect, it } from "vitest";
import {
  MemorySecretStore,
  ProviderHttpRequestBuilder,
  parseProviderProfile,
} from "../src/index.js";

describe("ProviderHttpRequestBuilder", () => {
  it("combines provider URL, query auth and secret-backed headers", async () => {
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "query", parameterName: "key", secretRef: "QUERY_KEY" },
      staticHeaders: { Originator: "providerdock" },
      secretHeaders: { "x-api-key": "HEADER_KEY" },
      queryParameters: { source: "desktop" },
    });
    const builder = new ProviderHttpRequestBuilder(
      new MemorySecretStore({ QUERY_KEY: "query-secret", HEADER_KEY: "header-secret" }),
    );

    const request = await builder.build(profile, "responses", {
      accept: "text/event-stream",
      contentType: "application/json",
    });

    expect(request.url.toString()).toBe(
      "https://example.test/v1/responses?source=desktop&key=query-secret",
    );
    expect(request.headers.get("accept")).toBe("text/event-stream");
    expect(request.headers.get("content-type")).toBe("application/json");
    expect(request.headers.get("originator")).toBe("providerdock");
    expect(request.headers.get("x-api-key")).toBe("header-secret");
  });

  it("fails before constructing a usable request when a secret is unavailable", async () => {
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "bearer", secretRef: "MISSING" },
    });

    await expect(
      new ProviderHttpRequestBuilder(new MemorySecretStore()).build(profile, "models"),
    ).rejects.toMatchObject({ type: "AUTH_ERROR" });
  });
});
