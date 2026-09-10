# Local web dashboard

ProviderDock includes a local web control surface over the same application service
used by the management CLI. It does not duplicate provider, probe, Doctor, routing, or
launcher logic.

Start it after building the project:

```powershell
node dist/cli.js dashboard
```

For a one-step Windows launch, double-click `ProviderDock.bat` in the project root.
It performs first-run dependency setup when needed, rebuilds ProviderDock, starts the
dashboard, and opens the generated private URL. From a terminal, the same automatic
browser behavior is available with:

```powershell
node dist/cli.js dashboard --open
```

The command prints an address similar to:

```text
http://127.0.0.1:49152/<random-session-token>/
```

Open that exact URL and keep the terminal running. Press Ctrl+C to stop the dashboard.
An optional fixed browser-compatible port can be selected with `--port PORT`; the
default is a random free port.

## Current surface

The dashboard provides:

- a Russian-language, neutral-color interface with contextual help and inline
  operation status instead of a stack of side notifications;
- one provider overview with latest `ONLINE`, `DEGRADED`, `OFFLINE`, `AUTH_ERROR`,
  `RATE_LIMITED`, `INCOMPATIBLE`, and `DISABLED` state;
- a model storefront with cards/table, provider and tariff-group filters, site prices
  and performance, plus persisted Doctor compatibility for Codex CLI and Claude Code;
- simplified provider create/edit/remove: paste an API URL or the first cURL example
  from provider documentation to infer the base URL, protocol, authentication style,
  and model; an entered key is saved directly to the Windows DPAPI vault while advanced
  fields remain available behind one disclosure;
- logical-model route create/edit/remove with enabled routes and priorities;
- prompt-profile and exact project-binding create/edit/remove;
- Windows DPAPI secret-vault store/replace/remove without displaying stored values;
- TTL/backoff-aware background metadata probes, real managed-traffic health,
  an explicit forced metadata/model probe, and an explicit level-1 Doctor action;
- provider/model, logical-model, prompt-profile, and exact project-profile launches;
- a native Windows folder chooser in the project launch form, while manual path entry
  remains available;
- `Auto`, Codex CLI, and Claude Code client selection;
- a pre-launch action-confirmation selector: ask (default), project-directory edits, or dangerous full-auto;
- in-process launch state and fallback notifications;
- persisted content-free managed-session request/fallback/protocol-error summaries;
- managed-bridge usage totals without prompt or response content.

The model storefront supports cross-provider search, status/currency filters, price
sorting within currencies and pages of 50 models. It distinguishes metadata discovery
from model inference, expires model evidence after 30 minutes and labels local observations
separately from provider load. Manual pricing can be edited per model; new agent sessions
use the revised prices for future usage records. Provider cards offer separate New API
account connections with wallet/check-in status, manual refresh and optional background
refresh (five minutes by default). Account tokens stay in the local vault; stale data and
expired authentication are explicit. See [account setup](provider-portal-setup-ru.md).
New API site tariffs and published performance are loaded alongside account data.
Spending enforcement remains planned; site prices do not overwrite manual usage estimates.

Per-model drawers offer explicit L3 streaming/tool checks; they may use up to five paid
generation attempts with protocol detection. No such checks run during catalog refresh.
Profile bundle import/export, arbitrary Doctor levels and plugin inventory remain
available through the CLI.

## Security boundary

The dashboard:

- binds only to IPv4 loopback (`127.0.0.1`), never `0.0.0.0`;
- generates an unguessable token in the URL path for every dashboard process;
- requires the exact loopback `Host` header and rejects cross-site mutations;
- serves a restrictive Content Security Policy and no external scripts, fonts, or
  analytics;
- sets `no-store`, `no-referrer`, frame denial, and same-origin resource headers;
- accepts an actual secret value only on the dedicated vault-write endpoint, passes it
  directly to the OS vault, clears the password form, and never returns the value;
- exposes only secret references in snapshots and provider configuration;
- does not log request bodies, prompts, responses, or the dashboard snapshot.

The printed URL is an access capability for the local process. Treat it as private and
restart the dashboard if it is exposed. On Windows, actual API tokens can be written to
the DPAPI-backed vault through the dashboard or `providerdock secrets`; referenced
environment variables remain the fallback on platforms without a writable OS vault.

## Launch behavior

A browser launch request returns immediately while the existing application launcher
starts the selected client. The dashboard reports `RUNNING`, then `EXITED` or `FAILED`.
The Codex runtime still owns temporary configuration, recovery, and bridge cleanup;
Claude Code still receives only its child-process environment. Logical-model routes use
the existing safe fallback and side-effect barriers.

## Provider storefront and navigation

The sidebar separates providers, model storefront, launch, routes/profiles, activity,
and secret settings. Each provider card opens its own model storefront. The provider
creation form accepts the portal site and a separate account token alongside the
inference URL/key. Optional New API metadata adds site pricing, group multipliers,
per-request rates and published performance to the storefront without overwriting
manual usage estimates. Unknown/dynamic rates and stale observations remain explicit.
See [the Russian setup guide](model-storefront-ru.md). UI styling is inspired by
[UI Tools](https://github.com/ui-layouts/ui-tools), with no new frontend dependencies.
