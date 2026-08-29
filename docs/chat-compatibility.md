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

## Current boundary

This checkpoint implements canonical input and Chat request generation only. Chat JSON and
SSE responses are not yet translated back to Responses, so the Codex launcher continues to
reject automatic Chat routing until the reverse translator and its terminal-state tests
are connected.
