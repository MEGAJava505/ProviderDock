# Claude Code Runtime (Phase 3)

ProviderDock runs Claude Code against supported Anthropic Messages and OpenAI
Chat providers through a managed loopback Anthropic Messages bridge (spec
§5.2, §27, §46 Phase 3).

## Launch

```text
providerdock launch claude --provider ID --model MODEL --project DIRECTORY
```

Lifecycle:

1. A loopback-only bridge (`127.0.0.1`, random Fetch-allowed port) is started
   for the session and serves `POST /v1/messages` plus `GET /health`.
2. `claude` is spawned in the project directory with gateway variables set
   **only in the child process environment** (spec §27):
   - `ANTHROPIC_BASE_URL` — the bridge URL;
   - `ANTHROPIC_AUTH_TOKEN` — a random per-session loopback token validated by
     the bridge with a timing-safe comparison (real provider credentials never
     reach the child);
   - `ANTHROPIC_MODEL` — the selected model;
   - `ANTHROPIC_CUSTOM_HEADERS` — optional extra headers.
   Stale `ANTHROPIC_*` variables inherited from the shell are stripped so they
   cannot bypass the bridge. The global environment is never mutated.
3. When Claude Code exits, the bridge stops and the session is cleaned up.

## Bridge modes

The bridge picks its mode from the provider profile `apiType`:

| Provider apiType             | Mode               | Behaviour |
|------------------------------|--------------------|-----------|
| `anthropic-messages`         | `native-anthropic` | Verbatim relay. Provider auth is injected from the secret store; `anthropic-version` / `anthropic-beta` headers from Claude Code are preserved (`anthropic-version` defaults to `2023-06-01`). The child's loopback token is never forwarded upstream. |
| `auto`, `openai-chat-completions` | `openai-chat` | Protocol translation: Anthropic Messages request → OpenAI Chat Completions, then Chat response/SSE → strictly ordered Anthropic stream (`message_start → content_block_* → message_delta → message_stop`). |

Explicit `openai-responses` profiles are rejected until an
Anthropic↔Responses translator exists; silently routing them to
`/chat/completions` would contradict the configured capability.

Translation details (openai-chat mode):

- `system` (string or blocks) → system message;
- `tool_use` blocks → `tool_calls`; `tool_result` blocks → `role: "tool"` messages;
- tools `input_schema` → `parameters`; `tool_choice` `auto/any/none/tool` mapped;
- `finish_reason` → `stop_reason`: `tool_calls→tool_use`, `length→max_tokens`,
  `content_filter→refusal`, `stop→end_turn`;
- usage: `prompt_tokens→input_tokens`, `completion_tokens→output_tokens`;
- `reasoning_content` → `thinking` blocks;
- assistant thinking history is preserved as `reasoning_content`; explicit
  extended-thinking configuration and redacted thinking are rejected until
  they can be represented without guessing;
- unknown tools, malformed JSON arguments, missing finish reasons, and
  conflicting stream identity are terminal protocol errors;
- parallel Chat tool calls are buffered until every name, ID, and JSON
  argument is valid, then emitted as complete Anthropic tool blocks;
- if a chat provider ignores `stream: true`, the bridge synthesizes a complete
  Anthropic stream from the JSON response.

Errors are always returned in the Anthropic error shape
(`{"type":"error","error":{"type":"authentication_error",...}}`) with the
normalized ProviderDock type attached in a `providerdock` block. In native
mode the provider's own well-formed Anthropic error body is passed through.

## Anti-replay

Every `/v1/messages` turn passes the TurnLedger (see `docs/anti-replay.md`)
using the complete semantic request body; `tool_use`/`tool_result` blocks feed
tool-integrity checks and upstream tool blocks are recorded before delivery.
Blocked turns get HTTP 409 with the block code in
`x-providerdock-turn-block`, without any upstream contact.

## Generic Anthropic provider adapter

Profiles with `apiType: anthropic-messages` (or `adapterId:
generic-anthropic`) use the `generic-anthropic` adapter. Model discovery
targets the Anthropic `/v1/models` shape and always sends `anthropic-version`
(default `2023-06-01`) unless the profile pins one. Authentication is
typically `auth: { kind: "header", headerName: "x-api-key", secretRef: ... }`.
