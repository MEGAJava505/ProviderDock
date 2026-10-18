## M9 — отчёт исполнителя

### Сделано
- Preview больше не выдаёт готовность **к** пилоту за факт его прохождения: accepted tier — `doctor-l3-ready-for-pilot`, blocked с Doctor evidence — `doctor-l3-evidence-route-blocked`. UI показывает честные подписи и для legacy-значений. Gate, persisted v2, permissions и production routing не менялись.
- Изменены `src/migration/omp-route-readiness-preview.ts`, `src/ui/provider-dashboard-script.ts`; проверки — `tests/omp-route-readiness-preview.test.ts`, `tests/omp-launch-service.test.ts`, `tests/provider-dashboard-omp.test.ts`, `scripts/dashboard-ui-smoke.mjs`.
- Обновлены `docs/omp-migration/REMAINING_PLAN.md`, `docs/omp-runtime-runbook-ru.md` и этот отчёт. M8 сохранён в `docs/omp-migration/archive/2026-10-01-m8-peer-review.md`; исторические разделы оставлены для существующих ссылок. Всего 10 файлов; чужой dirty tree сохранён.

### Проверено
- 1 октября 2026: `node node_modules/vitest/vitest.mjs run tests/omp-route-readiness-preview.test.ts tests/omp-launch-service.test.ts tests/provider-dashboard-omp.test.ts` — RED: exit 1, **7 failed / 48 passed**; GREEN: exit 0, **55 passed**.
- Browser RED до production-правки показал обе ложные legacy-подписи и непереведённые новые tiers. После AssertionError процесс не завершился; остановлен только подтверждённо наш Node, итоговый exit **−1**, не чистый exit 1.
- `npm.cmd run typecheck`, `npm.cmd run build`, `npm.cmd test` — exit 0; сборка **130 JS**, полный suite **83 файла / 1188 тестов PASS**. `TEMP`/`TMP` заданы только процессам в `.scratch/m9-evidence-tier-hL0bCr/tmp` на E:.
- `node scripts/dashboard-ui-smoke.mjs` — exit 0, **38 checks**. В настоящем dashboard fixture пройдены unknown/accepted/blocked и обе legacy-подписи; preview не разрешает запуск без preflight. Три скриншота просмотрены, исключений браузера нет; provider I/O — fake, API — loopback.
- `node scripts/dashboard-ui-smoke.mjs --negative` — exit 0, **2/2**; оба fault-child завершились ожидаемым exit 1, активный таймер восстановлен один раз.
- `node .scratch/m9-evidence-tier-hL0bCr/verify-m9.mjs` — exit 0: **133 локальные ссылки**, архив M8 и прежние отчёты сохранены, **53 dirty-файла вне scope** не изменены. `git diff --check` и `node --check scripts/dashboard-ui-smoke.mjs` — exit 0; task-only diff просмотрен, debug/skip не добавлены.
- **Standards: no findings. Spec: no findings.** Два независимых статических review шести code/test-файлов; runtime-проверки reviewer’ы не повторяли.

### Не проверено / ограничения
- Причина незавершения первого RED-процесса окончательно не установлена; последующие normal/negative smoke завершились сами. Неизвестные внешние HTTP-клиенты не проверены; mapping tier-значений описан в runbook. Отдельной CLI preview-команды нет.
- Свежий Doctor PASS, платный VSLLM-запрос, live v2, реальный OMP-пилот, Bun/importer, живые homes/transcript/ключи, cutover и commit/push/PR не выполнялись. Step 5 **BLOCKED/NOT PROVEN**. **Общая миграционная `/goal` не завершена: статус `blocked` до следующего разрешённого задания или отдельного решения о внешнем gate.** При повторной сверке 1 октября 2026 handoff по-прежнему содержит M9. Это отчёт исполнителя, не приёмка всей миграции.

### Skills
- `brainstorming` / `writing-plans` — границы и короткий контракт; `systematic-debugging` / `test-driven-development` — причина и RED→GREEN; `code-review` — Standards/Spec; `verification-before-completion` — фактические проверки.

## Независимое review M9 — локально принято (1 октября 2026)

**Spec:** accepted synthetic route получает `doctor-l3-ready-for-pilot`, а route с совпавшим Doctor/local evidence и заблокированным account — `doctor-l3-evidence-route-blocked`; `evaluateOmpRouteDecisionForPilot()` остаётся авторитетным gate. Проверил соответствующие ветки `omp-route-readiness-preview.ts`, HTTP projection, dashboard labels и тесты. Старые tier-значения принимаются bundled UI только как входные aliases и показываются без утверждения о пройденном пилоте; persisted v2, permission policy и production routing этим пакетом не менялись.

**Проверка reviewer:** целевой Vitest — **3 файла / 55 тестов PASS**; `npm.cmd run typecheck` — exit 0; `npm.cmd run build` — exit 0, **130 JS**; полный `npm.cmd test` — **83 файла / 1188 тестов PASS**; browser smoke — exit 0, **38 checks**, включая unknown/accepted/blocked и оба legacy aliases; negative smoke — exit 0, **2/2**. Скриншоты `omp-preview-ready.png` и `omp-preview-blocked.png` просмотрены: подписи согласованы с preview, запуск остаётся закрыт до preflight. Повторный full suite использовал только process-local `TEMP`/`TMP` в `.scratch/m9-review-temp`.

**Ограничения:** новое значение `evidenceTier` и два reason-кода меняют публичный JSON endpoint. Bundled UI понимает прежние tier-значения, а runbook содержит карту перехода; неизвестные внешние HTTP-клиенты не проверены и должны обновить разбор enum. Реальный `omp.exe`, свежий Doctor PASS, live v2, платный VSLLM и OS/network isolation не проверялись. Исполнитель назвал общую `/goal` «blocked», но этот отчёт не устанавливает формальный статус цели; остаются отдельные внешние gates.

**Вердикт:** M9 **локально принят в пределах synthetic route, loopback API и browser fixture**. Подпись «пилот прошёл» больше не выводится из Doctor evidence; фактический пилот по-прежнему не доказан. [M9 архивирован](2026-10-01-m9-handoff.md), [копия отчёта и вердикта](2026-10-01-m9-peer-review.md); следующее [M10](../AGENT_HANDOFF.md) проверяет локальную границу прав Step 6. Общая миграционная цель остаётся открытой.
