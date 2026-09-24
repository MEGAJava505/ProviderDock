# ProviderDock project map

ProviderDock is a local multi-provider manager and compatibility gateway for coding agents. The executable entrypoint is `src/cli.ts`; the public module surface is re-exported by `src/index.ts`.

The current OMP migration backlog and stop gates are in [REMAINING_PLAN.md](omp-migration/REMAINING_PLAN.md); the [agent handoff](omp-migration/AGENT_HANDOFF.md) is the execution entrypoint. Dated verification notes below are historical checkpoints, not current launch authorization.

## Runtime flow

`src/cli.ts` -> `src/cli/provider-dock-cli.ts` -> `src/application/provider-dock-application.ts` -> provider repositories, diagnostics, dashboards, and agent launchers.

`src/application/create-default-application.ts` resolves persistent paths, builds repositories and provider adapters, wires the legacy Codex/Claude launchers, and composes the direct OMP launcher. `createDefaultProviderDock()` and `createDefaultProviderDockAsync()` return both the existing `ProviderDockApplication` and `OmpLaunchService`. `src/application/provider-dock-application.ts` exposes provider management, probing, model routing, launch, and UI operations.

## Agent launchers

- `src/clients/codex/codex-launcher.ts` resolves a route, prepares a provider-scoped Codex runtime, sets `CODEX_HOME`, and starts the terminal process.
- `src/clients/codex/codex-runtime-session.ts` creates temporary Codex profiles, model catalogs, manifests, session retention, and recovery.
- `src/clients/claude/claude-launcher.ts` creates the managed Anthropic bridge, sets `CLAUDE_CONFIG_DIR`, and starts Claude Code.
- `src/clients/agent-terminal-process.ts` opens the visible Windows terminal and runs the selected agent.
- `src/clients/agent-session-home.ts` owns provider-scoped session directories and retention.
- `src/clients/agent-skills-runtime.ts` links the global `~/.agents/skills` directory into each native agent home. It is shared by Codex and Claude launch paths, so nested agents inherit the prepared home and link.

### OMP migration work in progress

The default composition now exposes a direct OMP launch seam for explicit dashboard and CLI routes. Legacy Codex/Claude routes still exist, no real-provider pilot has run, and production cutover has not been accepted. Current acceptance evidence and limitations: `docs/omp-runtime-runbook-ru.md`.

- `src/clients/omp/omp-config-compiler.ts` compiles explicitly selected provider/account/model routes to non-secret OMP config; unresolved `auto` and unsupported auth/endpoint semantics fail closed.
- `omp-credentials.ts` resolves only selected secret references into an ephemeral child environment.
- `omp-runtime-paths.ts` defines provider/account-scoped managed paths.
- `omp-runtime.ts` verifies artifact/cwd/storage/config/credentials, rejects unreviewed project bootstrap settings, and prepares isolated read-only pilot runs. It does not spawn processes.
- `omp-run-repository.ts` persists validated lifecycle records and safe diagnostics with exclusive writer locking and atomic replacement; it does not infer process liveness.
- `omp-rpc-projection.ts` projects private RPC control frames onto a minimal safe lifecycle shape. Raw OMP `get_state` frames may contain resolved authorization headers and must not reach logs/browser APIs.
- `src/application/omp-launch-service.ts` enforces explicit provider/model/account/project identity, the separate read-only pilot acknowledgement, preflight-before-launch, safe diagnostics, and direct supervisor delegation.
- `omp-process-supervisor.ts` owns actual OMP spawn and lifecycle: TUI inherits the real terminal, RPC uses private pipes plus the safe projection, and restart reconciliation marks orphaned runs `INTERRUPTED`. It is implemented, fake-process tested, and composed behind `OmpLaunchService` for dashboard/CLI launches.
- `src/migration/` contains allowlisted inventory/verified snapshot and dry-run/staged portal-recovery helpers. Active recovery and legacy deletion are not automatic.
- `src/migration/omp-provider-mapping.ts` and `omp-provider-inventory.ts` provide read-only, evidence-fingerprinted provider assessments without auth/protocol/account/portal inference or launch authorization. The September 16 inventory contains 18 profiles (not the earlier 17); all remain pending. See `docs/omp-provider-mapping-2026-09-16.md`.
- `src/migration/omp-provider-evidence.ts` reconciles loopback smoke reports and provides a read-only evidence snapshot source. `OmpLaunchService` requires each route decision's inventory/report/executable/source hashes and exact model claim to match that snapshot; the default composition reads `migration/omp-provider-evidence.json` and never creates it.
- `src/core/security/secret-revision.ts` binds a Doctor result and pilot launch to opaque encrypted-secret generations; OMP rechecks the selected generation around credential resolution. Unversioned secret stores cannot authorize an authenticated pilot route.
- `scripts/omp-provider-local-smoke.mjs` tests supported explicit model wire shapes using the pinned OMP binary, fixture credentials and loopback only. The latest run passed 18 cases for nine configured models; nine other profiles are explicitly skipped. Responses continuation must carry the preceding function call or a matching previous response ID.
- `scripts/omp-{runtime,rpc,tui}-smoke.mjs` exercise the actual isolated OMP binary with fixtures, without real inference. The TUI harness uses the separately source-built native ConPTY binding.

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

`src/ui/` contains the local dashboard server, HTML/CSS/script assets, storefront, activity views, and project directory picker. The dashboard exposes direct OMP preflight/launch/history/cancel endpoints and gates submit on successful preflight plus acknowledgement. `src/diagnostics/` contains provider doctor and capability snapshots.

## Tests

`tests/` mirrors the public seams: launchers and runtime sessions, bridges and protocol translations, repositories, dashboards, provider adapters, and CLI behavior. `tests/agent-skills-runtime.test.ts` covers global skills discovery, link reuse, and conflict safety.

## Configuration and extension points

- `PROVIDER_DOCK_HOME` changes the persistent ProviderDock data root.
- `CODEX_HOME` and `CLAUDE_CONFIG_DIR` select native agent homes.
- `PROVIDERDOCK_AGENT_SKILLS_DIR` overrides the global skills source; default is `<user-home>/.agents/skills`.
- `PROVIDER_DOCK_PLUGINS` loads provider plugin modules.
- `src/core/plugins/provider-plugin-sdk.ts` and `provider-plugin-loader.ts` define the plugin boundary.

## Build and verification

`npm run typecheck` validates TypeScript. `npm test` runs the Vitest suite. `npm run build` emits `dist/`, and `npm run check:balances` builds then verifies provider balance checks. Local verification on 2026-09-15 passed the focused OMP integration files, full suite (**86 files / 841 tests**), typecheck, build, dashboard UI smoke, and `git diff --check`.

September 16 Step 4 verification supersedes that suite count: **88 files / 868 tests**, typecheck, build, dashboard UI smoke, and `git diff --check` passed. The actual-binary per-profile fixture smoke passed **16/16** cases; this is not real-provider acceptance.


September 18, 2026 supersedes the earlier local matrix counts: `npm test` passed **91 files / 898 tests**, `npm run typecheck`, `npm run build`, sequential `node scripts/dashboard-ui-smoke.mjs`, and `git diff --check` passed. The Step 4 boundary is still offline assessment plus loopback fixture smoke: all 18 profiles remain `pending`, no real-provider or paid call occurred, and no route-decision file was authored. The saved smoke report is reconciled by `src/migration/omp-provider-evidence.ts`; public OMP launch now requires an exact fingerprint-bound decision plus a matching read-only evidence snapshot, and fails closed with `OMP_ROUTE_NOT_ACCEPTED` when either is missing or stale. Windows rename-sharing and bridge shutdown races have regression coverage.

September 19, 2026 revalidated the current 18-profile/38-file allowlist (`drift=false`) and reran the pinned loopback smoke (**16/16**, eight exact provider/model pairs, ten explicit skips). A separately verified `launchAuthorized:false` snapshot is retained only under the ignored `.provider-dock` evidence workspace; the live evidence and route-decision files remain absent. This is still not real-provider acceptance.

The September 19 verification follow-up reran the full local matrix from the
current tree (**91 files / 898 tests**, typecheck, build, sequential dashboard
smoke, and `git diff --check` all passed). A non-authoritative route-decision
input worksheet is retained under the ignored evidence workspace; it contains
no credentials and does not authorize or publish any route.

The serialized evidence seam in `src/migration/omp-provider-evidence.ts` now
computes the inventory hash from exact input bytes before reconciliation.
Focused evidence tests and the full suite are green (**91 files / 899 tests**);
this remains offline provenance validation, not real-provider acceptance.

The direct OMP launch seam also rechecks the pinned compiler for each
fingerprint-bound route decision before runtime/credential resolution. This
keeps unsupported header/auth/query transports fail-closed; the current
verification is **91 files / 900 tests** with typecheck, build, dashboard
smoke, and diff-check passing.

The assessment publication boundary is also covered: the ignored-only helper
`scripts/lib/omp-provider-evidence-publication.mjs` rejects live evidence and
route-decision destinations and writes the snapshot plus verification sidecar
exclusively without replacement. Current verification is **91 files / 902
tests**, typecheck, build, dashboard smoke, helper syntax check, and diff-check;
the live evidence and route-decision files remain absent and all 18 profiles are
still `pending`.

Tests for the evidence and assessment-publication boundary are intentionally
co-located in `tests/omp-provider-evidence.test.ts`; the prior standalone
publication test file was removed without reducing coverage. The migration
rule is to consolidate cohesive test domains, not unrelated suites.

`evaluateOmpRouteDecisionForPilot()` is the shared offline gate for explicit
route review and `OmpLaunchService`; it rechecks evidence/profile/compiler
provenance and fails closed before credentials or runtime. Current verification
is **91 test files / 904 tests** with typecheck, build, dashboard smoke and
diff-check passing; all 18 profiles remain `pending`.

September 23 cohesive consolidation supersedes only the current suite-size
count: provider-error/redaction and agent-approval/preference tests now share
their existing domain files. The suite is **89 files / 932 tests**, with all
tests and typecheck passing. A subsequent recovery input-capture regression
brings the current total to **89 files / 933 tests**, with typecheck and build
passing. Suites across different interfaces remain separate
to preserve failure locality.

Portal recovery tests retain one exact 280047-byte historical corruption case
and use a small NUL fixture elsewhere. Commit `b4065e9` reduced that focused
suite from 17.35s to 2.42s without changing its 37 cases; the complete suite
remains **89 files / 933 tests**.

September 23 adds the first live Step 4 pilot decision. VSLLM is bound to
account `16568`, `https://vsllm.cc/v1`, `glm-5.2-free`, and
`openai-responses`; Doctor level 3 proved text/streaming/tools, the pinned
actual-binary loopback smoke passed both exact protocol cases, and production
preflight passes. Evidence is now protocol-bound, so one transport's smoke
cannot authorize another. No OMP child or extra inference was launched during
publication; the next boundary is the separately paid one-shot OMP pilot, not
cutover.

The corresponding full verification is **89 files / 937 tests**, typecheck,
build, dashboard UI smoke, provider-smoke syntax and diff-check. The added
coverage stayed in existing cohesive test files.

Post-review v2 status supersedes the September 23 acceptance statement above.
The route decision must match a separately stored Doctor snapshot, including
the current configuration and credential reference, model, protocol, level-3
PASS, timestamp, and text/streaming/tools capabilities. The original live v1
evidence and decision are now non-authorizing; preflight reports that v2
regeneration is required. A stricter actual-binary loopback run passed
**18/18** cases, and v2 local evidence is staged in the ignored assessment
workspace. A new configuration-bound Doctor run and v2 decision are still
required before the real OMP pilot.
