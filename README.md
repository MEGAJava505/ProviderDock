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
- unit tests using fully local HTTP mocks.

There is no production UI or client launcher yet.

## Development

Requirements: Node.js 20 or newer.

```bash
npm install
npm run typecheck
npm test
npm run build
```

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

