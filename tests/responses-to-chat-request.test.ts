import { describe, expect, it } from "vitest";
import {
  ResponsesToChatTranslationError,
  translateResponsesRequestToChat,
} from "../src/index.js";

describe("translateResponsesRequestToChat", () => {
  it("normalizes text, instructions and model parameters through the canonical protocol", () => {
    const translated = translateResponsesRequestToChat(
      {
        model: "model-x",
        instructions: "Work carefully.",
        input: "Hello",
        stream: true,
        temperature: 0.2,
        top_p: 0.9,
        max_output_tokens: 512,
        parallel_tool_calls: false,
        reasoning: { effort: "high", summary: "auto" },
        text: {
          verbosity: "low",
          format: {
            type: "json_schema",
            name: "answer",
            schema: { type: "object", properties: { ok: { type: "boolean" } } },
            strict: true,
          },
        },
        metadata: { project: "ProviderDock" },
        include: ["reasoning.encrypted_content"],
        truncation: "disabled",
        provider_extension: { trace: true },
      },
      { requestId: "req-1", sessionId: "session-1" },
    );

    expect(translated.canonical).toMatchObject({
      requestId: "req-1",
      sessionId: "session-1",
      model: "model-x",
      stream: true,
      parameters: {
        temperature: 0.2,
        topP: 0.9,
        maxOutputTokens: 512,
        parallelToolCalls: false,
        reasoningEffort: "high",
        reasoningSummary: "auto",
        verbosity: "low",
        metadata: { project: "ProviderDock" },
      },
      extensions: {
        "providerdock.raw_request_fields": { provider_extension: { trace: true } },
        "openai.responses": {
          include: ["reasoning.encrypted_content"],
          truncation: "disabled",
        },
      },
    });
    expect(translated.chatRequest).toMatchObject({
      model: "model-x",
      messages: [
        { role: "system", content: "Work carefully." },
        { role: "user", content: "Hello" },
      ],
      stream: true,
      stream_options: { include_usage: true },
      max_completion_tokens: 512,
      reasoning_effort: "high",
      verbosity: "low",
      response_format: {
        type: "json_schema",
        json_schema: { name: "answer", strict: true },
      },
    });
    expect(translated.toolHistory).toEqual([]);
  });

  it("translates image input plus function and custom tool definitions", () => {
    const translated = translateResponsesRequestToChat({
      model: "vision-tools",
      input: [
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this." },
            { type: "input_image", image_url: "data:image/png;base64,AAAA", detail: "high" },
          ],
        },
      ],
      tools: [
        {
          type: "function",
          name: "lookup",
          description: "Look up a value",
          parameters: {
            type: "object",
            properties: { key: { type: "string" } },
            required: ["key"],
          },
          strict: true,
        },
        {
          type: "custom",
          name: "apply_patch",
          description: "Apply a patch",
          format: { type: "grammar", syntax: "lark", definition: "start: /.+/" },
        },
      ],
      tool_choice: { type: "custom", name: "apply_patch" },
    });

    expect(translated.chatRequest.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "Inspect this." },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,AAAA", detail: "high" },
          },
        ],
      },
    ]);
    expect(translated.chatRequest.tools).toEqual([
      {
        type: "function",
        function: {
          name: "lookup",
          description: "Look up a value",
          parameters: expect.objectContaining({ type: "object" }),
          strict: true,
        },
      },
      {
        type: "function",
        function: {
          name: "apply_patch",
          description: "Apply a patch",
          parameters: {
            type: "object",
            properties: { input: { type: "string" } },
            required: ["input"],
            additionalProperties: false,
          },
        },
      },
    ]);
    expect(translated.chatRequest.tool_choice).toEqual({
      type: "function",
      function: { name: "apply_patch" },
    });
  });

  it("preserves parallel tool history and validates every result association", () => {
    const translated = translateResponsesRequestToChat(
      {
        model: "tool-model",
        input: [
          { type: "message", role: "user", content: "Do both." },
          {
            type: "reasoning",
            summary: [{ type: "summary_text", text: "I need two tools." }],
            encrypted_content: "opaque-reasoning",
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Working." }],
          },
          {
            type: "function_call",
            id: "fc-a",
            call_id: "call-a",
            name: "lookup",
            arguments: '{"key":"a"}',
          },
          {
            type: "custom_tool_call",
            id: "ctc-b",
            call_id: "call-b",
            name: "apply_patch",
            input: "*** Begin Patch",
          },
          { type: "function_call_output", call_id: "call-a", output: "A" },
          { type: "custom_tool_call_output", call_id: "call-b", output: "patched" },
          { type: "message", role: "user", content: "Now summarize." },
        ],
      },
      {
        requestId: "req-tools",
        sessionId: "session-tools",
        now: () => new Date("2026-08-29T12:00:00.000Z"),
      },
    );

    expect(translated.chatRequest.messages).toEqual([
      { role: "user", content: "Do both." },
      {
        role: "assistant",
        content: "Working.",
        reasoning_content: "I need two tools.",
        providerdock_encrypted_reasoning: "opaque-reasoning",
        tool_calls: [
          {
            id: "call-a",
            type: "function",
            function: { name: "lookup", arguments: '{"key":"a"}' },
          },
          {
            id: "call-b",
            type: "function",
            function: {
              name: "apply_patch",
              arguments: JSON.stringify({ input: "*** Begin Patch" }),
            },
          },
        ],
      },
      { role: "tool", tool_call_id: "call-a", content: "A" },
      { role: "tool", tool_call_id: "call-b", content: "patched" },
      { role: "user", content: "Now summarize." },
    ]);
    expect(translated.toolHistory).toHaveLength(2);
    expect(translated.toolHistory).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "call-a",
          requestId: "req-tools",
          sessionId: "session-tools",
          toolName: "lookup",
          status: "RESOLVED",
          createdAt: "2026-08-29T12:00:00.000Z",
          resolvedAt: "2026-08-29T12:00:00.000Z",
          argumentsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          resultHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      ]),
    );
  });

  it.each([
    {
      name: "unresolved call",
      input: [
        {
          type: "function_call",
          call_id: "call-pending",
          name: "write_file",
          arguments: "{}",
        },
      ],
      message: /unresolved tool call.*automatic continuation was blocked/i,
    },
    {
      name: "orphan result",
      input: [{ type: "function_call_output", call_id: "call-missing", output: "done" }],
      message: /does not reference an earlier tool call/i,
    },
    {
      name: "duplicate call",
      input: [
        { type: "function_call", call_id: "call-1", name: "tool", arguments: "{}" },
        { type: "function_call", call_id: "call-1", name: "tool", arguments: "{}" },
      ],
      message: /duplicated/i,
    },
    {
      name: "mismatched result type",
      input: [
        { type: "function_call", call_id: "call-1", name: "tool", arguments: "{}" },
        { type: "custom_tool_call_output", call_id: "call-1", output: "done" },
      ],
      message: /type does not match/i,
    },
  ])("blocks unsafe tool history: $name", ({ input, message }) => {
    expect(() => translateResponsesRequestToChat({ model: "model-x", input })).toThrow(message);
    try {
      translateResponsesRequestToChat({ model: "model-x", input });
    } catch (error) {
      expect(error).toMatchObject({ type: "PROTOCOL_ERROR" });
    }
  });

  it.each([
    {
      payload: { model: "x", input: "hi", previous_response_id: "resp-old" },
      message: /stateful response store/i,
    },
    {
      payload: { model: "x", input: "hi", background: true },
      message: /background/i,
    },
    {
      payload: { model: "x", input: "hi", tools: [{ type: "web_search" }] },
      message: /web_search.*cannot be represented/i,
    },
  ])("rejects unsupported semantics instead of dropping them", ({ payload, message }) => {
    expect(() => translateResponsesRequestToChat(payload)).toThrow(message);
  });

  it("uses typed validation errors for malformed known fields", () => {
    expect(() =>
      translateResponsesRequestToChat({ model: "x", input: "hi", metadata: { bad: 1 } }),
    ).toThrow(ResponsesToChatTranslationError);
    try {
      translateResponsesRequestToChat({ model: "x", input: "hi", max_output_tokens: 0 });
    } catch (error) {
      expect(error).toMatchObject({ type: "INVALID_REQUEST" });
    }
  });
});
