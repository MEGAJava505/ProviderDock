# Anti-replay and tool integrity

The bridge admits every `/v1/responses` turn through a `TurnLedger`
(`src/core/state-machine/turn-ledger.ts`) before it is sent upstream. The
ledger implements the safety rules from spec sections 19–21.

## Turn admission

Each turn is fingerprinted from the semantically relevant request fields
(`model`, `instructions`, `input`, `tools`, `tool_choice`) using a stable,
key-sorted JSON hash. The `stream` flag is excluded so a streamed and a
non-streamed attempt of the same turn share one identity.

Admission decisions:

| Situation | Decision |
| --- | --- |
| New turn | accepted |
| Identical turn currently in flight | blocked `TURN_IN_FLIGHT` |
| Identical turn already `COMPLETED` | blocked `TURN_ALREADY_COMPLETED` |
| Previous attempt failed before any output or tool activity | accepted (safe retry) |
| Previous attempt streamed output or touched tools | blocked `UNSAFE_REPLAY` |

Blocked turns receive HTTP `409` with an explanatory message and the
`x-providerdock-turn-block` header; the upstream provider is never contacted.

## Turn lifecycle

```text
admit -> ACCEPTED -> (markStreamStarted) STREAMING
      -> COMPLETED | FAILED | CANCELLED | INCOMPLETE
```

The bridge marks the outcome in a `finally` block for every request:

- successful relay / JSON response → `COMPLETED`;
- client abort → `CANCELLED`;
- stream protocol failure or headers already sent → `INCOMPLETE`;
- anything else → `FAILED`.

Only `FAILED`/`CANCELLED` attempts without stream/tool activity are eligible
for automatic retry by the client.

## Tool call integrity

The ledger records every delivered tool call (`callId`, arguments hash) and
its resolution hash. Violations block the turn before upstream contact:

- `TOOL_RESULT_UNMATCHED` — a result references an unknown call;
- `TOOL_RESULT_CONFLICT` — an already-resolved call is re-resolved with a
  different output;
- `TOOL_CALL_CONFLICT` — the same `callId` reappears with different arguments;
- `TOOL_LOOP_DETECTED` — a resolved call is presented as pending again
  (the recursive tool loop observed with AgentRouter).

## Provider / Model Doctor

`providerdock doctor <provider-id> [--model MODEL] [--level 0|1|2|3]` runs
tiered diagnostics (spec sections 8, 32). Levels are strictly opt-in and never
run automatically:

- **0** — connectivity, auth, and model discovery only (no inference);
- **1** — plus one minimal `Reply exactly: OK` inference (default);
- **2** — plus a streaming check (SSE framing, duplicates, terminal event);
- **3** — plus a synthetic side-effect-free tool round-trip
  (`providerdock_echo`: tool call → fake result → continuation).

Deeper levels are skipped automatically when a prerequisite failed (for
example, no inference is attempted after a 401 at level 0), so no request
budget is wasted on providers that are already known to be broken.
