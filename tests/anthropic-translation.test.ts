import { describe, expect, it } from "vitest";
import {
  AnthropicTranslationError,
  ChatToAnthropicStreamTranslator,
  translateAnthropicRequestToChat,
  translateChatResponseToAnthropic,
} from "../src/index.js";

describe("translateAnthropicRequestToChat", () => {
  it("translates system, blocks, tools and tool_choice", () => {
    const { chatRequest, model, stream, toolNames } = translateAnthropicRequestToChat({
      model: "m-1",
      max_tokens: 512,
      system: [{ type: "text", text: "Be terse." }],
      stream: true,
      stop_sequences: ["END"],
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Need a lookup.", signature: "sig" },
            { type: "text", text: "Checking." },
            { type: "tool_use", id: "toolu_1", name: "lookup", input: { q: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "42" },
            { type: "text", text: "Continue" },
          ],
        },
      ],
      tools: [
        {
          name: "lookup",
          description: "Lookup",
          input_schema: { type: "object", properties: { q: { type: "string" } } },
        },
      ],
      tool_choice: { type: "tool", name: "lookup" },
    });

    expect(model).toBe("m-1");
    expect(stream).toBe(true);
    expect(toolNames).toEqual(["lookup"]);
    expect(chatRequest.stop).toEqual(["END"]);
    expect(chatRequest.max_tokens).toBe(512);
    const messages = chatRequest.messages as Array<Record<string, unknown>>;
    expect(messages[0]).toEqual({ role: "system", content: "Be terse." });
    expect(messages[1]).toEqual({ role: "user", content: "Hi" });
    expect(messages[2]).toMatchObject({
      role: "assistant",
      content: "Checking.",
      reasoning_content: "Need a lookup.",
      tool_calls: [
        {
          id: "toolu_1",
          type: "function",
          function: { name: "lookup", arguments: JSON.stringify({ q: "x" }) },
        },
      ],
    });
    expect(messages[3]).toMatchObject({ role: "tool", tool_call_id: "toolu_1", content: "42" });
    expect(messages[4]).toMatchObject({ role: "user", content: "Continue" });
    expect(chatRequest.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Lookup",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      },
    ]);
    expect(chatRequest.tool_choice).toEqual({ type: "function", function: { name: "lookup" } });
  });

  it("rejects invalid requests with a normalized error", () => {
    expect(() => translateAnthropicRequestToChat({ model: "m", messages: "no" })).toThrow(
      AnthropicTranslationError,
    );
  });

  it("normalizes system and developer instruction turns emitted by coding clients", () => {
    const { chatRequest } = translateAnthropicRequestToChat({
      model: "m",
      max_tokens: 64,
      messages: [
        { role: "system", content: "System instruction." },
        { role: "developer", content: [{ type: "text", text: "Developer instruction." }] },
        { role: "user", content: "Hi" },
      ],
    });

    expect(chatRequest.messages).toEqual([
      { role: "system", content: "System instruction." },
      { role: "system", content: "Developer instruction." },
      { role: "user", content: "Hi" },
    ]);
  });

  it("gracefully omits Anthropic thinking controls for generic Chat Completions", () => {
    const { chatRequest } = translateAnthropicRequestToChat({
      model: "claude-opus-5-thinking",
      max_tokens: 16_000,
      thinking: { type: "adaptive" },
      output_config: { effort: "max" },
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "Previous reasoning.", signature: "sig" },
            { type: "text", text: "Previous answer." },
          ],
        },
        { role: "user", content: "Continue" },
      ],
    });

    expect(chatRequest).toMatchObject({
      model: "claude-opus-5-thinking",
      max_tokens: 16_000,
      messages: [
        { role: "user", content: "Hi" },
        {
          role: "assistant",
          content: "Previous answer.",
          reasoning_content: "Previous reasoning.",
        },
        { role: "user", content: "Continue" },
      ],
    });
    expect(chatRequest).not.toHaveProperty("thinking");
    expect(chatRequest).not.toHaveProperty("output_config");
    expect(chatRequest).not.toHaveProperty("reasoning_effort");
  });
});

describe("translateChatResponseToAnthropic", () => {
  it("maps content, tool calls, stop reason and usage", () => {
    const translated = translateChatResponseToAnthropic(
      {
        id: "chatcmpl-1",
        model: "provider-m",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: "Working on it.",
              tool_calls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "lookup", arguments: "{\"q\":1}" },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 7,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens: 3,
        },
      },
      { model: "m-1", allowedToolNames: ["lookup"] },
    );

    expect(translated).toMatchObject({
      type: "message",
      role: "assistant",
      model: "provider-m",
      stop_reason: "tool_use",
      usage: {
        input_tokens: 5,
        cache_read_input_tokens: 2,
        output_tokens: 3,
      },
    });
    const content = translated.content as Array<Record<string, unknown>>;
    expect(content[0]).toEqual({ type: "text", text: "Working on it." });
    expect(content[1]).toMatchObject({ type: "tool_use", id: "call_1", input: { q: 1 } });
  });

  it("rejects malformed arguments, unknown tools, and missing terminal semantics", () => {
    const base = {
      id: "chatcmpl-invalid",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            tool_calls: [
              {
                id: "call_bad",
                type: "function",
                function: { name: "lookup", arguments: "not-json" },
              },
            ],
          },
        },
      ],
    };
    expect(() =>
      translateChatResponseToAnthropic(base, {
        model: "m-1",
        allowedToolNames: ["lookup"],
      }),
    ).toThrow(/malformed JSON arguments/i);

    expect(() =>
      translateChatResponseToAnthropic(
        {
          ...base,
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  {
                    id: "call_unknown",
                    type: "function",
                    function: { name: "unknown", arguments: "{}" },
                  },
                ],
              },
            },
          ],
        },
        { model: "m-1", allowedToolNames: ["lookup"] },
      ),
    ).toThrow(/unknown tool/i);

    expect(() =>
      translateChatResponseToAnthropic(
        { choices: [{ finish_reason: null, message: { content: "partial" } }] },
        { model: "m-1" },
      ),
    ).toThrow(/finish reason/i);
  });

  it("never forges unsigned Chat reasoning into an Anthropic thinking block", () => {
    const reasoningOnly = translateChatResponseToAnthropic(
      {
        id: "chat-reasoning-only",
        choices: [
          {
            finish_reason: "stop",
            message: { role: "assistant", content: null, reasoning_content: "A safe fallback." },
          },
        ],
      },
      { model: "claude-x" },
    );
    expect(reasoningOnly.content).toEqual([{ type: "text", text: "A safe fallback." }]);

    const withAnswer = translateChatResponseToAnthropic(
      {
        id: "chat-reasoning-answer",
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: "Final answer.",
              reasoning_content: "Private scratch work.",
            },
          },
        ],
      },
      { model: "claude-x" },
    );
    expect(withAnswer.content).toEqual([{ type: "text", text: "Final answer." }]);
  });
});

describe("ChatToAnthropicStreamTranslator", () => {
  it("produces strictly ordered Anthropic stream frames", () => {
    const translator = new ChatToAnthropicStreamTranslator({
      model: "m-1",
      allowedToolNames: ["lookup"],
    });
    const events = [
      ...translator.feed({
        id: "chunk-1",
        model: "provider-m",
        choices: [{ delta: { content: "Hel" } }],
      }),
      ...translator.feed({ choices: [{ delta: { content: "lo" } }] }),
      ...translator.feed({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call_1", function: { name: "lookup", arguments: "{\"q\":" } },
              ],
            },
          },
        ],
      }),
      ...translator.feed({
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] }, finish_reason: "tool_calls" },
        ],
        usage: {
          prompt_tokens: 5,
          prompt_tokens_details: { cached_tokens: 1 },
          completion_tokens: 2,
        },
      }),
      ...translator.finish(),
    ];

    expect(events.map((event) => event.event)).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_delta",
      "content_block_stop",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(events[0]!.data).toMatchObject({
      message: {
        id: expect.stringMatching(/^msg_providerdock_[a-f0-9]{24}$/),
        model: "provider-m",
      },
    });
    expect(events[5]!.data).toMatchObject({
      content_block: { type: "tool_use", id: "call_1", name: "lookup" },
    });
    expect(events[8]!.data).toMatchObject({
      delta: { stop_reason: "tool_use" },
      usage: {
        input_tokens: 4,
        cache_read_input_tokens: 1,
        output_tokens: 2,
      },
    });
    expect(translator.terminalEventSeen).toBe(true);
    expect(translator.finish()).toEqual([]);
  });

  it("buffers parallel fragmented tools and fails closed without finish_reason", () => {
    const translator = new ChatToAnthropicStreamTranslator({
      model: "m-1",
      allowedToolNames: ["first", "second"],
    });
    const events = [
      ...translator.feed({
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, id: "call-1", function: { name: "fir", arguments: '{"x":' } },
                { index: 1, id: "call-2", function: { name: "sec", arguments: '{"y":' } },
              ],
            },
          },
        ],
      }),
      ...translator.feed({
        choices: [
          {
            finish_reason: "tool_calls",
            delta: {
              tool_calls: [
                { index: 0, function: { name: "st", arguments: "1}" } },
                { index: 1, function: { name: "ond", arguments: "2}" } },
              ],
            },
          },
        ],
      }),
      ...translator.finish(),
    ];
    expect(events.filter((event) => event.event === "content_block_start")).toHaveLength(2);
    expect(translator.completedToolUses).toEqual([
      { id: "call-1", name: "first", input: { x: 1 } },
      { id: "call-2", name: "second", input: { y: 2 } },
    ]);
    expect(translator.terminalSucceeded).toBe(true);

    const incomplete = new ChatToAnthropicStreamTranslator({ model: "m-1" });
    incomplete.feed({ choices: [{ delta: { content: "partial" } }] });
    expect(incomplete.finish()).toEqual([
      expect.objectContaining({ event: "error" }),
    ]);
    expect(incomplete.terminalSucceeded).toBe(false);
  });

  it("emits a terminal Anthropic error frame on upstream failure", () => {
    const translator = new ChatToAnthropicStreamTranslator({ model: "m-1" });
    translator.feed({ choices: [{ delta: { content: "partial" } }] });
    const events = translator.fail("Upstream broke.");
    expect(events).toEqual([
      {
        event: "error",
        data: { type: "error", error: { type: "api_error", message: "Upstream broke." } },
      },
    ]);
    expect(translator.terminalEventSeen).toBe(true);
  });

  it("buffers unsigned streamed reasoning and uses text only as a last resort", () => {
    const translator = new ChatToAnthropicStreamTranslator({ model: "claude-x" });
    const events = [
      ...translator.feed({
        choices: [{ delta: { reasoning_content: "Fallback reasoning." } }],
      }),
      ...translator.feed({ choices: [{ delta: {}, finish_reason: "stop" }] }),
      ...translator.finish(),
    ];

    expect(events.some((event) =>
      event.data.type === "content_block_delta" &&
      (event.data.delta as Record<string, unknown> | undefined)?.type === "thinking_delta"
    )).toBe(false);
    expect(events).toContainEqual({
      event: "content_block_delta",
      data: {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Fallback reasoning." },
      },
    });
    expect(translator.terminalSucceeded).toBe(true);
  });
});
