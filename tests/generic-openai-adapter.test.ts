import { describe, expect, it, vi } from "vitest";
import {
  GenericOpenAiAdapter,
  MemorySecretStore,
  parseProviderProfile,
} from "../src/index.js";

describe("GenericOpenAiAdapter", () => {
  it("discovers and deduplicates models with secret-backed authentication", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-x", display_name: "GPT X" },
            { id: "gpt-x", display_name: "GPT X duplicate" },
            { id: "gpt-y" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore({ ROUTER_KEY: "secret-value" }),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
      staticHeaders: { "X-Client": "ProviderDock" },
      queryParameters: { source: "desktop" },
    });

    const models = await adapter.discoverModels(profile);

    expect(models.map((model) => model.modelId)).toEqual(["gpt-x", "gpt-y"]);
    expect(models[0]?.displayName).toBe("GPT X duplicate");
    const [requestUrl, requestInit] = fetchMock.mock.calls[0] ?? [];
    expect(String(requestUrl)).toBe("https://example.test/v1/models?source=desktop");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-value");
    expect(headers.get("x-client")).toBe("ProviderDock");
  });

  it("fails before the request when a referenced secret is unavailable", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: fetchMock,
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
      auth: { kind: "header", headerName: "x-api-key", secretRef: "MISSING_KEY" },
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "AUTH_ERROR",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("normalizes malformed success payloads as protocol errors", async () => {
    const adapter = new GenericOpenAiAdapter({
      secretStore: new MemorySecretStore(),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        new Response(JSON.stringify({ unexpected: true }), { status: 200 }),
      ),
    });
    const profile = parseProviderProfile({
      id: "router",
      displayName: "Router",
      baseUrl: "https://example.test/v1",
    });

    await expect(adapter.discoverModels(profile)).rejects.toMatchObject({
      type: "PROTOCOL_ERROR",
    });
  });
});
