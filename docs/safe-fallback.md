# Safe fallback policy

Phase 4 begins with a provider-independent routing core under
`src/core/fallback/`. It deliberately does not retry HTTP requests by itself;
the bridge must supply verified failure-phase evidence before another route can
be selected.

## Logical models and priority

A logical model maps one client-facing identity to ordered provider/model
routes:

```json
{
  "id": "gpt-x",
  "routes": [
    { "providerId": "agentrouter", "modelId": "gpt-x", "priority": 100 },
    { "providerId": "gorouter", "modelId": "gpt-x", "priority": 90 }
  ]
}
```

Routes are schema-validated, duplicate provider/model pairs are rejected, and
ties are deterministic. A successful or selected fallback route becomes sticky
for the runtime session until the user changes it or a later failure/circuit
decision selects another route.

Logical models are persisted in a bounded, versioned JSON document at
`~/.provider-switcher/fallback/logical-models.json`. Mutations are serialized and
published with an atomic temporary-file rename. Invalid, duplicate, oversized, or
unknown-version data fails closed. CLI management is available through:

```text
providerdock logical-models list [--json]
providerdock logical-models show <id>
providerdock logical-models set --id <id> --route provider=model@priority [--route ...]
providerdock logical-models remove <id>
```

Routes may only reference configured providers, and provider deletion is blocked
while a logical-model route still uses that provider.

## Side-effect barrier

Each provider attempt reports an explicit failure phase. Automatic fallback is
considered only for connection failure, a rejected request, or a known failure
before output. It is blocked when:

- meaningful output reached the client;
- a tool call may have executed;
- upstream execution state is unknown;
- earlier side effects exist without complete continuation history;
- the request failure is not retryable; or
- every healthy route was already attempted.

A complete continuation may move to another provider before new output; an
ambiguous history cannot. Every selected fallback returns a structured
notification containing logical model, source route, target route, error type,
phase, and message for the future UI/bridge event layer.

## Circuit breaker

The keyed breaker implements `CLOSED -> OPEN -> HALF_OPEN -> CLOSED/OPEN` with a
configurable failure threshold and cooldown. Exactly one HALF_OPEN probe is
admitted; concurrent probes are blocked. Keys may represent either a provider
or a provider/model pair, allowing separate breaker scopes.

## Responses bridge and Codex integration

`providerdock launch codex --logical-model ID --project DIRECTORY` resolves the
enabled routes and provider profiles, starts one managed loopback Responses
bridge, and exposes only the logical-model ID to Codex. Each upstream attempt
rewrites that ID to the route's provider-specific model ID and may use either
native Responses or the existing Chat Completions translation path.

The bridge can select another unused healthy route only when it has evidence of
a safe boundary:

- a proven connection-establishment failure;
- an explicit request rejection such as HTTP 401/403/404/429/501/503;
- a continuation whose complete tool call/result history is retained.

Connection resets with unknown execution state, ambiguous gateway errors, partial
streams, and unresolved tool histories never trigger a second upstream request.
Fallback responses identify the active provider and switch in
`x-providerdock-*` headers. `/health` retains the stable primary bridge identity
for crash recovery and reports `active_provider_id`, the sticky route snapshot,
and the last fallback notification. The CLI prints every switch to stderr.

## Anthropic bridge and Claude Code integration

`providerdock launch claude --logical-model ID --project DIRECTORY` uses the
same provider-independent fallback policy through Claude Code's managed
Anthropic Messages bridge. Claude sees only the logical-model ID in
`ANTHROPIC_MODEL`; every upstream attempt rewrites it to that route's physical
model ID.

Routes may mix native `anthropic-messages` providers with `auto` or
`openai-chat-completions` providers. Native routes preserve Anthropic headers
and relay `/messages`; Chat routes use the existing validated
Messages-to-Chat request and Chat-to-Messages response/SSE translators.
Explicit `openai-responses` routes remain unsupported because no safe
Anthropic-to-Responses translator exists.

The Claude bridge applies the same fail-closed boundaries as the Responses
bridge: proven connection-establishment failures and explicit safe HTTP
rejections may select another route, while ambiguous transport/gateway state,
header timeouts, unresolved tool history, and any failure after response
headers/output never cause replay. Complete `tool_use`/`tool_result` history
can continue on the selected route. Route and fallback diagnostics are exposed
through `x-providerdock-*` headers and `/health`, and the CLI prints switches
to stderr.

## Current integration boundary

The Phase 4 routing core, persisted logical models, managed Codex and Claude
bridge routing, route-specific protocol translation, safe pre-output fallback,
sticky sessions, circuit breakers, continuation barriers, and CLI
notifications are connected. Existing single-provider bridge launches still
make exactly one upstream attempt.

Remaining Phase 4 work includes richer session/UI event storage, persisted
circuit/route diagnostics across a bridge-process crash, and the production UI
for interactive route/fallback visibility.
