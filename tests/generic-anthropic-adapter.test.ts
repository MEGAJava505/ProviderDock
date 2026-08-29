import { describe, expect, it, vi } from "vitest";
import {
  GenericAnthropicAdapter,
  MemorySecretStore,
  parseProviderProfile,
} from "../src/index.js";

describe("GenericAnthropicAdapter", () => {
  it("discovers Anthropic models with required version and secret auth headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-x", display_name: "Claude X" },
            { id: "claude-x", display_name: "Claude X current" },
            { id: "claude-y" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new GenericAnthropicAdapter({
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "secret" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "anthropic",
      displayName: "Anthropic Gateway",
      baseUrl: "https://anthropic.test/v1",
      apiType: "anthropic-messages",
      adapterId: "generic-anthropic",
      auth: { kind: "header", headerName: "x-api-key", secretRef: "ANTHROPIC_KEY" },
    });

    expect(adapter.supports(profile)).toBe(true);
    const models = await adapter.discoverModels(profile);
    expect(models.map((model) => model.modelId)).toEqual(["claude-x", "claude-y"]);
    expect(models[0]?.displayName).toBe("Claude X current");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://anthropic.test/v1/models");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("secret");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("normalizes unsupported model schemas as protocol errors", async () => {
    const adapter = new GenericAnthropicAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ models: [{ name: "missing-id" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    });
    const profile = parseProviderProfile({
      id: "anthropic",
      displayName: "Anthropic Gateway",
      baseUrl: "https://anthropic.test/v1",
      apiType: "anthropic-messages",
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "PROTOCOL_ERROR",
    });
  });
});
