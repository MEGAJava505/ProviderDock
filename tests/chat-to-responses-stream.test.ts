import { describe, expect, it } from "vitest";
import {
  ChatToResponsesStreamTranslator,
  ChatToResponsesTranslationError,
  translateResponsesRequestToChat,
  type ResponsesStreamEventRecord,
} from "../src/index.js";

describe("ChatToResponsesStreamTranslator", () => {
  it("emits reasoning and text deltas before a complete terminal response", () => {
    const translator = streamTranslator({
      model: "model-x",
      input: "Hello",
      reasoning: { effort: "high" },
      stream: true,
    });
    const events = feedAll(translator, [
      chunk({ role: "assistant", reasoning_content: "Think" }),
      chunk({ content: "Hel" }),
      chunk({ content: "lo" }, "stop"),
      {
        id: "chat-stream",
        model: "model-x",
        choices: [],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      },
    ]);
    events.push(...translator.finish());

    expect(events.map((event) => event.sequence_number)).toEqual(
      events.map((_event, index) => index),
    );
    expect(events[0]).toMatchObject({
      type: "response.created",
      response: { reasoning: { effort: "high", summary: null } },
    });
    expect(eventTypes(events)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    const terminal = events.at(-1);
    expect(terminal).toMatchObject({
      type: "response.completed",
      response: {
        status: "completed",
        output: [
          { type: "reasoning", summary: [{ text: "Think" }] },
          {
            type: "message",
            content: [{ type: "output_text", text: "Hello" }],
          },
        ],
        usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
      },
    });
    expect(translator.terminalEventSeen).toBe(true);
    expect(translator.finish()).toEqual([]);
  });

  it("streams function arguments and safely unwraps a completed custom tool call", () => {
    const translator = streamTranslator({
      model: "tools",
      input: "Use tools",
      stream: true,
      tools: [
        { type: "function", name: "lookup", parameters: { type: "object" } },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ],
    });
    const events = feedAll(translator, [
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "call-a",
            type: "function",
            function: { name: "lookup", arguments: '{"key":' },
          },
          {
            index: 1,
            id: "call-b",
            type: "function",
            function: { name: "apply", arguments: '{"input":"*** ' },
          },
        ],
      }),
      chunk({
        tool_calls: [
          { index: 0, function: { arguments: '"x"}' } },
          { index: 1, function: { name: "_patch", arguments: 'Patch"}' } },
        ],
      }),
      chunk({}, "tool_calls"),
    ]);
    events.push(...translator.finish());

    expect(events[0]).toMatchObject({
      type: "response.created",
      response: {
        tools: [
          { type: "function", name: "lookup", parameters: { type: "object" } },
          { type: "custom", name: "apply_patch", format: { type: "text" } },
        ],
      },
    });

    expect(
      events
        .filter((event) => event.type === "response.function_call_arguments.delta")
        .map((event) => event.delta),
    ).toEqual(['{"key":', '"x"}']);
    expect(eventTypes(events)).toContain("response.custom_tool_call_input.delta");
    expect(eventTypes(events)).toContain("response.custom_tool_call_input.done");
    expect(events.at(-1)).toMatchObject({
      type: "response.completed",
      response: {
        output: [
          {
            type: "function_call",
            call_id: "call-a",
            name: "lookup",
            arguments: '{"key":"x"}',
          },
          {
            type: "custom_tool_call",
            call_id: "call-b",
            name: "apply_patch",
            input: "*** Patch",
          },
        ],
      },
    });
  });

  it("emits incomplete for a length finish after preserving partial text", () => {
    const translator = streamTranslator({ model: "model-x", input: "Long", stream: true });
    const events = [
      ...translator.feed(chunk({ content: "Partial" }, "length")),
      ...translator.finish(),
    ];

    expect(events.at(-1)).toMatchObject({
      type: "response.incomplete",
      response: {
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [
          { type: "message", content: [{ type: "output_text", text: "Partial" }] },
        ],
      },
    });
  });

  it("never synthesizes success when transport closes without finish_reason", () => {
    const translator = streamTranslator({ model: "model-x", input: "Hello", stream: true });
    const events = [
      ...translator.feed(chunk({ content: "Partial" })),
      ...translator.finish(),
    ];

    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { status: "failed", error: { code: "INCOMPLETE_RESPONSE" }, output: [] },
    });
    expect(eventTypes(events)).not.toContain("response.completed");
    expect(eventTypes(events)).not.toContain("response.output_item.done");
  });

  it("turns an unknown or malformed tool call into failure without delivering it", () => {
    const translator = streamTranslator({
      model: "tools",
      input: "Use a tool",
      stream: true,
      tools: [{ type: "function", name: "known", parameters: { type: "object" } }],
    });
    const events = [
      ...translator.feed(
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "call-unknown",
              function: { name: "unknown", arguments: "{}" },
            },
          ],
        }),
      ),
      ...translator.feed(chunk({}, "tool_calls")),
      ...translator.finish(),
    ];

    expect(eventTypes(events)).not.toContain("response.output_item.added");
    expect(events.at(-1)).toMatchObject({
      type: "response.failed",
      response: { error: { code: "INCOMPLETE_RESPONSE" } },
    });
  });

  it("detects conflicting chunk identity and can emit one normalized failure", () => {
    const translator = streamTranslator({ model: "model-x", input: "Hello", stream: true });
    translator.feed({ id: "first", model: "model-x", choices: [{ delta: {} }] });

    expect(() =>
      translator.feed({ id: "second", model: "model-x", choices: [{ delta: {} }] }),
    ).toThrow(ChatToResponsesTranslationError);
    const failed = translator.fail("Conflicting upstream stream identity.");
    expect(failed).toEqual([
      expect.objectContaining({
        type: "response.failed",
        response: expect.objectContaining({ error: { code: "INCOMPLETE_RESPONSE", type: "providerdock_chat_stream_failed", message: "Conflicting upstream stream identity." } }),
      }),
    ]);
    expect(translator.fail("again")).toEqual([]);
  });

  it("streams a refusal using refusal-specific content events", () => {
    const translator = streamTranslator({ model: "model-x", input: "Unsafe", stream: true });
    const events = [
      ...translator.feed(chunk({ refusal: "Cannot" }, "stop")),
      ...translator.finish(),
    ];

    expect(eventTypes(events)).toEqual(
      expect.arrayContaining([
        "response.refusal.delta",
        "response.refusal.done",
        "response.content_part.done",
        "response.completed",
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      response: {
        output: [
          { type: "message", content: [{ type: "refusal", refusal: "Cannot" }] },
        ],
      },
    });
  });
});

function streamTranslator(payload: Record<string, unknown>): ChatToResponsesStreamTranslator {
  return new ChatToResponsesStreamTranslator({
    request: translateResponsesRequestToChat(payload, {
      requestId: "req-stream",
      sessionId: "session-stream",
    }).canonical,
    now: () => new Date("2026-08-29T12:00:00.000Z"),
  });
}

function chunk(delta: Record<string, unknown>, finishReason: string | null = null) {
  return {
    id: "chat-stream",
    created: 1_777_777_700,
    model: "model-x",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

function feedAll(
  translator: ChatToResponsesStreamTranslator,
  chunks: readonly Record<string, unknown>[],
): ResponsesStreamEventRecord[] {
  return chunks.flatMap((chunkValue) => translator.feed(chunkValue));
}

function eventTypes(events: readonly ResponsesStreamEventRecord[]): unknown[] {
  return events.map((event) => event.type);
}
