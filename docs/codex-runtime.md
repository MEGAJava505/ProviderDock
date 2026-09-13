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

## Approval levels

Every launch defaults to `ask`: Codex starts with `--sandbox read-only --ask-for-approval on-request`. `--approval auto` maps to `--sandbox workspace-write --ask-for-approval on-request`. `--approval full-auto` maps to `--dangerously-bypass-approvals-and-sandbox`; use it only when the absence of prompts and the sandbox is intentional.

### Resolution and persistence

`--approval` is optional. An explicit value is persisted in the versioned
`launch/preferences.json` store, keyed by the normalized project directory. When the
option is omitted, ProviderDock resolves the stored value for that project; if no value
exists, or the file cannot be parsed safely, it resolves to `ask`. A stored
`full-auto` value is therefore never created implicitly.

The dashboard launch record contains `resolvedApprovalLevel`, and the activity view
renders that resolved value rather than the request's omitted/placeholder value. CLI
launches perform the same resolution before invoking Codex or Claude Code, so the
approval arguments passed to the child are the resolved value.

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
- starts the managed, per-session codex-shim compatibility route for explicitly supported
  Anthropic Messages profiles, as described below;
- rejects unsupported Anthropic authentication shapes and other custom protocol
  translation with an explicit error rather than guessing a route.

Managed bridges receive provider credentials internally. Their Codex runtime profile
contains only the loopback URL and no upstream API key. External bridge URLs are recorded
as externally owned and are never stopped by ProviderDock.

## Session lifecycle

```text
validate project/provider
  → resolve direct, managed bridge, or external bridge route
  → start managed bridge on a Fetch-compatible random loopback port when required
  → write PREPARING manifest and a secret-free model catalog
  → create random $CODEX_HOME/providers/<provider-id>/providerdock-*.config.toml with create-new semantics
  → include trust for the explicitly selected project directory in that isolated profile
  → mark manifest READY
  → start codex --strict-config --profile providerdock-*
  → mark manifest ACTIVE with PID
  → wait for Codex exit
  → stop the managed bridge
  → verify profile and model-catalog checksums
  → delete only the unchanged temporary profile, model catalog, and runtime manifest
```

The user's main config is never modified. Managed sessions keep upstream secrets inside
the bridge. For explicitly selected direct mode, secrets use randomly named child-process
environment variables referenced by `env_key` or `env_http_headers`; they are not written
into TOML or the recovery manifest.

ProviderDock also writes `model-catalog.json` beside the runtime manifest and points the
isolated Codex profile at it with `model_catalog_json`. The catalog describes only the
model ID exposed to Codex (including a logical-model ID), contains no credentials, and is
checksum-guarded during cleanup. This gives Codex explicit metadata instead of falling
back to generic unknown-model metadata.

## Reasoning capability catalog

The generated catalog uses exact model IDs and the official overlay snapshot version
`2026-09-11` before considering provider metadata. For an `effort` capability it emits
the exact values and default; for `thinking-mode`, `unsupported`, and `unknown` it
emits no synthetic effort list. In particular, unknown models do not receive a
fallback `low/medium/high` menu, and `glm-5.3` is represented as forced thinking
instead of `low/high/max`.

The Codex snapshot covers `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`,
`gpt-5.6-luna`, `gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.5`,
`gpt-5.4`, and `codex-auto-review`. Exact provider metadata remains useful for models
not in the overlay, but it is labeled as provider metadata rather than presented as
official model-owner support. A user override may intentionally supersede the official
entry.

## Managed Anthropic Messages compatibility

Codex custom providers continue to use the Responses wire protocol. For a supported
Anthropic Messages provider, ProviderDock composes the route as:

```text
Codex CLI
  -> managed ResponsesBridgeServer
     -> PersistentTurnLedger
     -> safe fallback policy
     -> usage and health telemetry
     -> synthetic Responses profile
        -> isolated codex-shim Python child
           -> Anthropic Messages provider
```

The outer `ResponsesBridgeServer` is the safety boundary. The TurnLedger, sticky route
selection, circuit breakers, safe fallback decisions, model access checks, usage
telemetry, health telemetry, and prompt-profile injection all execute before the shim.
A synthetic Responses profile retains the original provider ID so dashboards, health,
recovery, and access checks keep a stable identity. Its base URL points to the private
shim on `http://127.0.0.1:<random-port>/v1`.

ProviderDock does **not** use or attach to a global `codex-shim` daemon such as
`127.0.0.1:8317`. A fixed daemon cannot provide per-session secrets, per-session
fallback state, route restriction, parent-death cleanup, or the managed health contract.
Instead, one shim process is started for each active Anthropic provider profile in the
logical route group. All shims bind only to loopback, request a random port, and are
stopped before their ephemeral files are removed.

### External dependency and configuration

Python 3.11+ and a reviewed build of
[`sybil-solutions/codex-shim`](https://github.com/sybil-solutions/codex-shim) are
required. The project does not vendor, clone, update, or implicitly trust the shim.
The selected build must expose `codex_shim.server.ShimServer` and the internal
`_dump_debug_request` and `_log_incoming_request` hooks used by the generated wrapper.
Pinning and reviewing the shim checkout before enabling an Anthropic route is an
operator responsibility.

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `PROVIDER_DOCK_CODEX_SHIM_PYTHON` | Python executable | `python` on Windows, `python3` elsewhere |
| `PROVIDER_DOCK_CODEX_SHIM_SOURCE` | Optional absolute shim source directory added to `PYTHONPATH` | Not set; the module must already be importable |
| `PROVIDER_DOCK_CODEX_SHIM_MODULE` | Importable shim server module | `codex_shim.server` |
| `PROVIDER_DOCK_CODEX_SHIM_STARTUP_TIMEOUT_MS` | Readiness and health timeout | `15000` |

The shim child receives an isolated `HOME`, `USERPROFILE`, and `CODEX_HOME`, plus a
minimal inherited environment. It does not inherit ProviderDock's complete process
environment.

### Supported provider shape

The managed shim route is deliberately narrow. An Anthropic provider must have:

- `apiType: "anthropic-messages"`;
- `adapterId: "auto"` or `"generic-anthropic"`;
- `auth.kind: "header"` with `headerName: "x-api-key"` and a secret reference;
- no `secretHeaders`;
- no `queryParameters`;
- no username/password credentials in `baseUrl`;
- no static header named `x-providerdock-shim-token`.

Other static headers are passed to codex-shim as `extra_headers`. Unsupported profiles
fail before a child process starts.

A JustWorker example is:

```json
{
  "id": "justworker-anthropic",
  "displayName": "JustWorker Anthropic",
  "baseUrl": "https://api.justwoker.icu/v1",
  "apiType": "anthropic-messages",
  "adapterId": "generic-anthropic",
  "auth": {
    "kind": "header",
    "headerName": "x-api-key",
    "secretRef": "JUSTWORKER_ANTHROPIC_API_KEY"
  },
  "manualModelIds": [
    "gpt-5.6-luna",
    "gpt-5.6-sol"
  ]
}
```

Every enabled physical model route for that provider is included in the ephemeral shim
settings file. The logical model still exposes only its logical ID to Codex; the outer
bridge rewrites it to the selected physical model before contacting the shim.

### Secret and process boundary

ProviderDock resolves the upstream key from its secret store before startup. It then:

1. generates a random environment-variable name such as
   `PROVIDER_DOCK_SHIM_API_KEY_<random>`;
2. passes the key only in that child-process environment variable;
3. writes only `api_key_env` to the ephemeral settings JSON, never an `api_key` value;
4. generates a separate random token for calls from the outer bridge to the shim;
5. stores that token only in an in-memory secret store and the child environment;
6. sends it as `x-providerdock-shim-token`.

The settings file is UTF-8 without a BOM and is removed on normal shutdown. The Codex
process receives neither the upstream key nor the shim token.

The generated Python wrapper restricts the child to `GET /health` and
`POST /v1/responses`, requires the generated token for inference, and disables
ChatGPT passthrough, Cursor passthrough, and the shim's automatic router through
`CODEX_SHIM_DISABLE_CHATGPT=1`, `CODEX_SHIM_DISABLE_CURSOR=1`, and
`CODEX_SHIM_DISABLE_ROUTER=1`. It replaces the debug-dump and incoming-request logging
hooks with no-ops and disables codex-shim's image-generation intent checks. ProviderDock
also validates the health response before startup: it must report the expected model
count and all three passthrough/router flags as disabled.

The wrapper watches both stdin EOF and the ProviderDock parent PID. If ProviderDock
exits normally or crashes, the Python child exits rather than becoming an orphan. Stop
order is inner bridge first, then every shim process, then ephemeral file cleanup. If a
later provider fails startup, every shim already started for that launch is stopped.

### Diagnostics

Anthropic shim startup fails closed rather than falling back to a guessed protocol.
Common failures produce explicit startup errors:

- the configured Python executable is missing;
- the shim module cannot be imported or does not expose the required server/hooks;
- the shim does not report readiness within the configured timeout;
- the shim exits before health becomes ready;
- `/health` does not report the expected model count or isolated BYOK configuration;
- the referenced Anthropic API key is unavailable;
- the provider uses an unsupported auth or URL shape.

Once the outer bridge is running, its existing fallback rules are unchanged. Safe
failures may select another configured route before output; ambiguous HTTP/transport
failures, partial output, and unresolved tool history are returned without a second
upstream attempt.

## Provider-scoped session history

Codex receives a provider-specific `CODEX_HOME`:

```text
<configured CODEX_HOME root>/providers/<provider-id>
```

The root defaults to `~/.provider-switcher/runtime/codex-home` and can be moved with the
`CODEX_HOME` environment variable. ProviderDock passes the nested provider directory to
the child, so rollout files under `sessions/` never mix between providers. Existing shared
history is left in place rather than guessed or migrated.

After a Codex process exits (and no other ProviderDock runtime for that provider is
active), ProviderDock keeps the 50 newest Codex session files for that provider and deletes
older files first. Ordering uses file modification time. Retention touches only
`sessions/**/rollout-*.jsonl`; provider configuration, credentials, caches, and other
Codex state are never removed.

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
