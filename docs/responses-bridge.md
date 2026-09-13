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

The Codex launcher serializes the same top-level `{ "models": [...] }` document to a
per-session `model-catalog.json` and references it from the isolated profile with
`model_catalog_json`, so Codex does not need to guess metadata for a custom or logical
model ID.

Reasoning metadata is resolved by exact model ID. The official overlay snapshot dated
`2026-09-11` wins over stale gateway metadata; provider metadata is used only when no
exact official entry exists. The result is one of:

- `effort`: exact values, optional default, and source;
- `thinking-mode`: a mode such as forced thinking, without an effort enum;
- `unsupported`;
- `unknown`.

The bridge emits `supported_reasoning_levels` only for `effort`. It never turns
`unknown` into `low/medium/high`, and it does not turn `glm-5.3` into
`low/high/max`; that exact model is recorded as forced thinking. A caller may supply
an explicit `user-override`, but that exception is deliberate and remains visible in
the capability provenance.

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

## Provider-owned resource scope

Provider-owned reasoning items are tagged on every JSON and SSE response, including
nested `item`, `response.output`, translated Chat Completions events, and repaired
terminal events. The tag is derived from:

```text
[provider ID, normalized base URL, resolved protocol, upstream resource ID or null]
```

When a later request contains nested reasoning with `encrypted_content` or a
ProviderDock scope tag, the tag must match the currently selected route. Foreign or
untagged encrypted state is rejected locally with HTTP 400
`RESOURCE_SCOPE_MISMATCH`; no upstream request and no fallback replay is attempted.
This is intentionally stricter than deleting an item: encrypted content and any
provider-specific extension survive unchanged.

Immediately before forwarding, ProviderDock removes only its own
`providerdock_resource_scope` metadata. It continues to strip the stateless top-level
`previous_response_id` and `conversation` handles, but never blindly removes nested
encrypted reasoning. If an upstream still reports an ownership error such as “Use the
same resource that created the item” or “encrypted content could not be verified”, the
error is normalized to `RESOURCE_SCOPE_MISMATCH` and treated as non-retryable.

## Managed Anthropic Messages compatibility

For explicitly supported Anthropic Messages providers in a Codex logical route,
ProviderDock places a private codex-shim child behind this bridge:

```text
ResponsesBridgeServer
  -> synthetic Responses profile on a random loopback shim URL
     -> codex-shim
        -> Anthropic Messages
```

The shim is an optional, externally reviewed Python dependency; it is not a permanent
daemon and ProviderDock never uses a fixed port such as `127.0.0.1:8317`. One child is
created for each active Anthropic provider profile. The child accepts only `/health`
and `/v1/responses`, requires a generated token, has isolated home directories, and
exits when ProviderDock disappears.

The synthetic profile keeps the original provider ID but appears to the bridge as a
native Responses route. This keeps model access checks, telemetry, health identity,
recovery identity, and logical-model routing stable. All safety and routing decisions
remain in `ResponsesBridgeServer`; the shim is never allowed to retry, select routes,
or bypass the TurnLedger.

The ephemeral shim settings use `api_key_env`, never a plaintext `api_key`. Among
spawned processes, only the Python child receives the upstream key. The outer bridge
receives only the generated shim token. Normal shutdown stops the inner bridge, stops every
shim, and removes the ephemeral files. See `docs/codex-runtime.md` for supported
provider authentication, dependency overrides, and startup diagnostics.

## Current boundary

This component provides native Responses passthrough plus canonical Chat Completions
request/JSON/SSE translation. It also executes priority-ordered logical-model
routes for managed Codex sessions, with sticky safe fallback and route diagnostics.
A session-scoped cross-request TurnLedger blocks unsafe replay, records completed
upstream tool calls before client delivery, and atomically persists non-secret
safety state across bridge reconstruction. Supported Anthropic Messages routes use
the private managed codex-shim compatibility path above, while other custom protocols
remain unsupported. Claude Code uses its own managed Anthropic Messages bridge
documented in `docs/claude-code.md`. The Codex launcher starts and stops this bridge
for every `auto` route, including ordinary Responses profiles. Explicit
direct/external routes remain outside this normalization boundary.
