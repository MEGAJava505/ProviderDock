# Persisted health and model dashboard

Every manual `providerdock probe PROVIDER` records a bounded, non-secret
provider snapshot. Every manual `providerdock doctor PROVIDER` that resolves a
model also records the latest per-model capability/compatibility snapshot.
Managed Codex and Claude bridge requests independently record content-free
runtime health signals, including successful responses that contain no token
usage.

## Storage

Health state is stored at:

```text
~/.provider-switcher/health/history.json
```

The document is versioned, schema-validated, size-bounded, and written through
an atomic temporary-file rename. Each provider keeps:

- its latest normalized health snapshot, when a probe has run;
- the latest discovered/manual model catalog;
- up to 256 provider-level history entries;
- one latest Doctor snapshot per model;
- up to 256 real-traffic outcomes with provider/model, client, protocol,
  non-secret session/request correlation IDs, optional logical model,
  normalized status/error, HTTP status, and safe execution phase.

Persisted data includes normalized status/error type, check time, latency,
model count, applied compatibility fixes, sanitized error message, HTTP status,
measured text/streaming/tools/model-discovery capabilities, Doctor level and
verdict, and separate Codex/Claude compatibility status. Unmeasured
capabilities remain `UNKNOWN`; transient authentication, network, timeout, and
rate-limit failures do not get misreported as unsupported capabilities.

The compatibility matrix reflects the protocol path actually proven by
Doctor:

- Responses: Codex `NATIVE`, Claude Code `INCOMPATIBLE`;
- Chat Completions: both clients `ADAPTER`;
- Anthropic Messages: Codex `INCOMPATIBLE`, Claude Code `NATIVE`.

The file deliberately excludes raw HTTP bodies, request bodies, headers,
prompts, responses, token counts, cookies, and secret values. Only normalized,
sanitized health errors are retained. Upstream error JSON is reduced to a small
allowlist of diagnostic fields, obvious credential forms are redacted, control
characters are removed, and both bytes read and characters stored are bounded.

## Automatic health monitor

While the local web dashboard is running, ProviderDock schedules metadata-only
model discovery probes. The policy uses each profile's `metadataTtlMs`, treats
the latest successful managed request as a stronger recent health signal, and
applies bounded exponential backoff after consecutive failures. It never sends
inference prompts in the background; Doctor inference remains an explicit
operator action.

The dashboard combines probe, Doctor, and real-traffic state. A newer traffic
signal takes precedence over an older probe for provider/model health, while
probe latency and discovered model counts remain clearly probe-derived.
It also reconstructs bounded managed-session activity: distinct request count,
failed/fallback attempts, and protocol errors. This is technical activity only;
no chat, prompt, response, tool payload, or project source is stored.
Bridge requests enqueue health writes without waiting on disk; normal bridge
shutdown flushes the tracked queue so observability does not delay fallback or
the response hot path.

Deleting a provider also deletes its persisted health record. If health cleanup
fails, ProviderDock restores the provider profile instead of reporting a
partially completed removal.

## CLI

Run a probe to refresh provider/model health:

```text
providerdock probe PROVIDER [--json]
```

Run Doctor manually to refresh a model capability snapshot:

```text
providerdock doctor PROVIDER --model MODEL --level 0|1|2|3 [--json]
```

Inspect the persisted dashboard:

```text
providerdock health list [--json]
providerdock health show PROVIDER [--json]
providerdock health history PROVIDER [--json]
```

`health list` gives one row per provider, including diagnostic-only records
that exist before the first probe, and uses a newer managed-traffic status when
it supersedes the latest metadata probe. `health show` includes the current
model catalog, per-model capability/client matrix, and the latest bounded
content-free traffic rows; `health history` renders bounded probe time-series
rows. Normalized failures include the same explanation and suggested action
used by bridge responses and the web dashboard.

`launch auto` consults the exact provider/model diagnostic when one exists.
Explicit prompt/provider client preferences still win. Otherwise `NATIVE`
outranks `ADAPTER`, which outranks `UNKNOWN`, while a diagnosed
`INCOMPATIBLE` client is avoided. If there is no measurement, the stable
protocol heuristic remains the fallback.

## Current boundary

Background monitoring is metadata-only. Minimal inference, richer
parallel-tools/reasoning/images/cancellation measurements, and client version
drift remain explicit/future diagnostic layers.
