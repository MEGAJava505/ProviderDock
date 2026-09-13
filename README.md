# ProviderDock

ProviderDock is the implementation of the Russian-language [Provider Switcher technical specification](./PROVIDER_SWITCHER_TECHNICAL_SPEC_RU.md): a local multi-provider manager and compatibility gateway for Codex CLI and Claude Code.

The application is intentionally not another coding agent. It discovers and monitors models, translates incompatible provider protocols, launches an existing coding client with an isolated runtime configuration, and prevents unsafe retries after streamed output or tool side effects.

## Current status

Development has completed the integrated Phase 5 profile layer and started
Phase 6 advanced features. The current core provides:

- validated provider profiles that contain secret references, never plaintext API keys;
- atomic file-backed provider CRUD;
- an extensible provider-adapter registry;
- OpenAI-compatible model discovery;
- manual/discovered model merging;
- normalized provider health states and errors;
- shared failure explanations and concrete suggested actions in bridge responses,
  CLI probes, and the local dashboard;
- a management CLI for provider CRUD, model discovery, and health probes;
- bounded, versioned health/model snapshot persistence with CLI dashboard,
  probe history, real managed-traffic signals, TTL/backoff-aware metadata
  monitoring, Doctor-derived per-model capability/client matrices, and
  provider-lifecycle cleanup;
- a loopback-only web dashboard with a unified provider/model health matrix,
  provider/logical-model/prompt/project CRUD, DPAPI secret-vault writes,
  explicit probes, persisted content-free session activity, usage summaries,
  and asynchronous Codex/Claude/Auto launch controls;
- an isolated Codex runtime profile, launcher, and checksum-guarded crash recovery;
- a loopback-only native Responses bridge with Codex model capabilities and event-aware SSE repair;
- canonical Responses request normalization and safe Responses-to-Chat request translation;
- an anti-replay/anti-recursion turn ledger that blocks duplicate turns, unsafe retries
  after partial streams, and recursive tool loops before upstream contact, with
  atomic crash-safe session snapshots;
- a manual tiered Provider/Model Doctor (metadata, minimal inference, streaming,
  synthetic tool round-trip);
- Claude Code support: a loopback Anthropic Messages bridge with native relay for
  Anthropic providers and safety-validated OpenAI Chat / Responses translation
  (requests, responses, SSE);
- a Claude Code launcher that configures `ANTHROPIC_*` only inside the child process
  environment and never leaks provider credentials to the client;
- a `generic-anthropic` provider adapter for Anthropic-native model discovery;
- a provider-independent safe-fallback policy core with logical-model priority,
  sticky sessions, circuit breakers, continuation checks, and side-effect barriers;
- versioned, atomic logical-model route storage plus CLI CRUD with provider-reference
  validation and protection against dangling routes;
- managed Codex logical-model launch with bridge-level, route-specific protocol
  translation, safe pre-output fallback, sticky route selection, response diagnostics,
  and user-visible CLI fallback notifications;
- managed Codex Anthropic Messages compatibility through a private, token-protected
  `codex-shim` child process per active Anthropic provider, while keeping the
  Responses bridge's TurnLedger, fallback, usage, and health checks outside the shim;
- managed Claude logical-model launch with native-Anthropic/Chat route selection,
  the same fail-closed continuation barriers, sticky routing, health/response
  diagnostics, and CLI fallback notifications;
- versioned, atomic prompt/launch profiles with provider/logical-model reference
  integrity, multiline instructions, client flags, reasoning preference, and
  profile-based Codex/Claude launch through managed bridges;
- exact-directory project profiles that bind a project to a prompt profile and
  apply it automatically when launch has no explicit route selector;
- `launch auto` client selection honoring explicit prompt/provider preferences,
  then measured per-model Codex/Claude compatibility, with a deterministic
  protocol heuristic when no Doctor result exists;
- versioned JSON import/export for provider, logical-model, prompt, and project
  profiles, with no secret values, full reference validation, explicit
  overwrite policy, and rollback on repository failure;
- bounded usage telemetry from managed Codex/Claude bridges with normalized
  token/cache/web-search accounting, optional profile-defined pricing, exact
  microunit cost totals, and CLI event/summary dashboards;
- a versioned provider plugin SDK with explicit local-module opt-in,
  namespaced adapter IDs, manifest/runtime validation, host-mediated
  same-origin authenticated HTTP, and CLI plugin inventory;
- unit tests using fully local HTTP mocks.

The local web dashboard includes a searchable model storefront across providers, manual
tariff editing and per-model streaming/tool checks. Bundle import/export, arbitrary
Doctor levels and plugin inventory also remain available in the CLI. Codex `auto` routes
and Claude Code sessions use managed compatibility bridges and provider-scoped retained
agent histories.

Russian implementation notes: [stability fixes and limits](./docs/stability-update-ru.md).
New API account connections can read wallets and daily check-in status using separate
account tokens: [setup and limitations](./docs/provider-portal-setup-ru.md).
Live tariffs and spending controls remain [planned](./docs/provider-portals-and-spending-ru.md);
configured manual prices are estimates, not provider billing limits.

## Development

Requirements: Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

## Management CLI

Build the project, then manage local provider profiles with `node dist/cli.js` (or the
`providerdock` binary when the package is linked):

```powershell
node dist/cli.js dashboard
```

On Windows, the simplest path is to double-click [`ProviderDock.bat`](./ProviderDock.bat)
in the project directory. It installs dependencies on the first run, rebuilds the app,
starts the loopback dashboard, and opens the private dashboard URL in the default
browser. The equivalent CLI command is `node dist/cli.js dashboard --open`.

The command prints a private per-process URL, binds only to `127.0.0.1`, and keeps the
dashboard running until Ctrl+C. The random URL path is an access token; do not share it.
Use `--port PORT` only when a fixed local port is needed. See
[`docs/web-dashboard.md`](./docs/web-dashboard.md).

```bash
node dist/cli.js providers set \
  --id agentrouter \
  --name AgentRouter \
  --base-url https://example.invalid/v1 \
  --auth-kind bearer \
  --secret-ref AGENTROUTER_API_KEY

node dist/cli.js providers list
node dist/cli.js probe agentrouter
node dist/cli.js health show agentrouter
node dist/cli.js health history agentrouter
node dist/cli.js doctor agentrouter --level 2
node dist/cli.js providers remove agentrouter
```

Map one client-facing logical model to priority-ordered provider/model routes:

```powershell
node dist/cli.js logical-models set `
  --id gpt-x `
  --route agentrouter=gpt-x@100 `
  --route gorouter=gpt-x@90

node dist/cli.js logical-models list
node dist/cli.js logical-models show gpt-x
```

Logical-model configuration is stored atomically under
`~/.provider-switcher/fallback/logical-models.json`. Every referenced provider must
already exist. A provider cannot be removed while one of these routes still references
it; remove or update the logical model first.

For AgentRouter, select its scoped adapter so the established client-identity headers and
model filtering are applied automatically:

```powershell
node dist/cli.js providers set `
  --id agentrouter `
  --name AgentRouter `
  --base-url https://agentrouter.org/v1 `
  --adapter agentrouter `
  --auth-kind bearer `
  --secret-ref AGENTROUTER_API_KEY
```

GoRouter uses `--adapter gorouter`; no provider-specific behavior is assumed until a
probe demonstrates it. See [`docs/provider-adapters.md`](./docs/provider-adapters.md).

Provider profiles store only secret references. Put the actual token in the referenced
environment variable; do not pass API keys on the command line. By default profiles are
stored under `~/.provider-switcher/providers/providers.json`. Set `PROVIDER_DOCK_HOME`
to use an isolated data directory. Credential headers and query parameters are rejected
as static values and must use `--secret-header` or the corresponding auth mode.

On Windows, secrets can be imported into the per-user DPAPI vault without putting their
value in process arguments:

```powershell
$env:IMPORT_PROVIDER_KEY = "your-token"
node dist/cli.js secrets set AGENTROUTER_API_KEY --from-env IMPORT_PROVIDER_KEY
Remove-Item Env:IMPORT_PROVIDER_KEY

node dist/cli.js secrets list
```

Provider resolution checks the DPAPI vault first and then the child process environment.
The CLI intentionally provides no command that prints a stored secret value.

Launch Codex in a project with an isolated runtime profile:

```powershell
node dist/cli.js launch codex `
  --provider agentrouter `
  --model gpt-x `
  --project C:\Projects\example

node dist/cli.js launch codex `
  --logical-model gpt-x `
  --project C:\Projects\example

node dist/cli.js recover codex
```

Logical-model launch always uses a managed loopback bridge. It rewrites the
client-facing logical model to the selected provider route, may switch only at a
verified safe boundary before output, keeps the selected route sticky for the
session, and prints every switch to stderr. Ambiguous failures, partial output,
and unresolved tool history stop safely instead of replaying the turn.

Launch Claude Code against a configured Anthropic Messages or OpenAI Chat
provider through the managed Anthropic Messages bridge:

```powershell
node dist/cli.js launch claude `
  --provider anthropic `
  --model claude-x `
  --project C:\Projects\example

node dist/cli.js launch claude `
  --logical-model gpt-x `
  --project C:\Projects\example
```

Logical-model Claude launch keeps the logical ID in `ANTHROPIC_MODEL` and
rewrites it per upstream route. Native Anthropic and OpenAI Chat routes can be
mixed in one priority group; ambiguous failures, partial streams, and
incomplete tool history fail closed without replay.

Create and launch a reusable prompt profile:

```powershell
@"
Work practically.
Inspect the existing implementation first.
"@ | Set-Content .\practical-instructions.md

node dist/cli.js prompt-profiles set `
  --id practical `
  --name "Practical Coding" `
  --instructions-file .\practical-instructions.md `
  --logical-model gpt-x `
  --client codex `
  --reasoning xhigh `
  --fallback logical-model

node dist/cli.js launch codex `
  --prompt-profile practical `
  --project C:\Projects\example

node dist/cli.js project-profiles set `
  --project C:\Projects\example `
  --prompt-profile practical

# The exact project binding now supplies the prompt/routing defaults.
node dist/cli.js launch codex --project C:\Projects\example
node dist/cli.js launch auto --project C:\Projects\example
```

Profile instructions are injected by the private session bridge; ProviderDock
does not write `AGENTS.md`, `CLAUDE.md`, the user's Codex config, or global
environment variables.

### Reasoning capabilities and model metadata

ProviderDock resolves reasoning metadata by **exact model ID**. The dated official
overlay (`2026-09-11`) is authoritative for the Codex picker; provider-advertised
metadata is used only when no exact official entry exists. A gateway's advertised
subset may still be narrower than the model-owner catalog, so the selected upstream
route remains the final compatibility boundary.

The capability layer has four explicit states:

- `effort` — the exact supported values, optional default, and provenance are retained;
- `thinking-mode` — the model exposes a thinking mode rather than an effort enum;
- `unsupported` — effort control is known not to be supported;
- `unknown` — no proven values are available.

Unknown models are shown as `unknown`; ProviderDock never invents a global
`low/medium/high` list. The current Codex overlay includes
`gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`,
`gpt-daybreak-blue-latest`, `gpt-daybreak-red-latest`, `gpt-5.5`, `gpt-5.4`,
and `codex-auto-review`, with the exact defaults and levels from the snapshot.
The exact Anthropic entries are model-aware as well. `glm-5.3` is represented as
forced thinking mode, not as `low/high/max`. An explicit user override is the only
way to supersede an exact official entry.

### Launch approval persistence

The default launch approval remains `ask`. When `--approval` (or the dashboard
control) is explicitly selected, ProviderDock stores that choice per normalized
project directory in:

```text
~/.provider-switcher/launch/preferences.json
```

An omitted approval resolves to the stored project preference, or to `ask` when no
preference exists or the preference file is invalid. The dashboard launch history
records and displays the actual `resolvedApprovalLevel` used by the child process;
the CLI resolves the same value before dispatching the launch. `full-auto` is never
enabled implicitly.

### Provider-owned Responses state

Responses reasoning items and encrypted provider-owned state are tagged with the
creating provider/base-URL/protocol scope. On a later request, nested encrypted
reasoning must carry the exact matching scope. Foreign or untagged state is rejected
locally with `RESOURCE_SCOPE_MISMATCH` before any upstream request or fallback replay.
Only ProviderDock's local scope tag is removed before forwarding; encrypted content and
provider-specific extensions are preserved. Ownership errors returned by an upstream
are normalized to the same non-retryable error, so the bridge never silently deletes
or replays provider-owned reasoning across routes.

### Managed Anthropic Messages in Codex

Codex continues to speak the OpenAI Responses protocol. For an explicitly supported
Anthropic Messages route, ProviderDock starts a private Python `codex-shim` child for
that provider and puts it behind the normal managed Responses bridge:

```text
Codex CLI
  -> managed Responses bridge
     -> TurnLedger, safe fallback, telemetry, and health state
     -> token-protected codex-shim on a random loopback port
        -> Anthropic Messages
```

This is not the fixed `127.0.0.1:8317` daemon. Each shim is session-scoped, binds a
random loopback port, accepts only its health and Responses endpoints, requires a
generated ProviderDock token, and exits when ProviderDock disappears. The outer
Responses bridge remains the safety boundary, so Anthropic routes participate in the
same logical-model fallback policy without independent retries.

A reviewed Python 3.11+ installation and a reviewed build of
[`sybil-solutions/codex-shim`](https://github.com/sybil-solutions/codex-shim) are
required. The dependency is not vendored or cloned automatically. Configuration
overrides are documented in [`docs/codex-runtime.md`](./docs/codex-runtime.md).

A supported Anthropic profile must use `anthropic-messages`, adapter `auto` or
`generic-anthropic`, header authentication through `x-api-key`, and no secret headers,
query authentication, or credentials embedded in the base URL. For example:

```powershell
node dist/cli.js providers set `
  --id justworker-anthropic `
  --name "JustWorker Anthropic" `
  --base-url https://api.justwoker.icu/v1 `
  --api-type anthropic-messages `
  --adapter generic-anthropic `
  --auth-kind header `
  --auth-name x-api-key `
  --secret-ref JUSTWORKER_ANTHROPIC_API_KEY `
  --manual-model gpt-5.6-luna `
  --manual-model gpt-5.6-sol
```

The API key is resolved from the secret store, placed only in a randomly named
environment variable for the shim child, and referenced by `api_key_env` in an
ephemeral settings file. It is never written to the Codex profile, runtime manifest,
or settings JSON.

Direct Codex routes still require a Responses-compatible provider. Query-authenticated
Responses providers and AgentRouter are relayed automatically by a per-session bridge.
Chat Completions providers are translated automatically through the canonical protocol,
and supported Anthropic Messages providers use the managed shim route above. An
already-running external compatibility bridge can be selected explicitly through
`--bridge-url`; ProviderDock never attaches to a global fixed-port shim daemon.
Bridge behavior is documented in [`docs/responses-bridge.md`](./docs/responses-bridge.md).
Claude Code runtime and Anthropic bridge behavior are documented in
[`docs/claude-code.md`](./docs/claude-code.md).
Replay protection and tool-call integrity rules are documented in
[`docs/anti-replay.md`](./docs/anti-replay.md).
Fallback policy and its current integration boundary are documented in
[`docs/safe-fallback.md`](./docs/safe-fallback.md).
Runtime details and recovery guarantees are documented in
[`docs/codex-runtime.md`](./docs/codex-runtime.md).
Prompt/launch profiles are documented in
[`docs/prompt-profiles.md`](./docs/prompt-profiles.md).
Persisted probe health and model dashboard state are documented in
[`docs/health-dashboard.md`](./docs/health-dashboard.md).
Portable non-secret profile bundles are documented in
[`docs/profile-bundles.md`](./docs/profile-bundles.md).
Usage telemetry, pricing, coverage, and dashboard commands are documented in
[`docs/usage-dashboard.md`](./docs/usage-dashboard.md).
Trusted local provider modules, the versioned SDK contract, loader rules, and
security boundary are documented in
[`docs/provider-plugin-sdk.md`](./docs/provider-plugin-sdk.md).
The loopback UI, its security boundary, and supported actions are documented in
[`docs/web-dashboard.md`](./docs/web-dashboard.md).

Third-party attributions are recorded in
[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md).

## Architecture direction

```text
Codex CLI / Claude Code
        ↓
Client adapter
        ↓
Canonical protocol
        ↓
Compatibility fixes and safety state machine
        ↓
Provider adapter
        ↓
External provider API
```

Provider-specific behavior belongs in provider adapters or scoped compatibility fixes. Core session, health, routing, and safety logic must remain provider-independent.

## Roadmap

The authoritative roadmap and acceptance criteria live in [PROVIDER_SWITCHER_TECHNICAL_SPEC_RU.md](./PROVIDER_SWITCHER_TECHNICAL_SPEC_RU.md). The major delivery sequence is:

1. Multi-provider launcher and safe runtime configuration.
2. Canonical protocol and compatibility engine.
3. Claude Code support.
4. Safe fallback with side-effect barriers.
5. Project and prompt profiles.
6. Additional providers and platforms.

Model storefront: [models, site prices and provider account setup](docs/model-storefront-ru.md).

Latest dashboard update: [compact storefront, daily/weekly usage, account sessions and balances](docs/dashboard-update-ru.md).
