import { describe, expect, it } from "vitest";
import {
  TurnLedger,
  extractResponsesDeliveredToolCalls,
  extractResponsesTurnSignature,
  type TurnSignature,
} from "../src/index.js";

function signature(overrides: Partial<TurnSignature> = {}): TurnSignature {
  return {
    fingerprint: "fp-1",
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe("TurnLedger", () => {
  it("blocks automatic replay after a completed turn", () => {
    const ledger = new TurnLedger();
    const first = ledger.admit(signature());
    expect(first.decision).toBe("accepted");
    if (first.decision !== "accepted") return;
    ledger.complete(first.token);

    const replay = ledger.admit(signature());
    expect(replay).toMatchObject({ decision: "blocked", code: "TURN_ALREADY_COMPLETED" });
  });

  it("blocks duplicate in-flight turns", () => {
    const ledger = new TurnLedger();
    expect(ledger.admit(signature()).decision).toBe("accepted");
    expect(ledger.admit(signature())).toMatchObject({
      decision: "blocked",
      code: "TURN_IN_FLIGHT",
    });
  });

  it("allows safe retry before streaming but blocks replay after partial stream", () => {
    const ledger = new TurnLedger();

    const first = ledger.admit(signature());
    if (first.decision !== "accepted") throw new Error("expected acceptance");
    ledger.fail(first.token);
    const safeRetry = ledger.admit(signature());
    expect(safeRetry.decision).toBe("accepted");
    if (safeRetry.decision !== "accepted") return;

    ledger.markStreamStarted(safeRetry.token);
    ledger.incomplete(safeRetry.token);
    expect(ledger.admit(signature())).toMatchObject({
      decision: "blocked",
      code: "UNSAFE_REPLAY",
    });
  });

  it("allows an explicit incomplete retry only when no output or tool activity occurred", () => {
    const ledger = new TurnLedger();
    const first = ledger.admit(signature({ fingerprint: "fp-incomplete-no-output" }));
    if (first.decision !== "accepted") throw new Error("expected acceptance");
    ledger.incomplete(first.token);
    expect(
      ledger.admit(signature({ fingerprint: "fp-incomplete-no-output" })).decision,
    ).toBe("accepted");
  });

  it("detects the recursive tool loop: resolved call presented as pending again", () => {
    const ledger = new TurnLedger();
    const call = { callId: "call-1", name: "write_file", argumentsHash: "hash-a" };

    const withResult = ledger.admit(
      signature({
        fingerprint: "fp-resolved",
        toolCalls: [call],
        toolResults: [{ callId: "call-1", outputHash: "out-a" }],
      }),
    );
    expect(withResult.decision).toBe("accepted");
    if (withResult.decision !== "accepted") return;
    ledger.complete(withResult.token);

    const loop = ledger.admit(signature({ fingerprint: "fp-loop", toolCalls: [call] }));
    expect(loop).toMatchObject({ decision: "blocked", code: "TOOL_LOOP_DETECTED" });
  });

  it("records upstream-delivered calls before execution and blocks their replay", () => {
    const ledger = new TurnLedger();
    const delivered = {
      callId: "call-upstream",
      name: "write_file",
      argumentsHash: "args-hash",
    };
    const first = ledger.admit(signature({ fingerprint: "fp-upstream" }));
    if (first.decision !== "accepted") throw new Error("expected acceptance");
    ledger.recordDeliveredToolCalls(first.token, [delivered]);
    ledger.complete(first.token);

    const continuation = ledger.admit(
      signature({
        fingerprint: "fp-continuation",
        toolCalls: [delivered],
        toolResults: [{ callId: delivered.callId, outputHash: "result-hash" }],
      }),
    );
    expect(continuation.decision).toBe("accepted");
    if (continuation.decision !== "accepted") return;
    ledger.complete(continuation.token);

    const next = ledger.admit(signature({ fingerprint: "fp-next" }));
    if (next.decision !== "accepted") throw new Error("expected acceptance");
    expect(() => ledger.recordDeliveredToolCalls(next.token, [delivered])).toThrow(
      /already-resolved tool call/i,
    );
  });

  it("rejects tool results without a matching call and conflicting duplicates", () => {
    const ledger = new TurnLedger();
    expect(
      ledger.admit(
        signature({ toolResults: [{ callId: "ghost", outputHash: "x" }] }),
      ),
    ).toMatchObject({ decision: "blocked", code: "TOOL_RESULT_UNMATCHED" });

    const call = { callId: "call-2", name: "read_file", argumentsHash: "hash-b" };
    const admitted = ledger.admit(
      signature({
        fingerprint: "fp-2",
        toolCalls: [call],
        toolResults: [{ callId: "call-2", outputHash: "out-1" }],
      }),
    );
    expect(admitted.decision).toBe("accepted");
    if (admitted.decision !== "accepted") return;
    ledger.complete(admitted.token);

    expect(
      ledger.admit(
        signature({
          fingerprint: "fp-3",
          toolCalls: [call],
          toolResults: [{ callId: "call-2", outputHash: "out-CONFLICT" }],
        }),
      ),
    ).toMatchObject({ decision: "blocked", code: "TOOL_RESULT_CONFLICT" });

    expect(
      ledger.admit(
        signature({
          fingerprint: "fp-4",
          toolCalls: [{ ...call, argumentsHash: "hash-DIFFERENT" }],
        }),
      ),
    ).toMatchObject({ decision: "blocked", code: "TOOL_CALL_CONFLICT" });
  });

  it("fails closed when bounded turn or tool-call capacity is exhausted", () => {
    const turns = new TurnLedger({ maxTurnRecords: 1 });
    expect(turns.admit(signature({ fingerprint: "active" })).decision).toBe("accepted");
    expect(turns.admit(signature({ fingerprint: "overflow" }))).toMatchObject({
      decision: "blocked",
      code: "LEDGER_CAPACITY_EXCEEDED",
    });

    const completed = new TurnLedger({ maxTurnRecords: 1 });
    const completedTurn = completed.admit(signature({ fingerprint: "completed" }));
    if (completedTurn.decision !== "accepted") throw new Error("expected acceptance");
    completed.complete(completedTurn.token);
    expect(completed.admit(signature({ fingerprint: "next" }))).toMatchObject({
      decision: "blocked",
      code: "LEDGER_CAPACITY_EXCEEDED",
    });
    expect(completed.admit(signature({ fingerprint: "completed" }))).toMatchObject({
      decision: "blocked",
      code: "TURN_ALREADY_COMPLETED",
    });

    const tools = new TurnLedger({ maxToolCallRecords: 1 });
    const first = tools.admit(
      signature({
        fingerprint: "tool-1",
        toolCalls: [{ callId: "call-1", name: "one", argumentsHash: "hash-1" }],
      }),
    );
    expect(first.decision).toBe("accepted");
    expect(
      tools.admit(
        signature({
          fingerprint: "tool-2",
          toolCalls: [{ callId: "call-2", name: "two", argumentsHash: "hash-2" }],
        }),
      ),
    ).toMatchObject({ decision: "blocked", code: "LEDGER_CAPACITY_EXCEEDED" });
  });
});

describe("extractResponsesTurnSignature", () => {
  it("produces stable fingerprints and captures tool history", () => {
    const body = {
      model: "gpt-x",
      input: [
        { type: "message", role: "user", content: "hi" },
        { type: "function_call", call_id: "c1", name: "echo", arguments: "{\"a\":1}" },
        { type: "function_call_output", call_id: "c1", output: "done" },
      ],
      stream: true,
    };
    const a = extractResponsesTurnSignature(body);
    const b = extractResponsesTurnSignature({ ...body, stream: false });
    expect(a.fingerprint).toBe(b.fingerprint); // stream flag must not change identity
    expect(a.toolCalls).toHaveLength(1);
    expect(a.toolResults).toHaveLength(1);
    expect(a.toolCalls[0]).toMatchObject({ callId: "c1", name: "echo" });

    const c = extractResponsesTurnSignature({ ...body, model: "other" });
    expect(c.fingerprint).not.toBe(a.fingerprint);
    const d = extractResponsesTurnSignature({ ...body, max_output_tokens: 512 });
    expect(d.fingerprint).not.toBe(a.fingerprint);

    expect(
      extractResponsesDeliveredToolCalls({
        output: [
          {
            type: "function_call",
            call_id: "c1",
            name: "echo",
            arguments: '{"a":1}',
          },
        ],
      }),
    ).toEqual([expect.objectContaining({ callId: "c1", name: "echo" })]);
  });
});
