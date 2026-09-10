import { describe, expect, it, vi } from "vitest";
import {
  AnthropicBridgeServer, MemorySecretStore, ResponsesBridgeServer, SseDecoder,
  ChatToAnthropicStreamTranslator, ChatToResponsesStreamTranslator,
  translateResponsesRequestToChat, parseProviderProfile,
} from "../src/index.js";
import { normalizeOpenAiUsage, normalizeResponsesResponse } from "../src/protocols/openai-responses/response-normalization.js";

const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
const sse = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;
const completed = { id: "resp-stable", status: "completed", output: [], usage: { input_tokens: 10, output_tokens: 2 } };
const chatReply = {
  id: "chat-stable", model: "fixture-model",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Done once." } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};
const encoder = new TextEncoder();

function profile(apiType: "openai-responses" | "openai-chat-completions" | "anthropic-messages") {
  return parseProviderProfile({ id: "fixture", displayName: "Fixture", baseUrl: "https://fixture.invalid/v1", apiType });
}

function events(source: string): Record<string, unknown>[] {
  const decoder = new SseDecoder();
  return [...decoder.push(encoder.encode(source)), ...decoder.finish()]
    .filter((event) => event.data !== undefined && event.data !== "[DONE]")
    .map((event) => JSON.parse(event.data!));
}

describe("bridge completion and replay regressions", () => {
  it("remembers an auto Chat fallback per model while leaving another model on Responses", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      const body = JSON.parse(String(init?.body));
      if (String(url).endsWith("/responses")) return body.model === "chat-only"
        ? new Response("Not found", { status: 404 }) : json(completed);
      return json({ ...chatReply, model: body.model });
    });
    const bridge = new ResponsesBridgeServer({ profile: { ...profile("openai-responses"), apiType: "auto" }, secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
    const address = await bridge.start();
    try {
      for (const [model, input] of [["chat-only", "First"], ["chat-only", "Second"], ["native", "Third"]]) {
        const response = await fetch(`${address.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, input }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: "completed" });
      }
      expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
        "/v1/responses", "/v1/chat/completions", "/v1/chat/completions", "/v1/responses",
      ]);
    } finally { await bridge.stop(); }
  });

  it.each([401, 429, 502])("does not try another protocol after HTTP %i", async (status) => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("Rejected", { status }));
    const bridge = new ResponsesBridgeServer({ profile: { ...profile("openai-responses"), apiType: "auto" }, secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
    const address = await bridge.start();
    try {
      const response = await fetch(`${address.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "Hello" }) });
      expect(response.status).toBe(status);
      await response.text();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });

  it("honors an explicit Responses route even on a missing endpoint", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => new Response("Not found", { status: 404 }));
    const bridge = new ResponsesBridgeServer({ profile: profile("openai-responses"), secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
    const address = await bridge.start();
    try {
      const response = await fetch(`${address.baseUrl}/responses`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture", input: "Hello" }) });
      expect(response.status).toBe(404);
      await response.text();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });

  it("honors explicit Chat for Claude models and GoRouter without probing Messages", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => json({ ...chatReply, model: "claude-opus-fixture" }));
    const bridge = new AnthropicBridgeServer({ profile: { ...profile("openai-chat-completions"), adapterId: "gorouter" }, secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
    const address = await bridge.start();
    try {
      const response = await fetch(`${address.url}/v1/messages`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "claude-opus-fixture", max_tokens: 32, messages: [{ role: "user", content: "Hello" }] }) });
      expect(response.status).toBe(200);
      await response.json();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0]?.[0])).toBe("https://fixture.invalid/v1/chat/completions");
    } finally { await bridge.stop(); }
  });

  it.each(["codex", "claude"])("finishes a Chat stream with a missing DONE/EOF for %s and keeps trailing usage", async (client) => {
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ id: "chat", choices: [{ delta: { content: "Done once" }, finish_reason: "stop" }] }) +
          sse({ id: "chat", choices: [], usage: { prompt_tokens: 7, completion_tokens: 2 } })));
      }, cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    const options = { profile: profile("openai-chat-completions"), secretStore: new MemorySecretStore(), fetchImpl: fetchMock };
    const bridge = client === "codex" ? new ResponsesBridgeServer(options) : new AnthropicBridgeServer(options);
    const address = await bridge.start();
    const url = "baseUrl" in address ? `${address.baseUrl}/responses` : `${address.url}/v1/messages`;
    try {
      const body = client === "codex" ? { model: "fixture-model", input: "Hello", stream: true }
        : { model: "fixture-model", max_tokens: 32, messages: [{ role: "user", content: "Hello" }], stream: true };
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(2500) });
      const output = events(await response.text());
      if (client === "codex") expect(output.at(-1)).toMatchObject({ type: "response.completed", response: { usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 } } });
      else {
        expect(output.at(-1)).toMatchObject({ type: "message_stop" });
        expect(output.find((event) => event.type === "message_delta")).toMatchObject({ usage: { output_tokens: 2 } });
      }
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });

  it.each(["openai-responses", "openai-chat-completions"] as const)(
    "sends one upstream request for fifteen copies of a completed Codex turn over %s", async (apiType) => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json(apiType === "openai-responses" ? completed : chatReply));
      const bridge = new ResponsesBridgeServer({ profile: profile(apiType), secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
      const address = await bridge.start();
      try {
        for (let i = 0; i < 15; i++) {
          const response = await fetch(`${address.baseUrl}/responses`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", input: "Do this once", stream: false }),
          });
          expect(response.status).toBe(i === 0 ? 200 : 409);
          const body = await response.json();
          if (i === 0) expect(body).toMatchObject({ status: "completed", usage: { total_tokens: 12 } });
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally { await bridge.stop(); }
    },
  );

  it.each(["openai-chat-completions", "anthropic-messages"] as const)(
    "sends one upstream request for fifteen copies of a completed Claude turn over %s", async (apiType) => {
      const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => json(apiType === "openai-chat-completions" ? chatReply : {
        id: "msg-stable", type: "message", role: "assistant", model: "fixture-model",
        content: [{ type: "text", text: "Done once." }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 2 },
      }));
      const bridge = new AnthropicBridgeServer({ profile: profile(apiType), secretStore: new MemorySecretStore(), fetchImpl: fetchMock });
      const address = await bridge.start();
      try {
        for (let i = 0; i < 15; i++) {
          const response = await fetch(`${address.url}/v1/messages`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ model: "fixture-model", max_tokens: 64, messages: [{ role: "user", content: "Do this once" }] }),
          });
          expect(response.status).toBe(i === 0 ? 200 : 409);
          await response.text();
        }
        expect(fetchMock).toHaveBeenCalledTimes(1);
      } finally { await bridge.stop(); }
    },
  );

  it("closes native Responses at completion, normalizes usage and ignores a second answer", async () => {
    const cancel = vi.fn();
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(sse({ type: "response.completed", response: completed }) +
          sse({ type: "response.output_text.delta", delta: "A repeated answer" })));
        // Deliberately no EOF or [DONE].
      }, cancel,
    }), { headers: { "content-type": "text/event-stream" } }));
    const bridge = new ResponsesBridgeServer({ profile: profile("openai-responses"), secretStore: new MemorySecretStore(), fetchImpl: fetchMock, heartbeatIntervalMs: 0 });
    const address = await bridge.start();
    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST", headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(2000),
        body: JSON.stringify({ model: "fixture-model", input: "One answer", stream: true }),
      });
      const output = events(await response.text());
      expect(output).toHaveLength(1);
      expect(output[0]).toMatchObject({ type: "response.completed", response: { usage: { total_tokens: 12 } } });
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });

  it("reports a transport error after a done item once and blocks its replay", async () => {
    let pulls = 0;
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(encoder.encode(sse({ type: "response.output_item.done", output_index: 0,
          item: { id: "msg", type: "message", role: "assistant", status: "completed", content: [] } })));
        else controller.error(new Error("Synthetic connection reset"));
      },
    }), { headers: { "content-type": "text/event-stream" } }));
    const bridge = new ResponsesBridgeServer({ profile: profile("openai-responses"), secretStore: new MemorySecretStore(), fetchImpl: fetchMock, heartbeatIntervalMs: 0 });
    const address = await bridge.start();
    const request = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model: "fixture-model", input: "Interrupted", stream: true }) };
    try {
      const first = await fetch(`${address.baseUrl}/responses`, request);
      const output = events(await first.text());
      expect(output.filter((event) => event.type === "response.failed")).toHaveLength(1);
      expect(output.some((event) => event.type === "response.completed")).toBe(false);
      const repeat = await fetch(`${address.baseUrl}/responses`, request);
      expect(repeat.status).toBe(409);
      await repeat.text();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally { await bridge.stop(); }
  });

  it.each(["codex", "claude"])("rejects extra Chat content after finish_reason for %s", (client) => {
    const canonical = translateResponsesRequestToChat({ model: "fixture-model", input: "Hello" }).canonical;
    const translator = client === "codex" ? new ChatToResponsesStreamTranslator({ request: canonical })
      : new ChatToAnthropicStreamTranslator({ model: "fixture-model" });
    translator.feed({ id: "chat", choices: [{ delta: { content: "Done once" }, finish_reason: "stop" }] });
    // A trailing usage chunk is valid, further generated text is not.
    translator.feed({ id: "chat", choices: [], usage: { prompt_tokens: 3, completion_tokens: 2 } });
    expect(() => translator.feed({ id: "chat", choices: [{ delta: { content: "Done again" } }] })).toThrow(/after finish_reason/);
  });
});

describe("Responses normalization", () => {
  it("derives totals without double-counting cache and reasoning", () => {
    expect(normalizeOpenAiUsage({ input_tokens: 10, output_tokens: 2, total_tokens: -1,
      input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 1 } })).toMatchObject({ total_tokens: 12 });
  });

  it.each([undefined, null, {}, { input_tokens: 1 }, { input_tokens: -1, output_tokens: 2 }, { input_tokens: 1.5, output_tokens: 2 }])(
    "does not invent measured zero usage from %j", (value) => expect(normalizeOpenAiUsage(value)).toBeNull(),
  );

  it.each([
    { ...completed, status: "in_progress" },
    { ...completed, error: { message: "failed" } },
    { ...completed, output: [{ type: "function_call", status: "in_progress" }] },
  ])("rejects misleading completion payloads", (value) => expect(() => normalizeResponsesResponse(value)).toThrow());

  it("rejects a completed event carrying a failed response", () => {
    expect(() => normalizeResponsesResponse({ ...completed, status: "failed" }, "completed")).toThrow(/disagrees/);
  });
});
