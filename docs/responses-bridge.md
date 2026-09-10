# Native Responses bridge

`ResponsesBridgeServer` is the private, per-session compatibility boundary for providers
that already speak the OpenAI Responses protocol but cannot be connected to Codex
directly—for example, because authentication uses a secret query parameter. It is also
the transport foundation for later Chat Completions and Anthropic translators.

## Network and lifecycle contract

- The server always binds to `127.0.0.1` and asks the OS for a random free port.
- It never listens on `0.0.0.0` and is not a permanent daemon.
- `start()` and `stop()` are idempotent. Stopping aborts active upstream requests and
  closes bridge connections.
- The returned `baseUrl` ends in `/v1` and can be supplied to an isolated Codex runtime
  profile.
- Provider credentials are resolved from `SecretStore` only for the upstream request.
  Client-supplied authorization is never forwarded.
- Provider adapter preparation runs before requests, so scoped fixes such as the
  AgentRouter client identity headers are shared with discovery and direct routes.

## Endpoints

### `GET /health`

Returns local bridge state only: stable bridge provider ID, uptime and active
request count. A logical-model bridge additionally reports the logical-model ID,
active provider ID, sticky fallback snapshot and last fallback notification.
It does not perform paid inference or contact the provider.

### `GET /v1/models`

Returns both model envelopes needed by current clients:

- OpenAI-compatible `data` entries;
- top-level Codex `models` capability records.

Capability claims are supplied as `BridgeModelDefinition` values. Callers should populate
them from probe/fixture evidence rather than infer unsupported provider behavior.

### `POST /v1/responses`

Builds the upstream URL, query authentication and headers through the shared provider HTTP
request builder. Explicit protocol profiles make one upstream attempt. In `auto` mode,
a native Responses endpoint rejection with HTTP 404, 405 or 501 permits one Chat
Completions attempt on the same provider/model. An accepted Chat endpoint is remembered
per provider/model for that bridge session; this is endpoint detection, not proof of full
tool compatibility. No protocol fallback follows 401, 429, 502, timeout or partial output.
A logical-model bridge may try another configured route only after a verified
connection-establishment failure or explicit safe request rejection, before any
output is relayed. Unknown execution state, partial output and ambiguous tool
history block fallback instead of replaying the turn.

Non-streaming JSON is schema-checked before relay. When a client asks for streaming but a
provider safely returns one complete JSON Response, the bridge emits a terminal SSE event
and `[DONE]`.

## Streaming guarantees

The SSE decoder is incremental UTF-8 and recognizes events independently of network
chunks. It supports LF, CRLF and CR framing, multiline `data`, comments, event IDs and
retry fields. Event and body bounds prevent unbounded buffering.

The relay:

- forwards events as they arrive and emits loopback heartbeat comments;
- suppresses exact duplicate sequence/ID events and rejects conflicting reuse;
- finishes immediately after a validated terminal Response, even without EOF or `[DONE]`;
- reconstructs an empty `response.completed.output` from prior
  `response.output_item.done` events;
- emits `response.failed` with `INCOMPLETE_RESPONSE` after an early close without a
  terminal Response, including when observed output items are done;
- normalizes native JSON/SSE usage with `total_tokens = input_tokens + output_tokens`;
  missing/invalid token totals remain unknown (`usage: null`), not zero;
- aborts the upstream request when the Codex connection closes;
- relays only request IDs, processing time, retry and rate-limit response headers.

Malformed JSON/SSE and contradictory event sequences never become a synthetic success.
Raw upstream error bodies are not reflected to the client, preventing an upstream echo
from disclosing provider credentials. Normalized errors retain the HTTP status and one of
the specification's internal error codes.

## Current boundary

This component provides native Responses passthrough plus canonical Chat Completions
request/JSON/SSE translation. It also executes priority-ordered logical-model
routes for managed Codex sessions, with sticky safe fallback and route diagnostics.
A session-scoped cross-request TurnLedger blocks unsafe replay, records completed
upstream tool calls before client delivery, and atomically persists non-secret
safety state across bridge reconstruction. Claude Code uses its own managed
Anthropic Messages bridge documented in `docs/claude-code.md`. The Codex launcher
starts and stops this bridge for every `auto` route, including ordinary Responses
profiles. Explicit direct/external routes remain outside this normalization boundary.
