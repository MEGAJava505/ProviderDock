# Codex runtime configuration

ProviderDock launches Codex with an isolated, randomly named config profile rather than
rewriting the user's `~/.codex/config.toml`.

The launcher invokes that file with `-p` / `--profile`. The profile remains scoped to a
runtime session because a managed bridge has a random loopback port, a session-specific
provider name and independent anti-replay state. A single persistent provider profile
would either require a permanent fixed-port daemon or create races between concurrent
launches. Static provider templates may be added later, but dynamic session values must
remain isolated.

The current official Codex configuration reference states that:

- user-level configuration lives at `~/.codex/config.toml`;
- provider keys cannot be overridden by project-local `.codex/config.toml`;
- profile files can live at `$CODEX_HOME/<profile-name>.config.toml` and are selected with
  `--profile <profile-name>`;
- custom providers use `model_providers`, `base_url`, `env_key`, and
  `env_http_headers`;
- `responses` is currently the only supported custom-provider `wire_api`.

Source: [OpenAI Codex Configuration Reference](https://learn.chatgpt.com/docs/config-file/config-reference),
retrieved 2026-08-29.

## Route selection

The CLI uses `auto` routing unless `--bridge-url` names an external bridge. Auto routing:

- starts one managed loopback bridge for all supported provider profiles, including
  ordinary Responses profiles, AgentRouter and query authentication;
- starts a managed bridge with canonical request/response translation for Chat Completions;
- always starts a managed bridge for `--logical-model`, exposing the logical ID
  to Codex while selecting and safely falling back between provider/model routes;
- always starts a managed bridge for `--prompt-profile`, injects profile
  instructions before client turn instructions, applies profile flags and the
  managed model's reasoning default, and then uses either the configured
  physical route or logical-model fallback policy;
- rejects Anthropic Messages and custom protocol translation with an explicit error until
  those translators are implemented.

Managed bridges receive provider credentials internally. Their Codex runtime profile
contains only the loopback URL and no upstream API key. External bridge URLs are recorded
as externally owned and are never stopped by ProviderDock.

## Session lifecycle

```text
validate project/provider
  → resolve direct, managed bridge, or external bridge route
  → start managed bridge on a Fetch-compatible random loopback port when required
  → write PREPARING manifest
  → create random $CODEX_HOME/providerdock-*.config.toml with create-new semantics
  → include trust for the explicitly selected project directory in that isolated profile
  → mark manifest READY
  → start codex --strict-config --profile providerdock-*
  → mark manifest ACTIVE with PID
  → wait for Codex exit
  → stop the managed bridge
  → verify profile checksum
  → delete only the unchanged temporary profile and runtime manifest
```

The user's main config is never modified. Managed sessions keep upstream secrets inside
the bridge. For explicitly selected direct mode, secrets use randomly named child-process
environment variables referenced by `env_key` or `env_http_headers`; they are not written
into TOML or the recovery manifest.

On startup, stale session manifests can be recovered. ProviderDock removes a temporary
profile only when its path is derived from the recorded random profile name and its
contents still match the recorded SHA-256 checksum. A changed profile produces a
conflict and is preserved for manual inspection.

Legacy profiles created before project trust was written up front are also recoverable
when Codex appended exactly one `trust_level = "trusted"` entry for the same directory.
Recovery first verifies that removing that exact suffix restores the recorded SHA-256;
any other edit remains a conflict.

Version 2 runtime manifests record route kind plus bridge URL, ownership and lifecycle
state (`LISTENING`, `CONFIGURED`, or `ACTIVE`) for diagnostics. They never record bridge
credentials. Recovery remains compatible with version 1 manifests created by earlier
ProviderDock builds.

Managed sessions also keep `turn-ledger.json` beside the manifest. It is written before
upstream/tool delivery, retained after a crash, and removed with the session directory
only during checksum-guarded normal or stale-session cleanup.

For an active managed route, recovery verifies the loopback `/health` response and
provider ID. If the Codex PID is alive but its bridge disappeared after a launcher crash,
the session is reported as `CONFLICT`; its profile and manifest are preserved rather than
being presented as a healthy active session.
