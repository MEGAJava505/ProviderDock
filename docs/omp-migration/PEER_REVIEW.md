## M11-P2 — отчёт исполнителя Sol (doc-only, 18 октября 2026)

Это уточняющий отчёт по двум замечаниям P2 координатора. Изменены только `REMAINING_PLAN.md`, `M11_EXTERNAL_PILOT_PLAN.md` и этот отчёт; код, тесты, `.scratch`, `AGENT_HANDOFF.md` и внешние системы не затрагивались.

**P2-1 — удалённые status-вставки из `REMAINING_PLAN.md`:** удалены ровно три датированных блока внутри глав 5, 6 и 7; остальной текст и история сохранены.

1. Глава 5:

   ```text
   **Фактический статус, 18 октября 2026:** локальные критерии главы 5 закрыты: M10-R2 принят полностью, включая browser acceptance (Chrome for Testing 155, normal 12/12, negative 4 фазы; evidence сохранена). Остаётся только внешний M11 evidence для actual `omp.exe`, native resume, external egress/isolation и живой provider route. Подготовка M11 ограничена [doc-only планом и evidence schema](AGENT_HANDOFF.md); это не разрешение на внешний запуск.
   ```

2. Глава 6:

   ```text
   **Фактический статус, 18 октября 2026:** не начата. M11-P создаёт только план и schema доказательств; реальный pilot acceptance, OMP-only acceptance, production default и удаление legacy не разрешены.
   ```

3. Глава 7:

   ```text
   **Фактический статус, 18 октября 2026:** не начата; разрешена только документационная подготовка M11-P. Финальное обновление runbook и closure требуют принятого evidence внешнего пилота и не могут следовать из local fixture.
   ```

**P2-2 — новое правило Phase 1/gate (дословно):**

> Пофазное правило входного gate: перед каждой внешней фазой проверяется только соответствующий границе A-gate, а не все четыре сразу: Phase 1–2 (actual `omp.exe`) — A1, Phase 3 (native resume) — A2, Phase 4 (external egress/isolation) — A3, Phase 5 (живая provider route) — A4. Отсутствие ещё не открытых A2–A4 не блокирует Phase 1/preflight или Phase 2; неполный соответствующий gate блокирует только свою фазу. Phase 6 — rollback observation по существующим records и без новой A-гейт.

Phase 1 теперь явно входит только с заполненным и одобренным A1; A2–A4 на preflight не требуются. Stop-rule Phase 1 больше не требует A3 isolation-attestation заранее; проверка A3 остаётся входным gate Phase 4.

**Проверки:** `git diff --check` — PASS; обязательный `rg -n 'M11_EXTERNAL_PILOT_PLAN|M10-R2|actual omp\.exe|native resume|external egress|cutover' docs/omp-migration/AGENT_HANDOFF.md docs/omp-migration/REMAINING_PLAN.md docs/omp-runtime-runbook-ru.md docs/omp-migration/M11_EXTERNAL_PILOT_PLAN.md` — PASS; статусы проверены и не называют внешний пилот выполненным.

**Внешние действия и границы:** внешний пилот, actual `omp.exe`, native resume, external egress/OS isolation, живая provider route, live credentials/sessions/homes, paid requests, cutover, commit, push и PR не выполнялись. Все четыре внешние границы остаются `BLOCKED/NOT PROVEN`: actual `omp.exe`, native resume, external egress/isolation и живая provider route.

---

## M11-P — отчёт исполнителя Sol (doc-only preparation completed, 18 октября 2026)

Это отчёт исполнителя, а не coordinator verdict.

**Изменённые файлы:** создан [M11_EXTERNAL_PILOT_PLAN.md](M11_EXTERNAL_PILOT_PLAN.md); обновлены только верхние актуальные status-блоки [REMAINING_PLAN.md](REMAINING_PLAN.md) и [omp-runtime-runbook-ru.md](../omp-runtime-runbook-ru.md); этот отчёт добавлен в начало `PEER_REVIEW.md`. Код, тесты, `.scratch`, `AGENT_HANDOFF.md` и исторические разделы не изменялись.

**Содержание плана и schema:** план фиксирует цель M11 и четыре непокрытые границы — actual `omp.exe`, native resume, external egress/isolation и живую provider route. Для каждой границы заданы отдельные A1–A4 authorization gates с scope/project, responsible/approver, credential class и route, cost/request limits, UTC window и stop criterion; пока все gates `BLOCKED`. Описаны шесть последовательных фаз с входным gate, безопасным наблюдаемым сценарием, ожидаемым evidence, fail/stop правилом и тем, что evidence не заменяет. Явно исключены cutover, удаление legacy, commit/push/PR и production default со ссылкой на главу 6; добавлен минимальный immutable-snapshot rollback/runbook. Evidence schema требует `phase`, `evidenceId`, UTC window, actor/approver, authorization reference, redacted project/route IDs, binary version/SHA-256, environment/OS-isolation attestation, credential class без значения, request/cost counters, preflight/run IDs, native-resume linkage, network-egress observation, expected/actual result, side-effect assessment, rollback decision, artifact locations, redaction policy и integrity hash. Зафиксированы append-only, запрет secrets/raw headers/cookies/tokens/transcripts/absolute user paths, `NOT PROVEN`/`BLOCKED` для неполных записей, запрет повышать local synthetic M10-R2 и минимальные evidence/stop outcomes для каждого claim.

**Выполненные локальные проверки:** до изменений записан `git status --short`, существующий dirty worktree сохранён. После каждого из четырёх документов прошли `git diff --check` и обязательный `rg` по handoff, плану, remaining plan и runbook; локальные ссылки на новый план присутствуют. Это doc-only проверка; кодовые и внешние пилотные тесты не запускались.

**Точные неоткрытые внешние границы:** actual `omp.exe` — `BLOCKED/NOT PROVEN`; native resume — `BLOCKED/NOT PROVEN`; external egress/isolation — `BLOCKED/NOT PROVEN`; живая provider route — `BLOCKED/NOT PROVEN`. M10-R2 остаётся локальным принятым evidence главы 5 и не закрывает эти claims.

**Подтверждение отсутствия внешних действий:** в рамках M11-P не запускались `omp.exe` или native resume, внешняя сеть/egress, OS isolation/ACL, live provider route, live credentials/sessions/homes или paid requests; 503/5xx операции не выполнялись и не повторялись. Cutover, изменение production default, удаление legacy, commit, push и PR не выполнялись.

> Предыдущие отчёты перенесены в [архив 18 октября 2026](archive/2026-10-18-m10r2-peer-review-archive.md).

## M10-R2 — отчёт исполнителя, 18 октября 2026

**Статус: локальные критерии M10-R2 выполнены; browser gate отдельно BLOCKED системной средой.**

- **Причина RED:** `read()` проверял `assertRegular()` на открытом дескрипторе раньше `sameFile()`. При настоящей POSIX atomic replacement старый открытый regular inode после `rename()` получает `nlink=0`, тогда как по текущему пути уже находится новый inode с `nlink=1`; это ошибочно становилось `OMP_RUN_UNSAFE_PATH`, а bounded observer повторяет только `OMP_RUN_CHANGED`.
- **Полный RED до реализации:** `timeout --signal=TERM --kill-after=5s 35s npx vitest run tests/omp-integration-harness.test.ts` → exit **1**, **18 тестов: 16 passed, 2 failed**. `row2: upstream 429 and 5xx...` упал в opened-fstat (`read ...:361`); `reports sha256...` упал в after-read-fstat (`read ...:373`). Оба stack проходили через `assertRegular src/clients/omp/omp-run-repository.ts:201` и выдавали `OmpRunStorageError: OMP_RUN_UNSAFE_PATH`.
- **Подтверждение atomic replacement:** детерминированный probe вставлял собственный `repository.transition(..., "STARTING")` в каждое окно. Для opened-fstat открытый дескриптор: `nlink=0`, `isFile=true`, `isSymbolicLink=false`, `dev=64513`, `ino=1081235`, `size=379`; текущий путь `/tmp/providerdock-m10-r2-probe-YGp1pJ/runs/ef1f5fda-8092-41db-9a0a-f1cb3f8ea898.json`: `nlink=1`, `isFile=true`, `isSymbolicLink=false`, `dev=64513`, `ino=1081236`, `size=430`. Для after-read-fstat дескриптор того же старого inode (`dev=64513`, `ino=1081235`, `nlink=0`, regular) был виден как `/tmp/providerdock-m10-r2-probe-wLlpRD/runs/3005a0d4-903f-4ba1-8496-7e511faa0641.json (deleted)`, а текущий путь имел `dev=64513`, `ino=1081236`, `nlink=1`. Оба чтения вернули `OMP_RUN_CHANGED`, следующий `get()` — `STARTING`; symlink/hardlink не участвовали.
- **Исправление и regression:** добавлен `assertReadIdentity()`. Он допускает только подтверждённый unlink-on-replace (`nlink=0`, regular old inode, текущий путь regular с другой identity) как `OMP_RUN_CHANGED`; `nlink>1`, symlink, non-regular, несогласованные identity/размер и небезопасный текущий путь остаются fail-closed `OMP_RUN_UNSAFE_PATH`. До исправления regression-тесты обоих окон дали **2 failed** с ожидаемым `UNSAFE_PATH`; после — **2 passed**. Полный `npx vitest run tests/omp-run-repository.test.ts` → exit **0**, **44/44**.
- **Bind refusal RED→GREEN:** до исправления временный только-внешний preload, эмулировавший `listen()` error, оставлял полный harness на `NODE_OPTIONS=--require=/tmp/providerdock-deny-loopback.cjs timeout --signal=TERM --kill-after=2s 5s npx vitest run tests/omp-integration-harness.test.ts` на timeout exit **124** (только `RUN v4.1.11`), а `NODE_OPTIONS=--require=/tmp/providerdock-deny-loopback.cjs timeout --signal=TERM --kill-after=2s 5s node scripts/omp-browser-stack-smoke.mjs` завершался exit **13** с `Detected unsettled top-level await` на `startLoopback()`. Теперь оба helper’а слушают `listening` и `error`, имеют конечный deadline, снимают собственные listeners/timers и закрывают только созданные ресурсы. `npx vitest run tests/omp-integration-harness.test.ts -t 'bounded loopback startup'` → **1/1**, exit **0**. `PROVIDERDOCK_OMP_BROWSER_STARTUP_FAULT=refusal timeout --signal=TERM --kill-after=2s 5s node scripts/omp-browser-stack-smoke.mjs` → exit **1**, `loopback startup failed: EADDRINUSE`; `PROVIDERDOCK_OMP_BROWSER_STARTUP_FAULT=hang timeout --signal=TERM --kill-after=2s 5s node scripts/omp-browser-stack-smoke.mjs` → exit **1**, `loopback startup deadline exceeded`; оба завершились bounded без cleanup error.
- **Три последовательных полных harness:** команда `npx vitest run tests/omp-integration-harness.test.ts` выполнена без retries три раза: run 1 exit **0**, **19/19**; run 2 exit **0**, **19/19**; run 3 exit **0**, **19/19**. Новый тест bounded startup объясняет рост с базовых 18 до 19.
- **Общие gates:** команда из handoff с семью файлами → exit **0**, **7 файлов / 199 тестов PASS** (база 198 + один startup regression); dashboard-поднабор `tests/provider-dashboard-omp.test.ts tests/provider-dashboard-server.test.ts` → **56/56**, exit **0**. `npm run typecheck` → exit **0**. `npm run build` → exit **0**, `{"ok":true,"jsEmitted":130,"replacedPriorDist":true,"recovered":false}`. `node --check scripts/dashboard-ui-smoke.mjs` → exit **0**; `node --check scripts/omp-browser-stack-smoke.mjs` → exit **0**; `git diff --check` → exit **0**.
- **Browser: BLOCKED — отсутствуют системные библиотеки Chrome, root недоступен.** Executable: `/home/agent/.cache/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome`. `ldd` → exit **0**, отсутствуют 13 библиотек: `libatk-1.0.so.0`, `libatk-bridge-2.0.so.0`, `libcups.so.2`, `libxkbcommon.so.0`, `libasound.so.2`, `libgbm.so.1`, `libcairo.so.2`, `libpango-1.0.so.0`, `libXcomposite.so.1`, `libXdamage.so.1`, `libXfixes.so.3`, `libXrandr.so.2`, `libatspi.so.0`. `chrome --version` → exit **127**, loader error на `libatk-1.0.so.0`; `id` → uid **1000**, `sudo -n true` → exit **1** из-за `no new privileges`. Профиль пользователя не создавался, browser smoke normal не выдавался за PASS; syntax check и HTTP smoke этот gate не подменяют.
- **Review и ограничения:** просмотрен итоговый diff; постоянных debug probe/preload, секретов, skip, ослабленных assertions и новых P1/P2 не найдено. Изменены только repository, его regression, harness startup, browser smoke startup и этот отчёт; прежние пользовательские изменения `AGENT_HANDOFF.md` сохранены. Commit/push/PR, live-ключи/сессии/homes/transcripts, paid-запросы, Doctor, настоящий OMP, внешняя сеть, cutover и OS-настройки не использовались. Остаточные ограничения: real OMP/native resume/external egress/isolation не доказаны; browser acceptance остаётся BLOCKED и M11/cutover не открываются.

## Дополнение координатора — 18 октября 2026: browser acceptance закрыт

Статус BLOCKED выше был честным на момент отчёта Sol; закрыт после прямой авторизации пользователя (gateway-owner). Через `su root` (примечание: `sudo` отверг пароль пользователя, `su root` принял — проверено `su root -c whoami`) выполнены `apt-get update` и установка 13 недостающих библиотек Chrome; пароль использован только в момент выполнения и не сохранён. Полный список библиотек — в AGENT_HANDOFF.md, «Дополнение — 18 октября 2026». После установки: `ldd chrome` → **0 missing**, `chrome --version` → `Google Chrome for Testing 155.0.8059.84`.

Повтор browser smoke с настоящим Chrome (`PROVIDERDOCK_TEST_BROWSER=/home/agent/.cache/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome`, профиль пользователя не создавался):

- **normal: exit 0, `ok:true`, 12/12 checks** — real dashboard stack, preflight acknowledgement gate, stale evidence, run id HTTP/store/UI, fake-child cwd, read-marker bytes, side-effect failure без retry, restart сохраняет terminal records, cancel, exceptions, network/HTTP failures, CDP close pending. Evidence: `.scratch/m10-browser-stack-evidence-93ZMpH` (report.json + screenshots).
- **negative: exit 0, `ok:true`** — 4 фазы (spawn/cdp-close/network/cleanup), каждая с ожидаемым ненулевым дочерним exit и собственной evidence-папкой `.scratch/m10-browser-negative-*`.

**Browser acceptance: PASS на настоящем Chrome с real cleanup и сохранённой evidence. M10-R2 принят полностью.** Локальные условия главы 5 закрыты. Остаются только внешние пункты M11 (real OMP binary, native resume, external egress/isolation, живая provider route) — они требуют отдельной авторизации пользователя на внешний этап.
