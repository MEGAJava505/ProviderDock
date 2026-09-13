# ProviderDock project map

ProviderDock is a local multi-provider manager and compatibility gateway for coding agents. The executable entrypoint is `src/cli.ts`; the public module surface is re-exported by `src/index.ts`.

## Runtime flow

`src/cli.ts` -> `src/cli/provider-dock-cli.ts` -> `src/application/provider-dock-application.ts` -> provider repositories, diagnostics, dashboards, and agent launchers.

`src/application/create-default-application.ts` resolves persistent paths, builds repositories and provider adapters, then wires the Codex and Claude launchers. `src/application/provider-dock-application.ts` exposes provider management, probing, model routing, launch, and UI operations.

## Agent launchers

- `src/clients/codex/codex-launcher.ts` resolves a route, prepares a provider-scoped Codex runtime, sets `CODEX_HOME`, and starts the terminal process.
- `src/clients/codex/codex-runtime-session.ts` creates temporary Codex profiles, model catalogs, manifests, session retention, and recovery.
- `src/clients/claude/claude-launcher.ts` creates the managed Anthropic bridge, sets `CLAUDE_CONFIG_DIR`, and starts Claude Code.
- `src/clients/agent-terminal-process.ts` opens the visible Windows terminal and runs the selected agent.
- `src/clients/agent-session-home.ts` owns provider-scoped session directories and retention.
- `src/clients/agent-skills-runtime.ts` links the global `~/.agents/skills` directory into each native agent home. It is shared by Codex and Claude launch paths, so nested agents inherit the prepared home and link.

## Provider and protocol layers

- `src/core/providers/` contains provider profiles, adapters, model access, catalogs, HTTP, and plugin loading.
- `src/providers/` contains built-in and provider-specific adapters.
- `src/bridge/` contains Responses and Anthropic loopback bridges, fallback routing, replay protection, and stream relays.
- `src/protocols/` contains canonical, OpenAI Chat, and Anthropic message translations.
- `src/core/fallback/` contains logical models, route selection, circuit breaking, and fallback policy.

## Persistence and security

- `src/core/profiles/` stores prompt and project profiles.
- `src/core/usage/`, `src/core/health/`, and `src/core/portals/` store usage, health, and provider portal state.
- `src/core/security/` contains secret stores, Windows DPAPI protection, and error redaction.
- `resolveProviderDockPaths` centralizes the user data directory and runtime homes.

## UI and diagnostics

`src/ui/` contains the local dashboard server, HTML/CSS/script assets, storefront, activity views, and project directory picker. `src/diagnostics/` contains provider doctor and capability snapshots.

## Tests

`tests/` mirrors the public seams: launchers and runtime sessions, bridges and protocol translations, repositories, dashboards, provider adapters, and CLI behavior. `tests/agent-skills-runtime.test.ts` covers global skills discovery, link reuse, and conflict safety.

## Configuration and extension points

- `PROVIDER_DOCK_HOME` changes the persistent ProviderDock data root.
- `CODEX_HOME` and `CLAUDE_CONFIG_DIR` select native agent homes.
- `PROVIDERDOCK_AGENT_SKILLS_DIR` overrides the global skills source; default is `<user-home>/.agents/skills`.
- `PROVIDER_DOCK_PLUGINS` loads provider plugin modules.
- `src/core/plugins/provider-plugin-sdk.ts` and `provider-plugin-loader.ts` define the plugin boundary.

## Build and verification

`npm run typecheck` validates TypeScript. `npm test` runs the Vitest suite. `npm run build` emits `dist/`, and `npm run check:balances` builds then verifies provider balance checks.
