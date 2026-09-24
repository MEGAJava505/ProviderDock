import { describe, expect, it } from "vitest";
import { TurnLedger, extractAnthropicDeliveredToolCalls, extractAnthropicTurnSignature } from "../src/index.js";

const input = { file_path: "/project/example.txt", old_string: "before", new_string: "after" };
const callId = "toolu_edit-default";

function deliveredLedger(name: string, arguments_: Record<string, unknown>) {
  const ledger = new TurnLedger();
  const admitted = ledger.admit(extractAnthropicTurnSignature({ messages: [{ role: "user", content: "Edit file" }] }));
  if (admitted.decision !== "accepted") throw new Error("Expected initial admission");
  ledger.recordDeliveredToolCalls(admitted.token, extractAnthropicDeliveredToolCalls({
    content: [{ type: "tool_use", id: callId, name, input: arguments_ }],
  }));
  ledger.complete(admitted.token);
  // Existing persisted sessions must recover without discarding their safety ledger.
  return new TurnLedger({ initialSnapshot: ledger.snapshot() });
}

function continuation(name: string, arguments_: unknown) {
  return extractAnthropicTurnSignature({ messages: [
    { role: "assistant", content: [{ type: "tool_use", id: callId, name, input: arguments_ }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: callId, content: "File edited" }] },
  ] });
}

describe("Claude Edit history defaults", () => {
  it("accepts semantically equivalent object and JSON-string Edit arguments", () => {
    const admitted = deliveredLedger("Edit", input).admit(
      continuation("Edit", JSON.stringify(input)),
    );
    expect(admitted.decision).toBe("accepted");
  });

  it("accepts a completed Edit when Claude adds replace_all false", () => {
    expect(deliveredLedger("Edit", input).admit(continuation("Edit", { ...input, replace_all: false })).decision)
      .toBe("accepted");
  });

  it("accepts omitted false in history from a previously persisted explicit default", () => {
    expect(deliveredLedger("Edit", { ...input, replace_all: false }).admit(continuation("Edit", input)).decision)
      .toBe("accepted");
  });

  it.each([
    { ...input, replace_all: true },
    { ...input, replace_all: false, new_string: "different edit" },
    { ...input, replace_all: false, file_path: "/different/file.txt" },
    { ...input, replace_all: false, old_string: "different target" },
  ])("blocks a real Edit argument change: %j", (changed) => {
    expect(deliveredLedger("Edit", input).admit(continuation("Edit", changed)))
      .toMatchObject({ decision: "blocked", code: "TOOL_CALL_CONFLICT" });
  });

  it("keeps arbitrary tools strict even when they use a replace_all property", () => {
    expect(deliveredLedger("custom_edit", input).admit(continuation("custom_edit", { ...input, replace_all: false })))
      .toMatchObject({ decision: "blocked", code: "TOOL_CALL_CONFLICT" });
  });

  it("still blocks delivering an already resolved Edit again", () => {
    const ledger = deliveredLedger("Edit", input);
    const accepted = ledger.admit(continuation("Edit", input));
    if (accepted.decision !== "accepted") throw new Error("Expected continuation");
    expect(() => ledger.recordDeliveredToolCalls(accepted.token, extractAnthropicDeliveredToolCalls({
      content: [{ type: "tool_use", id: callId, name: "Edit", input }],
    }))).toThrow(/already-resolved/);
  });
});
