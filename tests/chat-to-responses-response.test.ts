import { describe, expect, it } from "vitest";
import {
  ChatToResponsesTranslationError,
  normalizeChatUsage,
  translateChatResponseToResponses,
  translateResponsesRequestToChat,
} from "../src/index.js";

describe("translateChatResponseToResponses", () => {
  it("creates a complete Responses envelope for a text answer", () => {
    const request = canonicalRequest({
      model: "model-x",
      input: "Hello",
      max_output_tokens: 256,
      temperature: 0.3,
      top_p: 0.8,
      metadata: { project: "ProviderDock" },
    });

    const translated = translateChatResponseToResponses(
      {
        id: "chatcmpl-123",
        object: "chat.completion",
        created: 1_777_777_700,
        model: "model-x-v2",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Done." },
          },
        ],
        usage: {
          prompt_tokens: 20,
          completion_tokens: 4,
          total_tokens: 24,
          prompt_tokens_details: { cached_tokens: 3 },
          completion_tokens_details: { reasoning_tokens: 1 },
        },
      },
      { request, now: () => new Date("2026-08-29T12:00:00.000Z") },
    );

    expect(translated.terminalEventType).toBe("response.completed");
    expect(translated.response).toMatchObject({
      id: expect.stringMatching(/^resp_[a-f0-9]{24}$/),
      object: "response",
      created_at: 1_777_777_700,
      completed_at: 1_788_004_800,
      status: "completed",
      model: "model-x-v2",
      max_output_tokens: 256,
      temperature: 0.3,
      top_p: 0.8,
      metadata: { project: "ProviderDock" },
      output: [
        {
          id: expect.stringMatching(/^msg_[a-f0-9]{24}$/),
          type: "message",
          status: "completed",
          role: "assistant",
          content: [
            { type: "output_text", text: "Done.", annotations: [], logprobs: [] },
          ],
        },
      ],
      usage: {
        input_tokens: 20,
        input_tokens_details: { cached_tokens: 3 },
        output_tokens: 4,
        output_tokens_details: { reasoning_tokens: 1 },
        total_tokens: 24,
      },
      providerdock: {
        upstream_response_id: "chatcmpl-123",
        translated_from: "chat.completion",
      },
    });
  });

  it("maps reasoning plus function/custom calls with stable call associations", () => {
    const request = canonicalRequest({
      model: "tools",
      input: "Use tools",
      tools: [
        {
          type: "function",
          name: "lookup",
          parameters: { type: "object", properties: { key: { type: "string" } } },
        },
        { type: "custom", name: "apply_patch", format: { type: "text" } },
      ],
    });

    const translated = translateChatResponseToResponses(
      {
        id: "chat-tools",
        model: "tools",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              reasoning_content: "I will use two tools.",
              tool_calls: [
                {
                  id: "call-lookup",
                  type: "function",
                  function: { name: "lookup", arguments: '{"key":"x"}' },
                },
                {
                  id: "call-patch",
                  type: "function",
                  function: {
                    name: "apply_patch",
                    arguments: JSON.stringify({ input: "*** Begin Patch" }),
                  },
                },
              ],
            },
          },
        ],
      },
      { request },
    );

    expect(translated.terminalEventType).toBe("response.completed");
    expect(translated.response.output).toEqual([
      expect.objectContaining({
        type: "reasoning",
        status: "completed",
        summary: [{ type: "summary_text", text: "I will use two tools." }],
      }),
      expect.objectContaining({
        type: "function_call",
        status: "completed",
        call_id: "call-lookup",
        name: "lookup",
        arguments: '{"key":"x"}',
      }),
      expect.objectContaining({
        type: "custom_tool_call",
        status: "completed",
        call_id: "call-patch",
        name: "apply_patch",
        input: "*** Begin Patch",
      }),
    ]);
  });

  it("preserves refusal content parts without converting them to output text", () => {
    const request = canonicalRequest({ model: "safe-model", input: "Unsafe request" });
    const translated = translateChatResponseToResponses(
      {
        choices: [
          {
            finish_reason: "stop",
            message: {
              role: "assistant",
              content: [
                { type: "refusal", refusal: "I cannot help with that." },
              ],
            },
          },
        ],
      },
      { request },
    );

    expect(translated.response.output).toEqual([
      expect.objectContaining({
        type: "message",
        content: [{ type: "refusal", refusal: "I cannot help with that." }],
      }),
    ]);
  });

  it("synthesizes a stable call ID for legacy function_call responses", () => {
    const request = canonicalRequest({
      model: "legacy",
      input: "Call it",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    const payload = {
      id: "legacy-chat",
      choices: [
        {
          finish_reason: "function_call",
          message: {
            role: "assistant",
            function_call: { name: "lookup", arguments: '{"key":"x"}' },
          },
        },
      ],
    };

    const first = translateChatResponseToResponses(payload, { request });
    const second = translateChatResponseToResponses(payload, { request });
    expect(first.response.output).toEqual(second.response.output);
    expect(first.response.output).toEqual([
      expect.objectContaining({
        type: "function_call",
        call_id: expect.stringMatching(/^call_[a-f0-9]{24}$/),
      }),
    ]);
  });

  it("marks length and content-filter finishes as incomplete", () => {
    const request = canonicalRequest({ model: "model-x", input: "Long answer" });
    for (const [finishReason, expectedReason] of [
      ["length", "max_output_tokens"],
      ["content_filter", "content_filter"],
    ] as const) {
      const translated = translateChatResponseToResponses(
        {
          choices: [
            {
              finish_reason: finishReason,
              message: { role: "assistant", content: "Partial" },
            },
          ],
        },
        { request },
      );
      expect(translated).toMatchObject({
        terminalEventType: "response.incomplete",
        response: {
          status: "incomplete",
          incomplete_details: { reason: expectedReason },
        },
      });
    }
  });

  it("never reports success without completed output and a supported finish reason", () => {
    const request = canonicalRequest({ model: "model-x", input: "Hello" });
    const translated = translateChatResponseToResponses(
      {
        choices: [
          { finish_reason: null, message: { role: "assistant", content: null } },
        ],
      },
      { request },
    );

    expect(translated).toMatchObject({
      terminalEventType: "response.failed",
      response: {
        status: "failed",
        error: { code: "INCOMPLETE_RESPONSE" },
        output: [],
      },
    });
  });

  it.each([
    {
      payload: { choices: [] },
      message: /exactly one choice/i,
    },
    {
      payload: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-1",
                  type: "function",
                  function: { name: "lookup", arguments: "{bad-json" },
                },
              ],
            },
          },
        ],
      },
      message: /malformed JSON arguments/i,
    },
    {
      payload: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "same",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
                {
                  id: "same",
                  type: "function",
                  function: { name: "lookup", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      message: /duplicated tool call id/i,
    },
    {
      payload: {
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              tool_calls: [
                {
                  id: "call-unknown",
                  type: "function",
                  function: { name: "unknown", arguments: "{}" },
                },
              ],
            },
          },
        ],
      },
      message: /unknown tool/i,
    },
  ])("rejects malformed Chat success payloads", ({ payload, message }) => {
    const request = canonicalRequest({
      model: "model-x",
      input: "Hello",
      tools: [{ type: "function", name: "lookup", parameters: { type: "object" } }],
    });
    expect(() => translateChatResponseToResponses(payload, { request })).toThrow(message);
    try {
      translateChatResponseToResponses(payload, { request });
    } catch (error) {
      expect(error).toBeInstanceOf(ChatToResponsesTranslationError);
      expect(error).toMatchObject({ type: "PROTOCOL_ERROR" });
    }
  });

  it("normalizes native Responses-like usage aliases without negative values", () => {
    expect(
      normalizeChatUsage({
        input_tokens: 7,
        output_tokens: 3,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 1 },
      }),
    ).toEqual({
      input_tokens: 7,
      input_tokens_details: { cached_tokens: 2 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 1 },
      total_tokens: 10,
    });
  });
});

function canonicalRequest(payload: Record<string, unknown>) {
  return translateResponsesRequestToChat(payload, {
    requestId: "req-test",
    sessionId: "session-test",
    now: () => new Date("2026-08-29T00:00:00.000Z"),
  }).canonical;
}
