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

Returns local bridge state only: provider ID, uptime and active request count. It does not
perform paid inference or contact the provider.

### `GET /v1/models`

Returns both model envelopes needed by current clients:

- OpenAI-compatible `data` entries;
- top-level Codex `models` capability records.

Capability claims are supplied as `BridgeModelDefinition` values. Callers should populate
them from probe/fixture evidence rather than infer unsupported provider behavior.

### `POST /v1/responses`

Builds the upstream URL, query authentication and headers through the shared provider HTTP
request builder. There is exactly one upstream attempt; the bridge performs no hidden
retry or replay.

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
- retains `[DONE]` until terminal handling is complete;
- reconstructs an empty `response.completed.output` from prior
  `response.output_item.done` events;
- synthesizes completion after an early close only when at least one output item is done
  and no output item remains pending;
- otherwise emits `response.failed` with `INCOMPLETE_RESPONSE`;
- aborts the upstream request when the Codex connection closes;
- relays only request IDs, processing time, retry and rate-limit response headers.

Malformed JSON/SSE and contradictory event sequences never become a synthetic success.
Raw upstream error bodies are not reflected to the client, preventing an upstream echo
from disclosing provider credentials. Normalized errors retain the HTTP status and one of
the specification's internal error codes.

## Current boundary

This component currently provides native Responses passthrough and safe transport
normalization. Responses↔Chat translation, canonical tool history, anti-replay state,
Claude Code routing remain separate roadmap blocks and must not be represented as already
supported. The Codex launcher now starts and stops this native bridge automatically for
AgentRouter and Responses profiles that require query authentication.
