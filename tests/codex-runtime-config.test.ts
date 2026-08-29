import { describe, expect, it } from "vitest";
import {
  CodexRuntimeConfigFactory,
  CodexRuntimeConfigurationError,
  MemorySecretStore,
  parseProviderProfile,
} from "../src/index.js";

const sessionId = "0123456789abcdef0123456789abcdef";

describe("CodexRuntimeConfigFactory", () => {
  it("keeps bearer and header secrets out of generated TOML", async () => {
    const factory = new CodexRuntimeConfigFactory(
      new MemorySecretStore({ API_KEY: "actual-api-secret", HEADER_KEY: "header-secret" }),
    );
    const profile = parseProviderProfile({
      id: "router",
      displayName: 'Router "Primary"',
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "bearer", secretRef: "API_KEY" },
      staticHeaders: { "X-Client": "ProviderDock" },
      secretHeaders: { "X-Identity": "HEADER_KEY" },
    });

    const built = await factory.build({
      profile,
      modelId: 'model-"x"',
      route: { kind: "direct" },
      sessionId,
    });

    expect(built.profileName).toBe(`providerdock-${sessionId}`);
    expect(built.contents).toContain('wire_api = "responses"');
    expect(built.contents).toContain("request_max_retries = 0");
    expect(built.contents).toContain("stream_max_retries = 0");
    expect(built.contents).toContain('model = "model-\\\"x\\\""');
    expect(built.contents).not.toContain("actual-api-secret");
    expect(built.contents).not.toContain("header-secret");
    expect(Object.values(built.environment)).toEqual(
      expect.arrayContaining(["actual-api-secret", "header-secret", "ProviderDock"]),
    );
    expect(built.contents).toMatch(/env_key = "PROVIDER_DOCK_CODEX_/);
    expect(built.contents).toContain("env_http_headers");
  });

  it("uses a bridge without exposing upstream credentials to Codex", async () => {
    const factory = new CodexRuntimeConfigFactory(new MemorySecretStore());
    const profile = parseProviderProfile({
      id: "chat-router",
      displayName: "Chat Router",
      baseUrl: "https://upstream.example/v1",
      apiType: "openai-chat-completions",
      auth: { kind: "query", parameterName: "token", secretRef: "UNAVAILABLE" },
    });

    const built = await factory.build({
      profile,
      modelId: "model-x",
      route: { kind: "bridge", baseUrl: "http://127.0.0.1:43123/v1/" },
      sessionId,
    });

    expect(built.contents).toContain('base_url = "http://127.0.0.1:43123/v1"');
    expect(built.contents).not.toContain("UNAVAILABLE");
    expect(built.environment).toEqual({});
  });

  it("requires a bridge for unsupported direct protocols and query authentication", async () => {
    const factory = new CodexRuntimeConfigFactory(new MemorySecretStore({ KEY: "secret" }));
    const chatProfile = parseProviderProfile({
      id: "chat",
      displayName: "Chat",
      baseUrl: "https://example.test/v1",
      apiType: "openai-chat-completions",
    });
    await expect(
      factory.build({ profile: chatProfile, modelId: "model", route: { kind: "direct" }, sessionId }),
    ).rejects.toBeInstanceOf(CodexRuntimeConfigurationError);

    const queryProfile = parseProviderProfile({
      id: "query",
      displayName: "Query",
      baseUrl: "https://example.test/v1",
      apiType: "openai-responses",
      auth: { kind: "query", parameterName: "token", secretRef: "KEY" },
    });
    await expect(
      factory.build({ profile: queryProfile, modelId: "model", route: { kind: "direct" }, sessionId }),
    ).rejects.toThrow(/secret query parameter/);
  });
});
