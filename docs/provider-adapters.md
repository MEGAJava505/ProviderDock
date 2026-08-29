# Provider adapters

Provider-specific behavior is isolated behind adapter scopes. A profile selects an
adapter with `adapterId`; the generic OpenAI adapter remains free of provider-specific
exceptions.

## AgentRouter

The initial AgentRouter adapter is based on regression evidence from
[`MEGAJava505/agentrouter_for_codex`](https://github.com/MEGAJava505/agentrouter_for_codex).
It applies and reports these compatibility fixes:

- `fix.auth.client-identity` adds the established `User-Agent: codex_cli_rs/0.144.1`
  and `Originator: codex_cli_rs` defaults while preserving explicit overrides;
- `fix.models.openai-endpoint-filter` excludes `/models` entries whose declared
  `supported_endpoint_types` do not include `openai`.

The identity defaults are stored in the normalized provider profile. This means direct
Codex runtime profiles and the future bridge receive the same scoped fix instead of
duplicating special cases in each client.

## GoRouter

GoRouter has a separate adapter scope but no guessed compatibility fixes. It currently
uses generic OpenAI discovery. Headers, protocol behavior, and model capabilities will
be added only when probes or sanitized fixtures demonstrate that they are required.
