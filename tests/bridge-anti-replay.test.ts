import { describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  ResponsesBridgeServer,
  parseProviderProfile,
} from "../src/index.js";

function bridgeWith(fetchImpl: typeof fetch): ResponsesBridgeServer {
  return new ResponsesBridgeServer({
    profile: parseProviderProfile({
      id: "router",
      displayName: "Test Router",
      baseUrl: "https://upstream.test/v1",
      apiType: "openai-responses",
      timeoutMs: 1_000,
    }),
    secretStore: new MemorySecretStore(),
    fetchImpl,
    models: [{ modelId: "gpt-x" }],
  });
}

describe("bridge anti-replay guard", () => {
  it("serves a turn once and blocks its identical automatic replay", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      new Response(
        JSON.stringify({ id: "resp-1", object: "response", status: "completed", output: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const bridge = bridgeWith(fetchMock);
    const address = await bridge.start();
    try {
      const body = JSON.stringify({ model: "gpt-x", input: "hello", stream: false });
      const first = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(first.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const replay = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(replay.status).toBe(409);
      expect(replay.headers.get("x-providerdock-turn-block")).toBe("TURN_ALREADY_COMPLETED");
      // The blocked replay must never reach the upstream provider.
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // A different turn is unaffected.
      const next = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", input: "hello again", stream: false }),
      });
      expect(next.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.stop();
    }
  });

  it("allows a safe retry when the upstream connection failed before any output", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("connection refused"))
      .mockResolvedValue(
        new Response(
          JSON.stringify({ id: "resp-2", object: "response", status: "completed", output: [] }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    const bridge = bridgeWith(fetchMock);
    const address = await bridge.start();
    try {
      const body = JSON.stringify({ model: "gpt-x", input: "retry me", stream: false });
      const first = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(first.status).toBe(502);

      const retry = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      expect(retry.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.stop();
    }
  });
});
