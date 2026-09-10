# Claude Code Runtime (Phase 3)

ProviderDock runs Claude Code against supported Anthropic Messages and OpenAI
Chat providers through a managed loopback Anthropic Messages bridge (spec
§5.2, §27, §46 Phase 3).

## Launch

```text
providerdock launch claude --provider ID --model MODEL --project DIRECTORY
providerdock launch claude --logical-model ID --project DIRECTORY
providerdock launch claude --prompt-profile ID --project DIRECTORY
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

For `--logical-model`, `ANTHROPIC_MODEL` contains the logical ID. The bridge
selects an enabled priority route, rewrites the request model to that route's
provider-specific ID, and keeps the successful route sticky for the runtime
session.

For `--prompt-profile`, the bridge prepends the stored instructions to the
Anthropic `system` prompt without creating or editing project files. Profile
Claude flags are applied only to the child process; the profile's physical or
logical routing preference determines the model exposed in `ANTHROPIC_MODEL`.

## Bridge modes

The bridge picks its mode from the provider profile `apiType`:

| Provider apiType             | Mode               | Behaviour |
|------------------------------|--------------------|-----------|
| `anthropic-messages`         | `native-anthropic` | Verbatim relay. Provider auth is injected from the secret store; `anthropic-version` / `anthropic-beta` headers from Claude Code are preserved (`anthropic-version` defaults to `2023-06-01`). The child's loopback token is never forwarded upstream. |
| `openai-chat-completions` | `openai-chat` | Always uses Chat translation, including GoRouter and Claude-named models. |
| `openai-responses` | `openai-responses` | Translates Anthropic Messages requests, JSON responses and SSE while preserving message roles and tool-call IDs. |
| `auto` | Native, Chat or Responses | Uses recent successful traffic, fresh diagnostics and provider metadata for the exact model. Definitive 404/405/501 endpoint rejection may select another representable OpenAI protocol before output. The result is cached per provider/model. |

An accepted response, timeout, authentication error, rate limit or partial stream never
triggers another generation attempt. Features that cannot be represented across the
selected protocols fail explicitly instead of being silently dropped.

## Logical-model fallback

A logical-model bridge may mix native Anthropic routes with OpenAI Chat routes.
Fallback is attempted only before client-visible output and only when the
failure boundary is proven safe:

- connection establishment was refused/unreachable before acceptance;
- the provider explicitly rejected the request (4xx, 501, or 503); or
- retained `tool_use`/`tool_result` history proves a complete continuation.

Ambiguous transport failures, response-header timeouts, gateway errors such as
502, partial streams, and unresolved tool history block fallback. Once an
upstream response is selected, translation or streaming failures never cause a
second route to receive the turn.

Successful responses identify the selected route with
`x-providerdock-provider-id`; switches also include
`x-providerdock-fallback-*` headers. `/health` keeps `provider_id` fixed to the
managed bridge's primary identity and reports `active_provider_id`,
`logical_model_id`, the sticky fallback snapshot, and the last notification.
The launcher prints each switch to stderr.

## Translation details (OpenAI modes)

- `system` (string or blocks) → system message;
- `tool_use` blocks → `tool_calls`; `tool_result` blocks → `role: "tool"` messages;
- tools `input_schema` → `parameters`; `tool_choice` `auto/any/none/tool` mapped;
- `finish_reason` → `stop_reason`: `tool_calls→tool_use`, `length→max_tokens`,
  `content_filter→refusal`, `stop→end_turn`;
- usage: `prompt_tokens→input_tokens`, `completion_tokens→output_tokens`;
- Responses routes preserve ordered user/assistant history plus function calls and
  function results instead of flattening assistant state into a new user prompt;
- Responses terminal snapshots add only text not already emitted as stream deltas;
- Claude-model profiles in `auto` mode first try the native Messages route so genuine
  thinking signatures are preserved; a definitively unsupported native route
  falls back to Chat Completions for that provider/model for the rest of the session;
- unsigned Chat `reasoning_content` is never forged into an Anthropic thinking
  block; it is ignored when normal text/tools exist and used as plain text only
  when it is the provider's sole output;
- assistant thinking history is preserved as `reasoning_content`; explicit
  Anthropic `thinking`/`output_config` controls are omitted on the Chat fallback,
  while redacted thinking remains rejected because its hidden content cannot
  be represented;
- unknown tools, malformed JSON arguments, missing finish reasons, and
  conflicting stream identity are terminal protocol errors;
- parallel Chat tool calls are buffered until every name, ID, and JSON
  argument is valid, then emitted as complete Anthropic tool blocks;
- if a chat provider ignores `stream: true`, the bridge synthesizes a complete
  Anthropic stream from the JSON response.

Errors are always returned in the Anthropic error shape
(`{"type":"error","error":{"type":"authentication_error",...}}`) with the
normalized ProviderDock type attached in a `providerdock` block. In native
mode ProviderDock returns an Anthropic-shaped normalized error with only a
bounded, redacted diagnostic extracted from the provider body; arbitrary
provider error fields are never copied to the client.

## Anti-replay

Every `/v1/messages` turn passes the TurnLedger (see `docs/anti-replay.md`)
using the complete semantic request body; `tool_use`/`tool_result` blocks feed
tool-integrity checks and upstream tool blocks are recorded before delivery.
The managed launcher stores the non-secret ledger under a random Claude runtime
session ID and removes it only after the bridge has stopped on a clean exit.
Blocked turns get HTTP 409 with the block code in
`x-providerdock-turn-block`, without any upstream contact.

## Generic Anthropic provider adapter

Profiles with `apiType: anthropic-messages` (or `adapterId:
generic-anthropic`) use the `generic-anthropic` adapter. Model discovery
targets the Anthropic `/v1/models` shape and always sends `anthropic-version`
(default `2023-06-01`) unless the profile pins one. Authentication is
typically `auth: { kind: "header", headerName: "x-api-key", secretRef: ... }`.
