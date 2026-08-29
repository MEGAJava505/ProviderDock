# Chat Completions compatibility

ProviderDock translates protocols through a canonical representation rather than adding
provider-specific `Responses → Provider X` conversions. The first translation slice
normalizes a Codex Responses request and emits an OpenAI Chat Completions request.

## Canonical request

The canonical model preserves:

- system, developer, user and assistant messages;
- text and URL/data-URL images;
- function and custom tool definitions;
- tool calls and tool results as ordered conversation items;
- reasoning summaries and encrypted reasoning metadata;
- common model parameters;
- unknown and Responses-only fields in explicit extension namespaces.

Unknown fields are not silently reinterpreted as provider fields. A later adapter may use
the preserved extension, while unsupported semantics produce a normalized error when they
would otherwise change request meaning.

## Request translation

Currently supported mappings include:

- Responses `instructions` to a system/developer message;
- string and structured message input;
- `input_text`, `output_text`, refusals and `input_image.image_url`;
- function tools and named tool choice;
- custom free-form tools represented as Chat functions with a required string `input`;
- JSON object and JSON schema response formats;
- output token limit, sampling, parallel tools, reasoning effort, verbosity, metadata,
  service tier, seed and usage-enabled streaming;
- parallel historical tool calls followed by their correctly associated tool results.

The translator intentionally rejects server-side tools such as `web_search`, file-ID image
references, background mode, conversation/`previous_response_id` references and tool
choice forms that cannot be represented safely yet.

## Tool-history barrier

Every historical call receives the specification fields `toolCallId`, request/session ID,
tool name, arguments hash, status, timestamps and result hash. Before any upstream request:

- duplicate call IDs are rejected;
- orphan or duplicate results are rejected;
- function/custom type mismatches are rejected;
- any call without a result blocks continuation.

This prevents an old unfinished tool call from being sent back to the model and triggering
a recursive execution. There is still no automatic retry or replay.

## Response and streaming translation

Chat JSON responses are converted to complete Responses envelopes with deterministic
response/output IDs, normalized usage, reasoning summaries, text/refusal content and
function/custom tool calls. Missing legacy call IDs are synthesized deterministically.
Malformed function arguments, duplicated call IDs and multiple choices are protocol
errors rather than partial success.

Chat SSE is decoded independently of transport chunks and emitted as Responses events as
soon as semantic deltas arrive. The translator produces output item/content/tool events,
monotonic sequence numbers and one validated terminal event. It maps length/content-filter
finishes to `response.incomplete`, and emits `response.failed` if `[DONE]` or the transport
ends without a supported finish reason. `[DONE]` is held until this validation completes.

The loopback bridge now selects `/chat/completions` for Chat profiles, and the Codex
launcher starts/stops that bridge automatically. A regression scenario verifies
`tool_call → tool_result → final answer` across two HTTP requests with the original call
ID and no hidden third request.

## Current boundary

Chat request, JSON response and SSE translation are connected. Server-side web search,
stateful `previous_response_id` storage, persistent cross-request tool-call replay ledger,
and Anthropic Messages translation remain later safety/compatibility blocks. Automatic
retry remains disabled while those stateful barriers are incomplete.
