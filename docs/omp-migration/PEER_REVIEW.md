## M10-R — отчёт исполнителя

- **Дата:** 18 октября 2026
- **Ветка / HEAD:** omp-integration / 5025cb31ae9dfa8c8e64bbc29e8a39513f6a5872
- **Статус:** отчёт исполнителя, ожидает независимого review
- **Scope:** локальный M10-R пакет; внешний VSLLM/Doctor, live v2, настоящий omp.exe, Bun/importer, живые homes/transcripts/keys, OS ACL/isolation, cutover и commit/push/PR не выполнялись.

## Сделано

- Зафиксирован continuation snapshot текущего dirty worktree в .scratch/m10-r-continuation-2026-10-17/inventory.json. Он честно помечен как continuation snapshot, потому что исходный pre-edit baseline M10-R до продолжения не был сохранён. Чужие изменения не откатывались.
- Исправлен RED-дефект UI: поздний успешный preflight после смены selection или повторного открытия диалога больше не восстанавливает gate. Добавлены request token, проверка открытого диалога и exact current input.
- Расширен runtime guard для доказанного upstream dotenv grammar: .env, .env.local, .env.<NODE_ENV>, .env.<NODE_ENV>.local; добавлена regression-параметризация до 23 project bootstrap cases.
- Усилен browser smoke: CDP command deadlines, pending rejection при close/error/malformed message, bounded discovery/body reads, bounded cleanup/diagnostics, ранний spawn fault, owned-path checks, отдельный evidence directory, success только после cleanup и без nested ok:true при fault.
- Smoke проверяет Brave через PROVIDERDOCK_TEST_BROWSER, реальный HTTP 202 launch reply и сопоставление runId с disk/UI, provider/account/model/project invalidation, checkbox preservation, late selection/reopen preflight, ready/blocked/unknown reasons, browser cancel/repeated terminal cancel, restart records, side-effect count и unexpected JS/network/HTTP failures.
- UI показывает безопасные reason labels для ready/blocked/unknown nodes; blocked fixture содержит account-identity-mismatch, unknown fixture показывает отсутствие Doctor/evidence.
- Permission boundary переписан по pinned consumer’ам: approval/full-auto, absolute read, settings/deep merge, exact dotenv grammar, fetch consumers, MCP project/user split, extension/skills/rules controls, HOME/USERPROFILE/PI/XDG и native resume boundary.

## RED → GREEN

- Late preflight: Brave smoke сначала получил false !== true — stale response re-enabled submit; после token/current-input fix normal smoke passed.
- Dotenv: добавленные .env.development.local, .env.production.local, .env.test.local, .env.staging.local дали 4 FAIL / 33 PASS; после grammar-based guard tests/omp-runtime.test.ts дал 37/37 PASS.
- Fault harness: negative runner сначала выявил ненормализованный spawn/network cause; после сохранения исходной причины и structural report прошли все 4 phases.

## Проверено

- node node_modules/vitest/vitest.mjs run tests/omp-runtime.test.ts tests/omp-launch-service.test.ts tests/omp-process-supervisor.test.ts tests/omp-integration-harness.test.ts tests/provider-dashboard-omp.test.ts tests/omp-route-readiness-preview.test.ts tests/provider-dashboard-server.test.ts → 7 files / 198 tests PASS.
- npm.cmd run typecheck → exit 0.
- npm.cmd run build → exit 0, jsEmitted:130.
- node --check scripts/omp-browser-stack-smoke.mjs and node --check scripts/dashboard-ui-smoke.mjs → exit 0; git diff --check → exit 0 (only existing CRLF normalization warnings).
- PROVIDERDOCK_TEST_BROWSER=C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe node scripts/omp-browser-stack-smoke.mjs → exit 0; Brave 155.1.97.59; evidence .scratch/m10-browser-stack-evidence-sau075/. Normal report has browserProfileRemoved:true, rootRemoved:true, HTTP launch status 202 for all three launches, same runIds in UI/store, 4 selection invalidations, 2 late-preflight denials, cancel HTTP/disk CANCELLED, repeated terminal cancel unchanged, side effect count 1 after failure/restart, and ready/blocked/unknown reason labels.
- PROVIDERDOCK_TEST_BROWSER=... node scripts/omp-browser-stack-smoke.mjs --negative → exit 0; child fault phases spawn, cdp-close, network, cleanup each exited 1, produced ok:false structural reports without nested success, and confirmed owned-root cleanup.
- Existing node scripts/dashboard-ui-smoke.mjs and node scripts/dashboard-ui-smoke.mjs --negative were previously run with Brave: normal exit 0 / 38 checks, negative exit 0 / 2 of 2.
- node scripts/omp-import-probe.mjs → exit 0, pinned checkout HEAD exact, drift:[], import capability unsupported.
- Existing integration/supervisor evidence covers 401/403/429/503, broken stream, pre-ready exit, side-effect-then-error, restart/orphan → INTERRUPTED without foreign PID signal, unconfirmed stop and idempotent cancel. Native resume is documented separately as NOT PROVEN.
- node node_modules/vitest/vitest.mjs run → 83 files / 1197 tests PASS outside the sandbox.
- Final sequential rerun on 18 October: new normal and negative Brave stack smokes, plus existing dashboard normal and negative smokes, all exit 0; no parallel browser cleanup race.
- Local Markdown link audit across AGENT_HANDOFF, REMAINING_PLAN, runtime runbook, permission boundary, report and archived journal → PASS (163 links checked).

## Evidence

- Normal report: .scratch/m10-browser-stack-evidence-G3wkuO/report.json.
- Visual review: ready-preview.png, blocked-preview.png, unknown-preview.png, ready-preflight.png, cancelled.png; inspected ready/preflight, blocked, unknown and cancelled states.
- Negative reports: .scratch/m10-browser-negative-*/m10-browser-stack-evidence-*/report.json.
- Archived prior journal: docs/omp-migration/archive/2026-10-17-m10-r-pre-review-peer-review.md.

## Changed files

- scripts/omp-browser-stack-smoke.mjs
- src/ui/provider-dashboard-script.ts
- src/ui/provider-dashboard-css.ts
- src/clients/omp/omp-runtime.ts
- tests/omp-runtime.test.ts
- docs/omp-migration/STEP6_PERMISSION_BOUNDARY.md
- docs/omp-migration/REMAINING_PLAN.md
- docs/omp-runtime-runbook-ru.md
- docs/omp-migration/PEER_REVIEW.md
- docs/omp-migration/archive/2026-10-17-m10-r-pre-review-peer-review.md

## Ограничения

- Real OMP execution, paid Doctor, live v2, external network egress, OS isolation, native resume and live credentials remain NOT PROVEN/BLOCKED.
- The sandboxed full suite had one environment-specific DPAPI failure; the same full suite passed outside the sandbox with 83 files / 1197 tests. The targeted suite, typecheck, build, Brave normal/negative and pinned import probe are also fresh gates.
- External VSLLM subagent checks failed with HTTP 503 and were not used as evidence.

## Skills

- diagnosing-bugs — RED→GREEN feedback loops and fault-path verification.

## Review status

This is an executor report only and awaits independent review. It does not close the overall migration goal.
