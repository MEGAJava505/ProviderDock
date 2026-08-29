import { describe, expect, it, vi } from "vitest";
import {
  MemorySecretStore,
  ResponsesBridgeServer,
  SseDecoder,
  encodeSseEvent,
  parseProviderProfile,
} from "../src/index.js";

const encoder = new TextEncoder();

describe("Chat Completions bridge", () => {
  it("translates non-streaming Responses requests and Chat answers", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      chatJsonResponse({
        id: "chat-answer",
        model: "chat-model",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Translated answer" },
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 },
      }),
    );
    const bridge = chatBridge(fetchMock, new MemorySecretStore({ CHAT_KEY: "chat-secret" }));
    const address = await bridge.start();

    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "chat-model",
          instructions: "Be concise.",
          input: "Hello",
          max_output_tokens: 128,
          stream: false,
        }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-providerdock-bridge")).toBe("chat-completions");
      expect(await response.json()).toMatchObject({
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "Translated answer" }],
          },
        ],
        usage: { input_tokens: 8, output_tokens: 2, total_tokens: 10 },
      });

      const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0] ?? [];
      expect(String(upstreamUrl)).toBe("https://chat.test/v1/chat/completions");
      expect(new Headers(upstreamInit?.headers).get("authorization")).toBe(
        "Bearer chat-secret",
      );
      expect(JSON.parse(String(upstreamInit?.body))).toMatchObject({
        model: "chat-model",
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: "Hello" },
        ],
        max_completion_tokens: 128,
        stream: false,
      });
    } finally {
      await bridge.stop();
    }
  });

  it("relays Chat SSE as event-by-event Responses SSE and holds DONE until completion", async () => {
    const source = [
      chatSse({
        id: "chat-stream",
        model: "chat-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "Hel" } }],
      }),
      chatSse({
        id: "chat-stream",
        model: "chat-model",
        choices: [{ index: 0, delta: { content: "lo" }, finish_reason: "stop" }],
      }),
      chatSse({
        id: "chat-stream",
        model: "chat-model",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }),
      encodeSseEvent({ data: "[DONE]", comments: [] }),
    ].join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(chunkedBody(source, [5, 37, 101]), {
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "4",
        },
      }),
    );
    const bridge = chatBridge(fetchMock, new MemorySecretStore({ CHAT_KEY: "secret" }), {
      heartbeatIntervalMs: 0,
    });
    const address = await bridge.start();

    try {
      const response = await postResponses(address.baseUrl, {
        model: "chat-model",
        input: "Hello",
        stream: true,
      });
      const decoded = decodeEvents(await response.text());
      const jsonEvents = decoded
        .filter((event) => event.data !== undefined && event.data !== "[DONE]")
        .map((event) => JSON.parse(event.data ?? "null") as Record<string, unknown>);

      expect(response.headers.get("x-providerdock-bridge")).toBe("chat-completions");
      expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("4");
      expect(jsonEvents.map((event) => event.type)).toEqual(
        expect.arrayContaining([
          "response.created",
          "response.output_text.delta",
          "response.output_item.done",
          "response.completed",
        ]),
      );
      expect(jsonEvents.filter((event) => event.type === "response.output_text.delta")).toEqual([
        expect.objectContaining({ delta: "Hel" }),
        expect.objectContaining({ delta: "lo" }),
      ]);
      expect(jsonEvents.at(-1)).toMatchObject({
        type: "response.completed",
        response: {
          output: [
            { type: "message", content: [{ type: "output_text", text: "Hello" }] },
          ],
          usage: { total_tokens: 6 },
        },
      });
      expect(decoded.at(-1)?.data).toBe("[DONE]");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("preserves call IDs across tool continuation and does not issue an extra request", async () => {
    const upstreamBodies: Record<string, unknown>[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamBodies.push(body);
      if (upstreamBodies.length === 1) {
        return chatJsonResponse({
          id: "chat-tool",
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-A",
                    type: "function",
                    function: { name: "diagnostic", arguments: '{"value":"x"}' },
                  },
                ],
              },
            },
          ],
        });
      }
      const messages = body.messages as Array<Record<string, unknown>>;
      expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
      expect((messages[1]?.tool_calls as Array<Record<string, unknown>>)[0]).toMatchObject({
        id: "call-A",
      });
      expect(messages[2]).toMatchObject({
        role: "tool",
        tool_call_id: "call-A",
        content: "SUCCESS",
      });
      return chatJsonResponse({
        id: "chat-final",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: "Tool completed." },
          },
        ],
      });
    });
    const bridge = chatBridge(fetchMock, new MemorySecretStore({ CHAT_KEY: "secret" }));
    const address = await bridge.start();
    const tools = [
      {
        type: "function",
        name: "diagnostic",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ];

    try {
      const first = await (
        await postResponses(address.baseUrl, {
          model: "chat-model",
          input: "Call diagnostic once.",
          tools,
          tool_choice: "required",
          stream: false,
        })
      ).json() as { output: Array<Record<string, unknown>> };
      const call = first.output.find((item) => item.type === "function_call");
      expect(call).toMatchObject({ call_id: "call-A", name: "diagnostic" });

      const second = await (
        await postResponses(address.baseUrl, {
          model: "chat-model",
          input: [
            { type: "message", role: "user", content: "Call diagnostic once." },
            call,
            { type: "function_call_output", call_id: "call-A", output: "SUCCESS" },
          ],
          tools,
          tool_choice: "auto",
          stream: false,
        })
      ).json() as { output: Array<Record<string, unknown>> };

      expect(second.output).toEqual([
        expect.objectContaining({
          type: "message",
          content: [expect.objectContaining({ text: "Tool completed." })],
        }),
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.stop();
    }
  });

  it("emits failed terminal Responses events for malformed Chat SSE", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("data: {not-json}\n\n", {
        headers: { "content-type": "text/event-stream" },
      }),
    );
    const bridge = chatBridge(fetchMock, new MemorySecretStore({ CHAT_KEY: "secret" }), {
      heartbeatIntervalMs: 0,
    });
    const address = await bridge.start();

    try {
      const response = await postResponses(address.baseUrl, {
        model: "chat-model",
        input: "Hello",
        stream: true,
      });
      const events = decodeEvents(await response.text())
        .filter((event) => event.data !== undefined)
        .map((event) => JSON.parse(event.data ?? "null") as Record<string, unknown>);
      expect(events.at(-1)).toMatchObject({
        type: "response.failed",
        response: { error: { code: "INCOMPLETE_RESPONSE" } },
      });
      expect(events.some((event) => event.type === "response.completed")).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });
});

function chatBridge(
  fetchImpl: typeof fetch,
  secrets: MemorySecretStore,
  options: { readonly heartbeatIntervalMs?: number } = {},
): ResponsesBridgeServer {
  return new ResponsesBridgeServer({
    profile: parseProviderProfile({
      id: "chat-router",
      displayName: "Chat Router",
      baseUrl: "https://chat.test/v1",
      apiType: "openai-chat-completions",
      auth: { kind: "bearer", secretRef: "CHAT_KEY" },
    }),
    secretStore: secrets,
    fetchImpl,
    models: [{ modelId: "chat-model" }],
    ...options,
  });
}

function chatJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function chatSse(body: unknown): string {
  return encodeSseEvent({ data: JSON.stringify(body), comments: [] });
}

function postResponses(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function decodeEvents(source: string) {
  const decoder = new SseDecoder();
  return [...decoder.push(encoder.encode(source)), ...decoder.finish()];
}

function chunkedBody(source: string, boundaries: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let previous = 0;
      for (const boundary of boundaries) {
        controller.enqueue(encoder.encode(source.slice(previous, boundary)));
        previous = boundary;
      }
      controller.enqueue(encoder.encode(source.slice(previous)));
      controller.close();
    },
  });
}
