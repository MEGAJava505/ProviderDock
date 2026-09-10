# Usage and cost dashboard

ProviderDock records normalized request usage for sessions that pass through a
managed Codex or Claude bridge.

## Model pricing

Pricing is optional and belongs to a provider profile. Configure rates per
million tokens, plus an optional web-search rate per thousand requests:

```text
providerdock providers set ... \
  --pricing MODEL=INPUT,OUTPUT[,CACHE_READ[,CACHE_WRITE[,WEB_SEARCH]]][@CURRENCY]
```

Example:

```text
--pricing gpt-x=2.00,10.00,1.00@USD
```

This means:

- input: 2.00 USD per million uncached tokens;
- output: 10.00 USD per million tokens;
- cache reads: 1.00 USD per million tokens;
- cache writes fall back to the regular input rate because no explicit rate is
  present.

ProviderDock does not download or guess current vendor pricing. Rates are
explicit profile metadata so historical calculations remain reproducible.

## Normalized telemetry

Each terminal response with a usable `usage` object records:

- provider and physical model;
- optional logical model;
- Codex or Claude Code;
- actual upstream protocol;
- completed/incomplete outcome;
- uncached input tokens;
- cache-read and cache-write input tokens;
- output and reasoning-output tokens;
- web-search request count;
- calculated cost in integer currency microunits when pricing exists.

Events are deduplicated, bounded to the latest 10,000 entries, schema-validated,
size-limited, and atomically stored in:

```text
~/.provider-switcher/usage/events.json
```

Telemetry contains no prompts, response text, tool arguments/results, headers,
credentials, or raw provider bodies. A telemetry write failure is isolated and
cannot change response, fallback, or replay semantics.

## CLI

```text
providerdock usage list [--provider ID] [--model MODEL] \
  [--client codex|claude-code] [--since ISO] [--until ISO] [--json]

providerdock usage summary [--provider ID] [--model MODEL] \
  [--client codex|claude-code] [--since ISO] [--until ISO] [--json]
```

`usage list` shows individual request events. `usage summary` groups requests,
tokens, outcomes, and costs by provider/model/client.

## Coverage boundary

Claude Code always uses the managed bridge and is covered. Codex requests are
covered when routing uses the managed bridge (translation, fallback,
query-auth, AgentRouter, or forced managed routing). Direct Codex-to-provider
requests do not pass through ProviderDock and therefore cannot be observed
without reading client-owned logs, which ProviderDock intentionally does not
do.
