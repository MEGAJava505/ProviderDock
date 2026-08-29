import { describe, expect, it } from "vitest";
import {
  ResponsesStreamProtocolError,
  ResponsesStreamState,
} from "../src/index.js";

describe("ResponsesStreamState", () => {
  it("repairs an empty completed response from completed output items", () => {
    const state = new ResponsesStreamState({ now: () => 5_000 });
    state.observe({
      type: "response.output_item.added",
      sequence_number: 1,
      output_index: 0,
      item: { id: "msg-1", type: "message", status: "in_progress" },
    });
    state.observe({
      type: "response.output_item.done",
      sequence_number: 2,
      output_index: 0,
      item: { id: "msg-1", type: "message", status: "completed", content: [] },
    });

    const terminal = state.observe({
      type: "response.completed",
      sequence_number: 3,
      response: { id: "resp-1", status: "completed", output: [] },
    });

    expect(terminal).toMatchObject({
      kind: "forward",
      event: {
        response: {
          output: [{ id: "msg-1", status: "completed" }],
        },
      },
    });
    expect(state.buildTerminalRepair()).toBeUndefined();
  });

  it("synthesizes success only when every observed output item is completed", () => {
    const complete = new ResponsesStreamState({
      now: () => 10_000,
      responseIdFactory: () => "resp-generated",
    });
    complete.observe({
      type: "response.output_item.done",
      sequence_number: 4,
      output_index: 0,
      item: { id: "msg", type: "message", status: "completed" },
    });

    expect(complete.buildTerminalRepair()).toMatchObject({
      type: "response.completed",
      sequence_number: 5,
      response: { id: "resp-generated", status: "completed" },
    });

    const pending = new ResponsesStreamState({ responseIdFactory: () => "resp-pending" });
    pending.observe({
      type: "response.output_item.added",
      sequence_number: 0,
      output_index: 0,
      item: { id: "call", type: "function_call", status: "in_progress" },
    });
    expect(pending.buildTerminalRepair()).toMatchObject({
      type: "response.failed",
      response: {
        status: "failed",
        error: { code: "INCOMPLETE_RESPONSE" },
      },
    });
  });

  it("suppresses exact duplicates and rejects conflicting sequence reuse", () => {
    const state = new ResponsesStreamState();
    const event = { type: "response.created", sequence_number: 0, response: { id: "r" } };

    expect(state.observe(event).kind).toBe("forward");
    expect(state.observe(event).kind).toBe("duplicate");
    expect(() =>
      state.observe({ type: "response.created", sequence_number: 0, response: { id: "other" } }),
    ).toThrow(ResponsesStreamProtocolError);
  });

  it("rejects a completed terminal event while an output item is pending", () => {
    const state = new ResponsesStreamState();
    state.observe({
      type: "response.output_item.added",
      sequence_number: 0,
      output_index: 0,
      item: { id: "call", type: "function_call", status: "in_progress" },
    });

    expect(() =>
      state.observe({
        type: "response.completed",
        sequence_number: 1,
        response: { id: "resp", status: "completed", output: [] },
      }),
    ).toThrow(ResponsesStreamProtocolError);
    expect(state.buildTerminalRepair({ forceFailure: true })).toMatchObject({
      type: "response.failed",
      response: { error: { code: "INCOMPLETE_RESPONSE" } },
    });
  });
});
