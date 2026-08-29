import { describe, expect, it, vi } from "vitest";
import {
  AgentRouterAdapter,
  MemorySecretStore,
  ProviderAdapterRegistry,
  ResponsesBridgeServer,
  SseDecoder,
  agentRouterIdentityDefaults,
  encodeSseEvent,
  isBridgePortAllowed,
  parseProviderProfile,
  type ProviderProfile,
} from "../src/index.js";

const encoder = new TextEncoder();

describe("ResponsesBridgeServer", () => {
  it("rejects ports forbidden by Fetch clients", () => {
    expect(isBridgePortAllowed(6000)).toBe(false);
    expect(isBridgePortAllowed(6667)).toBe(false);
    expect(isBridgePortAllowed(10080)).toBe(false);
    expect(isBridgePortAllowed(45678)).toBe(true);
  });

  it("binds to loopback and serves health plus OpenAI/Codex model catalogs", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ id: "resp-1", object: "response", status: "completed", output: [] }),
    );
    const secrets = new MemorySecretStore({ ROUTER_KEY: "secret-value" });
    const profile = testProfile({
      adapterId: "agentrouter",
      auth: { kind: "bearer", secretRef: "ROUTER_KEY" },
      queryParameters: { source: "desktop" },
    });
    const registry = new ProviderAdapterRegistry().register(
      new AgentRouterAdapter({ secretStore: secrets }),
    );
    const bridge = new ResponsesBridgeServer({
      profile,
      secretStore: secrets,
      adapterRegistry: registry,
      fetchImpl: fetchMock,
      models: [
        {
          modelId: "gpt-x",
          displayName: "GPT X",
          supportsImages: true,
          supportsSearchTool: true,
        },
      ],
    });

    const address = await bridge.start();
    try {
      expect(await bridge.start()).toEqual(address);
      expect(address.host).toBe("127.0.0.1");
      expect(address.port).toBeGreaterThan(0);
      expect(address.baseUrl).toBe(`${address.url}/v1`);

      const health = await (await fetch(`${address.url}/health`)).json();
      expect(health).toMatchObject({ status: "ok", provider_id: "router" });

      const modelResponse = await fetch(`${address.baseUrl}/models`);
      const models = (await modelResponse.json()) as {
        data: Array<Record<string, unknown>>;
        models: Array<Record<string, unknown>>;
      };
      expect(models.data[0]).toMatchObject({ id: "gpt-x", object: "model" });
      expect(models.models[0]).toMatchObject({
        slug: "gpt-x",
        display_name: "GPT X",
        shell_type: "unified_exec",
        tool_mode: "direct",
        supports_search_tool: true,
        input_modalities: ["text", "image"],
      });

      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", input: "Hello", stream: false }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ id: "resp-1", status: "completed" });

      const [upstreamUrl, upstreamInit] = fetchMock.mock.calls[0] ?? [];
      expect(String(upstreamUrl)).toBe(
        "https://upstream.test/v1/responses?source=desktop",
      );
      const upstreamHeaders = new Headers(upstreamInit?.headers);
      expect(upstreamHeaders.get("authorization")).toBe("Bearer secret-value");
      expect(upstreamHeaders.get("user-agent")).toBe(
        agentRouterIdentityDefaults["User-Agent"],
      );
      expect(upstreamHeaders.get("originator")).toBe(agentRouterIdentityDefaults.Originator);
    } finally {
      await bridge.stop();
      await bridge.stop();
    }
  });

  it("relays chunked SSE, suppresses duplicates and repairs empty terminal output", async () => {
    const outputItem = {
      id: "msg-1",
      type: "message",
      status: "completed",
      content: [{ type: "output_text", text: "Done", annotations: [] }],
    };
    const doneEvent = {
      type: "response.output_item.done",
      sequence_number: 1,
      output_index: 0,
      item: outputItem,
    };
    const source = [
      encodeJsonEvent(doneEvent),
      encodeJsonEvent(doneEvent),
      encodeJsonEvent({
        type: "response.completed",
        sequence_number: 2,
        response: { id: "resp-stream", object: "response", status: "completed", output: [] },
      }),
      encodeSseEvent({ data: "[DONE]", comments: [] }),
    ].join("");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(chunkedBody(source, [7, 31, 83]), {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "x-ratelimit-remaining-requests": "9",
          "x-request-id": "req-upstream",
        },
      }),
    );
    const bridge = testBridge(fetchMock, { heartbeatIntervalMs: 0 });
    const address = await bridge.start();

    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", input: "Work", stream: true }),
      });
      const text = await response.text();
      const decoded = decodeEvents(text);
      const jsonEvents = decoded
        .filter((event) => event.data !== undefined && event.data !== "[DONE]")
        .map((event) => JSON.parse(event.data ?? "null") as Record<string, unknown>);

      expect(response.status).toBe(200);
      expect(response.headers.get("x-ratelimit-remaining-requests")).toBe("9");
      expect(response.headers.get("x-request-id")).toBe("req-upstream");
      expect(jsonEvents.filter((event) => event.type === "response.output_item.done")).toHaveLength(1);
      expect(jsonEvents.find((event) => event.type === "response.completed")).toMatchObject({
        response: { output: [outputItem] },
      });
      expect(decoded.at(-1)?.data).toBe("[DONE]");
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });

  it("synthesizes completion only for fully completed output and fails pending output", async () => {
    const completeSource = [
      encodeJsonEvent({
        type: "response.output_item.done",
        sequence_number: 3,
        output_index: 0,
        item: { id: "msg", type: "message", status: "completed", content: [] },
      }),
    ].join("");
    const pendingSource = [
      encodeJsonEvent({
        type: "response.output_item.added",
        sequence_number: 0,
        output_index: 0,
        item: { id: "call", type: "function_call", status: "in_progress" },
      }),
      encodeSseEvent({ data: "[DONE]", comments: [] }),
    ].join("");
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(sseResponse(completeSource))
      .mockResolvedValueOnce(sseResponse(pendingSource));
    const bridge = testBridge(fetchMock, { heartbeatIntervalMs: 0 });
    const address = await bridge.start();

    try {
      const completed = await postStream(address.baseUrl);
      expect(completed.find((event) => event.type === "response.completed")).toMatchObject({
        sequence_number: 4,
        response: { status: "completed" },
      });

      const failed = await postStream(address.baseUrl, "Work on the pending case");
      expect(failed.find((event) => event.type === "response.failed")).toMatchObject({
        response: {
          status: "failed",
          error: { code: "INCOMPLETE_RESPONSE" },
        },
      });
    } finally {
      await bridge.stop();
    }
  });

  it("turns a complete JSON response into terminal SSE when streaming was requested", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: "resp-json",
        object: "response",
        status: "completed",
        output: [{ id: "msg", type: "message", status: "completed", content: [] }],
      }),
    );
    const bridge = testBridge(fetchMock);
    const address = await bridge.start();

    try {
      const response = await fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", input: "Hello", stream: true }),
      });
      const events = decodeEvents(await response.text());
      expect(response.headers.get("x-providerdock-normalization")).toBe("json-to-sse");
      expect(JSON.parse(events[0]?.data ?? "null")).toMatchObject({
        type: "response.completed",
        response: { id: "resp-json", status: "completed" },
      });
      expect(events.at(-1)?.data).toBe("[DONE]");
    } finally {
      await bridge.stop();
    }
  });

  it("emits heartbeat comments while an upstream stream is idle", async () => {
    const delayedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        setTimeout(() => {
          controller.enqueue(encoder.encode(encodeSseEvent({ data: "[DONE]", comments: [] })));
          controller.close();
        }, 30);
      },
    });
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(delayedBody, { headers: { "content-type": "text/event-stream" } }),
    );
    const bridge = testBridge(fetchMock, { heartbeatIntervalMs: 5 });
    const address = await bridge.start();

    try {
      const response = await postJson(address.baseUrl, {
        model: "gpt-x",
        input: "Wait",
        stream: true,
      });
      const events = decodeEvents(await response.text());
      expect(events.some((event) => event.comments.includes("providerdock-keepalive"))).toBe(true);
      expect(
        events
          .filter((event) => event.data !== undefined && event.data !== "[DONE]")
          .map((event) => JSON.parse(event.data ?? "null"))
          .find((event) => event.type === "response.failed"),
      ).toMatchObject({ response: { error: { code: "INCOMPLETE_RESPONSE" } } });
    } finally {
      await bridge.stop();
    }
  });

  it("converts malformed upstream SSE into a protocol-safe failed terminal event", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      sseResponse("event: response.delta\ndata: {not-json}\n\n"),
    );
    const bridge = testBridge(fetchMock, { heartbeatIntervalMs: 0 });
    const address = await bridge.start();

    try {
      const events = await postStream(address.baseUrl);
      expect(events).toEqual([
        expect.objectContaining({
          type: "response.failed",
          response: expect.objectContaining({
            status: "failed",
            error: expect.objectContaining({ code: "INCOMPLETE_RESPONSE" }),
          }),
        }),
      ]);
    } finally {
      await bridge.stop();
    }
  });

  it("normalizes upstream and transport failures without replaying or leaking error bodies", async () => {
    const leakedSecret = "secret-that-must-not-leak";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(`upstream echoed ${leakedSecret}`, {
          status: 401,
          headers: { "content-type": "text/plain", "retry-after": "2" },
        }),
      )
      .mockRejectedValueOnce(new Error("connection reset"));
    const bridge = testBridge(fetchMock);
    const address = await bridge.start();

    try {
      const authResponse = await postJson(address.baseUrl, { stream: false });
      const authText = await authResponse.text();
      expect(authResponse.status).toBe(401);
      expect(authResponse.headers.get("retry-after")).toBe("2");
      expect(authText).toContain("AUTH_ERROR");
      expect(authText).not.toContain(leakedSecret);

      const networkResponse = await postJson(address.baseUrl, { stream: false });
      expect(networkResponse.status).toBe(502);
      expect(await networkResponse.json()).toMatchObject({
        error: { code: "NETWORK_ERROR" },
      });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      await bridge.stop();
    }
  });

  it("enforces request bounds before contacting the provider", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const bridge = testBridge(fetchMock, { requestBodyLimitBytes: 32 });
    const address = await bridge.start();

    try {
      const response = await postJson(address.baseUrl, {
        model: "gpt-x",
        input: "x".repeat(100),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      await bridge.stop();
    }
  });

  it("aborts the single upstream request when the bridge client disconnects", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchMock = vi.fn<typeof fetch>(async (_input, init) => {
      upstreamSignal = init?.signal ?? undefined;
      return await new Promise<Response>((_resolve, reject) => {
        upstreamSignal?.addEventListener(
          "abort",
          () => reject(upstreamSignal?.reason ?? new Error("aborted")),
          { once: true },
        );
      });
    });
    const bridge = testBridge(fetchMock);
    const address = await bridge.start();
    const clientController = new AbortController();

    try {
      const pending = fetch(`${address.baseUrl}/responses`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", input: "Wait", stream: true }),
        signal: clientController.signal,
      });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      clientController.abort();
      await pending.catch(() => undefined);
      await vi.waitFor(() => expect(upstreamSignal?.aborted).toBe(true));
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      await bridge.stop();
    }
  });
});

function testProfile(overrides: Record<string, unknown> = {}): ProviderProfile {
  return parseProviderProfile({
    id: "router",
    displayName: "Test Router",
    baseUrl: "https://upstream.test/v1",
    apiType: "openai-responses",
    timeoutMs: 1_000,
    ...overrides,
  });
}

function testBridge(
  fetchImpl: typeof fetch,
  options: {
    readonly heartbeatIntervalMs?: number;
    readonly requestBodyLimitBytes?: number;
  } = {},
): ResponsesBridgeServer {
  return new ResponsesBridgeServer({
    profile: testProfile(),
    secretStore: new MemorySecretStore(),
    fetchImpl,
    models: [{ modelId: "gpt-x" }],
    ...options,
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": "req-json" },
  });
}

function sseResponse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
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

function encodeJsonEvent(event: Record<string, unknown>): string {
  return encodeSseEvent({
    event: String(event.type),
    data: JSON.stringify(event),
    comments: [],
  });
}

function decodeEvents(source: string) {
  const decoder = new SseDecoder();
  return [...decoder.push(encoder.encode(source)), ...decoder.finish()];
}

async function postStream(
  baseUrl: string,
  input = "Work",
): Promise<Array<Record<string, unknown>>> {
  const response = await postJson(baseUrl, { model: "gpt-x", input, stream: true });
  return decodeEvents(await response.text())
    .filter((event) => event.data !== undefined && event.data !== "[DONE]")
    .map((event) => JSON.parse(event.data ?? "null") as Record<string, unknown>);
}

function postJson(baseUrl: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${baseUrl}/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
