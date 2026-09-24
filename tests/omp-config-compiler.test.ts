import { describe, expect, it } from "vitest";
import { parseProviderProfile } from "../src/core/providers/provider-profile.js";
import {
  compileOmpConfig,
  type OmpSelectedRoute,
} from "../src/clients/omp/omp-config-compiler.js";

function route(overrides: Partial<OmpSelectedRoute> = {}): OmpSelectedRoute {
  return {
    profile: parseProviderProfile({
      id: "gateway", displayName: "Gateway", baseUrl: "https://gateway.invalid/v1",
      apiType: "openai-chat-completions", auth: { kind: "bearer", secretRef: "gateway.key" },
    }),
    accountId: "account-one",
    allowedOrigins: ["https://gateway.invalid"],
    models: [{ id: "same-model" }],
    ...overrides,
  };
}

/**
 * Pinned generic-provider request-URL fixture, no request is sent:
 * openai-completions.ts:1423-1437 supplies Azure options unconditionally;
 * openai-shared.ts:301-307 tests a substring, NOT the parsed hostname.
 * The final Chat join is openai-completions.ts:668-669.
 */
function pinnedChatRequestUrl(configuredBase: string, modelId: string): string {
  let baseUrl = configuredBase;
  let query: Record<string, string> | undefined;
  if (baseUrl.includes(".openai.azure.com")) {
    if (!baseUrl.includes("/deployments/")) baseUrl = `${baseUrl}/deployments/${modelId}`;
    query = { "api-version": "2024-10-21" };
  }
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  return query ? `${endpoint}?${new URLSearchParams(query)}` : endpoint;
}

describe("OMP selected-route compiler", () => {
  it.each([
    ["openai-chat-completions", "openai-completions"],
    ["openai-responses", "openai-responses"],
    ["anthropic-messages", "anthropic-messages"],
  ] as const)("maps %s without guessing from model names", (apiType, api) => {
    // A missing mapping or a model-name heuristic breaks this contract.
    const result = compileOmpConfig({
      routes: [{
        profile: parseProviderProfile({
          id: "gateway",
          displayName: "Not a routing hint",
          baseUrl: "https://gateway.invalid/v1",
          apiType,
          auth: { kind: "bearer", secretRef: "gateway.key" },
        }),
        accountId: "account-one",
        allowedOrigins: ["https://gateway.invalid"],
        models: [{ id: "vendor/claude-gpt:exact", reasoning: false, supportsTools: true }],
      }],
    });
    const providerId = result.providerIds[0]!.ompProviderId;
    const envName = result.requiredSecrets[0]!.envName;
    expect(result.modelsConfig).toEqual({
      providers: {
        [providerId]: {
          baseUrl: "https://gateway.invalid/v1",
          api,
          auth: "apiKey",
          apiKey: envName,
          authHeader: true,
          models: [{ id: "vendor/claude-gpt:exact", reasoning: false, supportsTools: true }],
        },
      },
    });
    expect(JSON.parse(result.modelsYaml)).toEqual(result.modelsConfig);
    expect(result.requiredSecrets).toEqual([{ secretRef: "gateway.key", envName }]);
    expect(envName).toMatch(/^PROVIDERDOCK_OMP_[A-F0-9]{64}$/);
    expect(result.selections).toEqual([{
      providerId: "gateway", accountId: "account-one", ompProviderId: providerId,
      modelId: "vendor/claude-gpt:exact", api, selector: `${providerId}/vendor/claude-gpt:exact`,
    }]);
  });

  it("requires a unique origin/account/model-bound mapping for auto, never model-name hints", () => {
    const selected = route();
    const auto = route({ profile: { ...selected.profile, apiType: "auto", adapterId: "generic-openai" } });
    const mapping = {
      providerId: "gateway", accountId: "account-one", modelId: "same-model",
      origin: "https://gateway.invalid", apiType: "openai-responses",
    } as const;
    for (const protocolMappings of [
      [],
      [{ ...mapping, modelId: "other-model" }],
      [{ ...mapping, accountId: "other-account" }],
      [{ ...mapping, providerId: "other-gateway" }],
      [{ ...mapping, origin: "https://other.invalid" }],
      [mapping, { ...mapping, apiType: "anthropic-messages" as const }],
    ]) {
      expect(() => compileOmpConfig({ routes: [auto], protocolMappings }))
        .toThrowError(expect.objectContaining({ code: "PROTOCOL_UNRESOLVED" }));
    }
    const result = compileOmpConfig({ routes: [auto], protocolMappings: [mapping, mapping] });
    expect(result.selections[0]!.api).toBe("openai-responses");
  });

  it("preserves model-specific confirmed protocols in a mixed auto route", () => {
    const selected = route();
    const result = compileOmpConfig({
      routes: [route({
        profile: { ...selected.profile, apiType: "auto" },
        models: [{ id: "same-model" }, { id: "other-model" }],
      })],
      protocolMappings: [
        { providerId: "gateway", accountId: "account-one", modelId: "same-model",
          origin: "https://gateway.invalid", apiType: "openai-responses" },
        { providerId: "gateway", accountId: "account-one", modelId: "other-model",
          origin: "https://gateway.invalid", apiType: "openai-chat-completions" },
      ],
    });
    const config = Object.values(result.modelsConfig.providers)[0]!;
    expect(config.api).toBeUndefined();
    expect(config.models).toEqual([
      { id: "same-model", api: "openai-responses" },
      { id: "other-model", api: "openai-completions" },
    ]);
  });

  it("fails closed for disabled or ambiguous selections and unsupported model metadata", () => {
    const selected = route();
    const cases: [OmpSelectedRoute[], string][] = [
      [[], "INVALID_SELECTION"],
      [[route({ accountId: "../escape" })], "INVALID_SELECTION"],
      [[route({ accountId: ".." })], "INVALID_SELECTION"],
      [[route({ models: [] })], "INVALID_SELECTION"],
      [[route({ profile: { ...selected.profile, enabled: false } })], "PROVIDER_DISABLED"],
      [[route({ profile: { ...selected.profile, disabledModelIds: ["same-model"] } })], "MODEL_DISABLED"],
      [[route({ models: [{ id: "same-model" }, { id: "same-model" }] })], "INVALID_SELECTION"],
      [[selected, selected], "INVALID_SELECTION"],
      [[route({ models: [{ id: "*", reasoning: false }] })], "UNSUPPORTED_MODEL_SELECTOR"],
      [[route({ models: [{ id: "same-model", contextWindow: 0 }] })], "INVALID_MODEL"],
      [[route({ models: [{ id: "same-model", supportsTools: "yes" } as never] })], "INVALID_MODEL"],
      [[route({ models: [{ id: "same-model", headers: { Authorization: "plaintext-marker" } } as never] })],
        "INVALID_MODEL"],
    ];
    for (const [routes, code] of cases) {
      expect(() => compileOmpConfig({ routes })).toThrowError(expect.objectContaining({ code }));
    }
  });

  it("copies only selected model capabilities without inferring or adding catalog models", () => {
    const selected = route();
    const model = {
      id: "vendor/exact-model", name: 'Model "literal"', reasoning: true, supportsTools: false,
      contextWindow: 128000, maxTokens: 4096, input: ["text", "image"] as const,
    };
    const result = compileOmpConfig({ routes: [route({
      profile: { ...selected.profile, manualModelIds: ["unselected-model"] }, models: [model],
    })] });
    expect(Object.values(result.modelsConfig.providers)[0]!.models).toEqual([model]);
    expect(result.modelsYaml).not.toContain("unselected-model");
  });

  it.each([
    "https://gateway.invalid/v1/chat/completions",
    "https://gateway.invalid/v1/responses",
    "https://gateway.invalid/v1/messages",
    "https://gateway.invalid/v1/v1",
    "https://gateway.invalid/v1/%2e%2e/messages",
    "https://user:plaintext-marker@gateway.invalid/v1",
    "https://gateway.invalid/v1?api_key=plaintext-marker",
    "https://gateway.invalid/v1#plaintext-marker",
    "https://gateway.invalid\\evil/v1",
    "http://gateway.invalid/v1",
    "!command plaintext-marker",
  ])("rejects unsafe base URL without putting input in diagnostics: %s", (baseUrl) => {
    const selected = route();
    expect(() => compileOmpConfig({ routes: [route({ profile: { ...selected.profile, baseUrl } })] }))
      .toThrowError(expect.objectContaining({ code: "INVALID_URL" }));
    try {
      compileOmpConfig({ routes: [route({ profile: { ...selected.profile, baseUrl } })] });
    } catch (error) {
      expect(String(error)).not.toContain("plaintext-marker");
      expect(JSON.stringify(error)).not.toContain("plaintext-marker");
    }
  });

  it("requires exact approved origins including scheme and port; allows explicitly approved loopback", () => {
    for (const allowedOrigins of [
      [], ["https://gateway.invalid.evil"], ["https://gateway.invalid:444"],
      ["http://gateway.invalid"], ["https://gateway.invalid/v1"],
    ]) {
      expect(() => compileOmpConfig({ routes: [route({ allowedOrigins })] }))
        .toThrowError(expect.objectContaining({ code: "ORIGIN_NOT_ALLOWED" }));
    }
    const selected = route();
    const local = compileOmpConfig({ routes: [route({
      profile: { ...selected.profile, baseUrl: "http://127.0.0.1:12345/v1/" },
      allowedOrigins: ["http://127.0.0.1:12345"],
    })] });
    expect(Object.values(local.modelsConfig.providers)[0]!.baseUrl).toBe("http://127.0.0.1:12345/v1");
  });

  it.each(["openai-chat-completions", "openai-responses"] as const)(
    "rejects raw %s header auth until OMP provides a literal-safe header transport", (apiType) => {
      const selected = route();
      expect(() => compileOmpConfig({ routes: [route({
        profile: { ...selected.profile, apiType,
          auth: { kind: "header", headerName: "X-Api-Key", secretRef: "header.key" } },
      })] })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_AUTH" }));
    },
  );

  it("uses native X-Api-Key without bearer for the exact official Anthropic origin", () => {
    const selected = route();
    const result = compileOmpConfig({ routes: [route({
      profile: { ...selected.profile, baseUrl: "https://api.anthropic.com/v1", apiType: "anthropic-messages",
        auth: { kind: "header", headerName: "x-api-key", secretRef: "anthropic.key" } },
      allowedOrigins: ["https://api.anthropic.com"],
    })] });
    expect(Object.values(result.modelsConfig.providers)[0]).toMatchObject({
      baseUrl: "https://api.anthropic.com/v1", auth: "apiKey", authHeader: false,
      apiKey: result.requiredSecrets[0]!.envName,
    });
  });

  it("rejects raw Authorization rather than exposing it to the second resolver pass", () => {
    const selected = route();
    expect(() => compileOmpConfig({ routes: [route({
      profile: { ...selected.profile, apiType: "anthropic-messages",
        auth: { kind: "header", headerName: "authorization", secretRef: "raw.auth" } },
    })] })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_AUTH" }));
  });

  it("rejects auth the pinned Messages implementation would change or augment", () => {
    const selected = route();
    for (const [baseUrl, auth] of [
      ["https://gateway.invalid/v1", { kind: "header", headerName: "X-Api-Key", secretRef: "api.key" }],
      ["https://api.anthropic.com.evil/v1", { kind: "header", headerName: "x-api-key", secretRef: "api.key" }],
      ["https://api.anthropic.com/v1", { kind: "bearer", secretRef: "api.key" }],
      ["https://api.anthropic.com/v1", { kind: "header", headerName: "Authorization", secretRef: "api.key" }],
      ["https://gateway.invalid/v1", { kind: "none" }],
    ] as const) {
      expect(() => compileOmpConfig({ routes: [route({
        profile: { ...selected.profile, apiType: "anthropic-messages", baseUrl, auth },
        allowedOrigins: [new URL(baseUrl).origin],
      })] })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_AUTH" }));
    }
  });

  it("rejects unsupported static/secret headers and queries instead of dropping or persisting them", () => {
    const selected = route();
    const patches = [
      { staticHeaders: { "User-Agent": "ProviderDock/1.0" } },
      { staticHeaders: { "X-Custom": "!command plaintext-marker" } },
      { staticHeaders: { "X-Custom": "PATH" } },
      { staticHeaders: { Authorization: "Bearer plaintext-marker" } },
      { secretHeaders: { "X-Other": "other.key" } },
      { queryParameters: { version: "1" } },
      { auth: { kind: "query", parameterName: "key", secretRef: "api.key" } },
      { auth: { kind: "header", headerName: "Host", secretRef: "api.key" } },
      { auth: { kind: "header", headerName: "x-key\r\nHost: evil", secretRef: "api.key" } },
      { auth: { kind: "bearer", secretRef: "!command plaintext-marker" } },
      { apiKey: "plaintext-marker" },
    ];
    for (const patch of patches) {
      let failure: unknown;
      try {
        compileOmpConfig({ routes: [route({ profile: { ...selected.profile, ...patch } as never })] });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).not.toContain("plaintext-marker");
      expect(JSON.stringify(failure)).not.toContain("plaintext-marker");
    }
  });

  it.each(["X-Gateway-Key", "X-Custom-Token", "X-Request-ID"])(
    "rejects %s because pinned OMP would persist it unredacted in HTTP 400/413 dumps", (headerName) => {
      const selected = route();
      expect(() => compileOmpConfig({ routes: [route({
        profile: { ...selected.profile, auth: { kind: "header", headerName, secretRef: "secret.ref" } },
      })] })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_AUTH" }));
    },
  );

  it("keeps duplicate model IDs on separate gateways/accounts and emits canonical config regardless of route order", () => {
    const first = route();
    const second = route({ profile: {
      ...first.profile, id: "gate_way", displayName: first.profile.displayName,
      baseUrl: "https://second.invalid/v1",
    }, allowedOrigins: ["https://second.invalid"] });
    const third = route({ ...second, profile: { ...second.profile, id: "gate-way" } });
    const fourth = route({ accountId: "account.two" });
    const fifth = route({ accountId: "account-two" });
    const selected = [first, second, third, fourth, fifth];
    const output = compileOmpConfig({ routes: selected });
    const reversed = compileOmpConfig({ routes: [...selected].reverse() });
    expect(new Set(output.providerIds.map((identity) => identity.ompProviderId)).size).toBe(5);
    expect(new Set(output.requiredSecrets.map((secret) => secret.envName)).size).toBe(5);
    expect(new Set(output.selections.map((selection) => selection.selector)).size).toBe(5);
    expect(output.selections.map((selection) => selection.modelId)).toEqual(Array(5).fill("same-model"));
    expect(Object.keys(output.modelsConfig.providers)).toHaveLength(5);
    expect(output.modelsYaml).toBe(reversed.modelsYaml);
    const renamed = compileOmpConfig({ routes: [route({
      profile: { ...first.profile, displayName: "Completely different name" },
    })] });
    expect(renamed.providerIds[0]).toEqual(output.providerIds[0]);
  });

  it("rejects case-colliding model selectors instead of letting OMP deduplicate them", () => {
    expect(() => compileOmpConfig({ routes: [route({ models: [{ id: "Model" }, { id: "model" }] })] }))
      .toThrowError(expect.objectContaining({ code: "INVALID_SELECTION" }));
    const selected = route();
    expect(() => compileOmpConfig({ routes: [route({
      profile: { ...selected.profile, disabledModelIds: ["SAME-MODEL"] },
    })] })).toThrowError(expect.objectContaining({ code: "MODEL_DISABLED" }));
  });

  it.each(["供应商/模型-🚀:high", "модель с пробелами", "vendor/model@default:max", "!literal$\";'&|()", "--literal"])(
    "preserves literal model ID %s through JSON and an exact selector", (id) => {
      const result = compileOmpConfig({ routes: [route({ models: [{ id }] })] });
      expect(Object.values(JSON.parse(result.modelsYaml).providers)[0]).toMatchObject({ models: [{ id }] });
      expect(result.selections[0]!.modelId).toBe(id);
      expect(result.selections[0]!.selector).toBe(`${result.providerIds[0]!.ompProviderId}/${id}`);
    },
  );

  it.each(["model*", "model?", "model[one]", "model,other", " model", "model "])(
    "classifies nonliteral model-scope syntax as unsupported instead of rewriting %s", (id) => {
      expect(() => compileOmpConfig({ routes: [route({ models: [{ id }] })] }))
        .toThrowError(expect.objectContaining({ code: "UNSUPPORTED_MODEL_SELECTOR" }));
    },
  );

  it.each([
    "https://fixture.openai.azure.com/openai/v1",
    "https://fixture.OPENAI.AZURE.COM/openai/v1",
    "https://fixture.openai.azure.com/openai/deployments/already-selected",
    "https://fixture.openai.azure.com.evil.invalid/openai/v1",
    "https://gateway.invalid/proxy/.openai.azure.com/v1",
  ])("rejects the pinned implicit Azure rewrite rather than sending an unselected URL: %s", (baseUrl) => {
    const selected = route();
    let outcome: unknown;
    try {
      const result = compileOmpConfig({ routes: [route({
        profile: { ...selected.profile, baseUrl }, allowedOrigins: [new URL(baseUrl).origin],
      })] });
      const config = Object.values(result.modelsConfig.providers)[0]!;
      outcome = { requestUrl: pinnedChatRequestUrl(config.baseUrl, config.models[0]!.id) };
    } catch (error) {
      expect(error).toMatchObject({ code: "UNSUPPORTED_ENDPOINT" });
      expect(String(error)).not.toContain(baseUrl);
      outcome = { rejected: "UNSUPPORTED_ENDPOINT" };
    }
    expect(outcome).toEqual({ rejected: "UNSUPPORTED_ENDPOINT" });
  });

  it("preserves the exact ordinary Chat endpoint at pinned consumption", () => {
    const result = compileOmpConfig({ routes: [route()] });
    const config = Object.values(result.modelsConfig.providers)[0]!;
    const url = pinnedChatRequestUrl(config.baseUrl, config.models[0]!.id);
    expect(url).toBe("https://gateway.invalid/v1/chat/completions");
    expect(new URL(url).search).toBe("");
  });

  it("applies the Azure restriction to confirmed auto Chat, not the unrelated Responses wire", () => {
    const selected = route();
    const baseUrl = "https://fixture.openai.azure.com/openai/v1";
    const auto = route({
      profile: { ...selected.profile, apiType: "auto", baseUrl },
      allowedOrigins: ["https://fixture.openai.azure.com"],
    });
    const mapping = {
      providerId: selected.profile.id, accountId: selected.accountId, modelId: "same-model",
      origin: "https://fixture.openai.azure.com",
    };
    expect(() => compileOmpConfig({
      routes: [auto], protocolMappings: [{ ...mapping, apiType: "openai-chat-completions" }],
    })).toThrowError(expect.objectContaining({ code: "UNSUPPORTED_ENDPOINT" }));
    const responses = compileOmpConfig({
      routes: [auto], protocolMappings: [{ ...mapping, apiType: "openai-responses" }],
    });
    expect(Object.values(responses.modelsConfig.providers)[0]).toMatchObject({
      api: "openai-responses", baseUrl,
    });
  });
});
