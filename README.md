# ProviderDock

ProviderDock is the implementation of the Russian-language [Provider Switcher technical specification](./PROVIDER_SWITCHER_TECHNICAL_SPEC_RU.md): a local multi-provider manager and compatibility gateway for Codex CLI and Claude Code.

The application is intentionally not another coding agent. It discovers and monitors models, translates incompatible provider protocols, launches an existing coding client with an isolated runtime configuration, and prevents unsafe retries after streamed output or tool side effects.

## Current status

Development has started with Phase 1. The first core slice provides:

- validated provider profiles that contain secret references, never plaintext API keys;
- atomic file-backed provider CRUD;
- an extensible provider-adapter registry;
- OpenAI-compatible model discovery;
- manual/discovered model merging;
- normalized provider health states and errors;
- a management CLI for provider CRUD, model discovery, and health probes;
- an isolated Codex runtime profile, launcher, and checksum-guarded crash recovery;
- a loopback-only native Responses bridge with Codex model capabilities and event-aware SSE repair;
- unit tests using fully local HTTP mocks.

There is no production UI yet. The Codex launcher automatically owns a native Responses
bridge when a profile needs query authentication or uses the AgentRouter adapter.
Translation for Chat Completions/Anthropic providers remains the next compatibility work.

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

```bash
node dist/cli.js providers set \
  --id agentrouter \
  --name AgentRouter \
  --base-url https://example.invalid/v1 \
  --auth-kind bearer \
  --secret-ref AGENTROUTER_API_KEY

node dist/cli.js providers list
node dist/cli.js probe agentrouter
node dist/cli.js providers remove agentrouter
```

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

node dist/cli.js recover codex
```

Direct Codex routes currently require a Responses-compatible provider. Query-authenticated
Responses providers and AgentRouter are relayed automatically by a per-session bridge.
Chat Completions and Anthropic translation are not implemented yet. An already-running
external compatibility bridge can be selected explicitly through `--bridge-url`.
Bridge behavior is documented in [`docs/responses-bridge.md`](./docs/responses-bridge.md).
Runtime details and recovery guarantees are documented in
[`docs/codex-runtime.md`](./docs/codex-runtime.md).

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
