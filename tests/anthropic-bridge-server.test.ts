import { describe, expect, it, vi } from "vitest";
import {
  AnthropicBridgeServer,
  MemorySecretStore,
  parseProviderProfile,
  type ProviderProfile,
} from "../src/index.js";

describe("AnthropicBridgeServer", () => {
  it("relays native Anthropic requests verbatim with injected auth and headers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        id: "msg_upstream",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const bridge = new AnthropicBridgeServer({
      profile: anthropicProfile(),
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "real-secret" }),
      fetchImpl: fetchMock,
      clientToken: "fake-child-token",
    });

    const address = await bridge.start();
    try {
      const health = await (await fetch(`${address.url}/health`)).json();
      expect(health).toMatchObject({ status: "ok", mode: "native-anthropic" });

      const unauthorized = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(unauthorized.status).toBe(401);
      expect(fetchMock).not.toHaveBeenCalled();

      const response = await fetch(`${address.url}/v1/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "tools-2024",
          authorization: "Bearer fake-child-token",
        },
        body: JSON.stringify({
          model: "claude-x",
          max_tokens: 16,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ type: "message", id: "msg_upstream" });

      const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(url)).toBe("https://anthropic.test/v1/messages");
      const headers = new Headers(init.headers);
      expect(headers.get("x-api-key")).toBe("real-secret");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.get("anthropic-beta")).toBe("tools-2024");
      // The child's loopback token must never leak upstream.
      expect(headers.get("authorization")).toBeNull();
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      expect(body).toMatchObject({ model: "claude-x", max_tokens: 16 });
    } finally {
      await bridge.stop();
    }
  });

  it("synthesizes Anthropic SSE when a native provider ignores stream=true", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "msg_json_stream",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "Fallback stream" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 2 },
      }),
    );
    const bridge = new AnthropicBridgeServer({
      profile: anthropicProfile(),
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "real-secret" }),
      fetchImpl: fetchMock,
    });
    const address = await bridge.start();
    try {
      const response = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const source = await response.text();
      expect(source).toContain("event: message_start");
      expect(source).toContain('"text":"Fallback stream"');
      expect(source).toContain("event: message_stop");
    } finally {
      await bridge.stop();
    }
  });

  it("records native streamed tool_use before delivery and blocks resolved replay", async () => {
    const toolUse = {
      type: "tool_use",
      id: "toolu-side-effect",
      name: "write_file",
      input: { path: "a.txt" },
    };
    let requestNumber = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => {
      requestNumber += 1;
      if (requestNumber === 1) {
        return sseResponse(
          [
            anthropicEvent("message_start", {
              type: "message_start",
              message: {
                id: "msg-tool",
                type: "message",
                role: "assistant",
                model: "claude-x",
                content: [],
                stop_reason: null,
                usage: { input_tokens: 1, output_tokens: 0 },
              },
            }),
            anthropicEvent("content_block_start", {
              type: "content_block_start",
              index: 0,
              content_block: { ...toolUse, input: {} },
            }),
            anthropicEvent("content_block_delta", {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
            }),
            anthropicEvent("content_block_stop", {
              type: "content_block_stop",
              index: 0,
            }),
            anthropicEvent("message_delta", {
              type: "message_delta",
              delta: { stop_reason: "tool_use", stop_sequence: null },
              usage: { output_tokens: 1 },
            }),
            anthropicEvent("message_stop", { type: "message_stop" }),
          ].join(""),
        );
      }
      return jsonResponse({
        id: `msg-${requestNumber}`,
        type: "message",
        role: "assistant",
        model: "claude-x",
        content:
          requestNumber === 2 ? [{ type: "text", text: "done" }] : [toolUse],
        stop_reason: requestNumber === 2 ? "end_turn" : "tool_use",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    });
    const bridge = new AnthropicBridgeServer({
      profile: anthropicProfile(),
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "real-secret" }),
      fetchImpl: fetchMock,
    });
    const address = await bridge.start();
    try {
      const first = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        stream: true,
        messages: [{ role: "user", content: "write once" }],
      });
      expect(await first.text()).toContain("event: message_stop");

      const continuation = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        messages: [
          { role: "user", content: "write once" },
          { role: "assistant", content: [toolUse] },
          {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: toolUse.id, content: "written" },
            ],
          },
        ],
      });
      expect(continuation.status).toBe(200);

      const replay = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "different turn" }],
      });
      expect(replay.status).toBe(409);
      expect(replay.headers.get("x-providerdock-turn-block")).toBe("TOOL_LOOP_DETECTED");
      expect(fetchMock).toHaveBeenCalledTimes(3);
    } finally {
      await bridge.stop();
    }
  });

  it("translates Messages requests for OpenAI chat providers, including SSE", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body.model).toBe("gpt-x");
      expect(Array.isArray(body.messages)).toBe(true);
      return sseResponse(
        [
          `data: ${JSON.stringify({ id: "c1", model: "gpt-x", choices: [{ delta: { content: "Hello" } }] })}`,
          "",
          `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2, completion_tokens: 1 } })}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"),
      );
    });
    const bridge = new AnthropicBridgeServer({
      profile: chatProfile(),
      secretStore: new MemorySecretStore({ CHAT_KEY: "chat-secret" }),
      fetchImpl: fetchMock,
    });

    const address = await bridge.start();
    try {
      const response = await fetch(`${address.url}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-x",
          max_tokens: 16,
          stream: true,
          messages: [{ role: "user", content: "Hi" }],
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const [url] = fetchMock.mock.calls[0] as [URL, RequestInit];
      expect(String(url)).toBe("https://chat.test/v1/chat/completions");

      const text = await response.text();
      const eventNames = [...text.matchAll(/^event: (.+)$/gm)].map((match) => match[1]);
      expect(eventNames).toEqual([
        "message_start",
        "content_block_start",
        "content_block_delta",
        "content_block_stop",
        "message_delta",
        "message_stop",
      ]);
      expect(text).toContain('"text":"Hello"');
      expect(text).toContain('"stop_reason":"end_turn"');
      expect(text).toContain('"input_tokens":2');
    } finally {
      await bridge.stop();
    }
  });

  it("blocks replayed completed turns with 409 and a block header", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      jsonResponse({
        id: "msg_1",
        type: "message",
        role: "assistant",
        model: "claude-x",
        content: [{ type: "text", text: "done" }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
    const bridge = new AnthropicBridgeServer({
      profile: anthropicProfile(),
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "real-secret" }),
      fetchImpl: fetchMock,
    });

    const address = await bridge.start();
    try {
      const request = {
        model: "claude-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "Same turn" }],
      };
      const first = await postJson(`${address.url}/v1/messages`, request);
      expect(first.status).toBe(200);

      const replay = await postJson(`${address.url}/v1/messages`, request);
      expect(replay.status).toBe(409);
      expect(replay.headers.get("x-providerdock-turn-block")).toBe("TURN_ALREADY_COMPLETED");
      const payload = (await replay.json()) as { type: string; error: { type: string } };
      expect(payload.type).toBe("error");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("fails an unterminated translated stream and blocks its unsafe replay", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse(
        [
          `data: ${JSON.stringify({ choices: [{ delta: { content: "partial" } }] })}`,
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"),
      ),
    );
    const bridge = new AnthropicBridgeServer({
      profile: chatProfile(),
      secretStore: new MemorySecretStore({ CHAT_KEY: "chat-secret" }),
      fetchImpl: fetchMock,
    });
    const address = await bridge.start();
    const request = {
      model: "gpt-x",
      max_tokens: 16,
      stream: true,
      messages: [{ role: "user", content: "unterminated" }],
    };
    try {
      const first = await postJson(`${address.url}/v1/messages`, request);
      const source = await first.text();
      expect(source).toContain("event: error");
      expect(source).not.toContain("event: message_stop");

      const replay = await postJson(`${address.url}/v1/messages`, request);
      expect(replay.status).toBe(409);
      expect(replay.headers.get("x-providerdock-turn-block")).toBe("UNSAFE_REPLAY");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("rejects malformed Chat tool arguments before returning them to Claude", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "chat_bad_tool",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-bad",
                  type: "function",
                  function: { name: "lookup", arguments: "not-json" },
                },
              ],
            },
          },
        ],
      }),
    );
    const bridge = new AnthropicBridgeServer({
      profile: chatProfile(),
      secretStore: new MemorySecretStore({ CHAT_KEY: "chat-secret" }),
      fetchImpl: fetchMock,
    });
    const address = await bridge.start();
    try {
      const response = await postJson(`${address.url}/v1/messages`, {
        model: "gpt-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "Use lookup" }],
        tools: [{ name: "lookup", input_schema: { type: "object" } }],
      });
      expect(response.status).toBe(502);
      const payload = (await response.json()) as { providerdock: { normalized_type: string } };
      expect(payload.providerdock.normalized_type).toBe("PROTOCOL_ERROR");
    } finally {
      await bridge.stop();
    }
  });

  it("returns Anthropic-shaped errors for upstream failures", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(
      async () =>
        new Response(JSON.stringify({ error: { message: "nope" } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
    );
    const bridge = new AnthropicBridgeServer({
      profile: anthropicProfile(),
      secretStore: new MemorySecretStore({ ANTHROPIC_KEY: "real-secret" }),
      fetchImpl: fetchMock,
    });

    const address = await bridge.start();
    try {
      const response = await postJson(`${address.url}/v1/messages`, {
        model: "claude-x",
        max_tokens: 16,
        messages: [{ role: "user", content: "Hi" }],
      });
      expect(response.status).toBe(401);
      const payload = (await response.json()) as { type: string; error: { type: string } };
      expect(payload.type).toBe("error");
      expect(payload.error.type).toBe("authentication_error");
    } finally {
      await bridge.stop();
    }
  });
});

function anthropicProfile(): ProviderProfile {
  return parseProviderProfile({
    id: "anthropic",
    displayName: "Anthropic Test",
    baseUrl: "https://anthropic.test/v1",
    apiType: "anthropic-messages",
    auth: { kind: "header", headerName: "x-api-key", secretRef: "ANTHROPIC_KEY" },
    timeoutMs: 1_000,
  });
}

function chatProfile(): ProviderProfile {
  return parseProviderProfile({
    id: "chat",
    displayName: "Chat Test",
    baseUrl: "https://chat.test/v1",
    apiType: "openai-chat-completions",
    auth: { kind: "bearer", secretRef: "CHAT_KEY" },
    timeoutMs: 1_000,
  });
}

function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function anthropicEvent(event: string, data: Record<string, unknown>): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
