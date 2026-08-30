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

## Current integration boundary

The policy, state machine, schemas, persistent logical-model configuration, and
CLI controls are complete. HTTP bridge route execution, runtime session wiring,
UI controls, and user-visible fallback events are the next Phase 4 integration
blocks. Until that wiring lands, existing single-provider bridges still perform
no automatic fallback.
