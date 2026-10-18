# M10 — отчёт исполнителя и независимое review

Архивный срез 16 октября 2026. Относительные ссылки перенесены для каталога archive; основной журнал сохраняется в [PEER_REVIEW.md](../PEER_REVIEW.md).

## M10 — отчёт исполнителя

Статусы: **LOCAL PASS** — доказано локальными тестами/исходниками; **STATIC UPSTREAM** — установлено чтением pinned upstream; **NOT PROVEN** — локального доказательства нет; **BLOCKED** — проверка остановлена внешним ограничением.

- **LOCAL PASS:** добавлена UI-инвалидация OMP evidence: изменение provider/account/model/project снимает acknowledgement и preflight; изменение самого checkbox acknowledgement не сбрасывает. Regression assertions добавлены в `scripts/dashboard-ui-smoke.mjs`.
- **LOCAL PASS:** `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test` добавлены в список нерассмотренных project settings; runtime regression test проверяет отказ до чтения credentials/записи managed state.
- **LOCAL PASS:** targeted OMP/dashboard suites: 7 files, 190 tests PASS; full suite: 83 files / 1189 tests PASS; typecheck and build: `jsEmitted:130`, exit 0.
- **LOCAL PASS / STATIC UPSTREAM:** pinned OMP commit `0c6c981ee5838d97700180383077eb0a3790637c`; import probe exit 0, `drift:[]`; generated policy now sets the pinned `fetch.enabled=false` setting. argv и policy всё равно не равны полноценному SDK/OS sandbox: `read` принимает абсолютные пути, user-level MCP/OS isolation и другие network surfaces не доказаны.
- **NOT PROVEN:** полный browser smoke на Edge не завершён: среда оставляет Edge profile lock (`EPERM`) и в одном запуске CDP navigation timeout. Не объявляю browser → dashboard → launch-service → runtime → supervisor → fake-child → run-store сценарий принятым.
- **BLOCKED / out of scope:** real OMP, paid Doctor, live v2, Bun importer, живые homes/keys, commit/push/PR и cutover не выполнялись по handoff.

Подробная матрица границы прав: `docs/omp-migration/STEP6_PERMISSION_BOUNDARY.md`.

## Независимое review M10 — принято частично, 16 октября 2026

**Вердикт:** локальные runtime-изменения и существующий integration harness подтверждены в указанном ниже объёме. Сквозной browser → dashboard → настоящий локальный launch stack → fake child → persistent runs остаётся **NOT PROVEN**. Полный пакет M10 и глава 5 не приняты. Следующее задание — **M10-R**, завершение доступной локальной части главы 5 / Step 6.

**Основа проверки:** ветка `omp-integration`, HEAD `5025cb31ae9dfa8c8e64bbc29e8a39513f6a5872`, накопительный dirty worktree. Изменения runtime/UI/существующего browser smoke сопоставлены со снимками `.scratch/m10-local-step6/baseline/`; новый `scripts/omp-browser-stack-smoke.mjs` прочитан отдельно. Это review текущих файлов, не отдельного коммита. Отчёт исполнителя M10 выше сохранён без изменений.

### Замечания, требующие исправления

1. **P2 — CDP может зависнуть без завершения проверки.** В `scripts/omp-browser-stack-smoke.mjs:165–179` у `cdp.call()` нет таймаута и обработки закрытия socket с отклонением pending-запросов. `waitFor()` проверяет deadline только после `await evaluate()`, поэтому зависший CDP-ответ обходит этот deadline; обработчик ошибки также ждёт `evaluate()`. По исходникам нет гарантии, что после потери CDP управление достигнет cleanup. Нужны ограниченные по времени команды/диагностика и воспроизводимый отказный сценарий с ненулевым exit без зависания.
2. **P2 — успешный результат печатается до cleanup, доказательства удаляются.** В том же скрипте `screenshots` находится внутри `root` (строки 37–43), `ok:true` печатается в строке 311, а строка 339 рекурсивно удаляет `root`. При успешном cleanup заявленный путь скриншотов уже не существует; при ошибке cleanup stdout уже содержит успех, хотя exit становится 1. Завершение собственных browser/child процессов также не ожидается перед удалением профиля. Сохранять evidence отдельно от disposable profile, проверять завершение собственных процессов и публиковать успех после обязательного cleanup; отказный прогон обязан сохранять исходную причину и честный exit.
3. **P2 — сетевые ошибки браузера собираются, но не влияют на PASS.** `Network.loadingFailed` попадает в `networkFailures` (строка 163), однако перед `ok:true` проверяются только JS exceptions (строки 308–311). Неожиданный сетевой отказ может остаться незамеченным. Нужна проверка ошибок сети и ответов HTTP с узким объяснённым списком ожидаемых fixture-отказов, а также отрицательный сценарий, доказывающий работу проверки.

Это замечания по прочитанному коду. Reviewer не воспроизводил новый browser smoke и не утверждает, что установил причину прежнего Edge `EPERM` либо navigation timeout.

### Незакрытые критерии M10

- Реальный browser smoke самого исполнителя не завершён; добавленные UI assertions ещё не дают выполненного доказательства сброса acknowledgement/preflight для всего набора provider/account/model/project. Проверить также отказ до spawn и поздний ответ старого preflight.
- Новый smoke на restart передаёт прежний объект repository (`makeStack(..., currentRuns)`, строки 288–297) и проверяет только terminal runs. Долговечность через новый экземпляр файлового repository и потеря ownership активного запуска этим сценарием не доказаны. Существующие integration/supervisor tests полезны и должны быть переиспользованы; native resume остаётся отдельным неподтверждённым пунктом.
- В `STEP6_PERMISSION_BOUNDARY.md` нет точных upstream путей/символов для всех выводов, а `.env*` сформулировано шире реализации: guard перечисляет пять имён, regression добавлен для `.env`. Сверить фактические загрузчики закреплённого upstream и уточнить матрицу; наличие policy/argv не доказывает применение всех ограничений настоящим OMP.

### Повторённые reviewer проверки

- `node node_modules/vitest/vitest.mjs run tests/omp-runtime.test.ts tests/omp-launch-service.test.ts tests/omp-process-supervisor.test.ts tests/omp-integration-harness.test.ts tests/provider-dashboard-omp.test.ts tests/omp-route-readiness-preview.test.ts tests/provider-dashboard-server.test.ts` — **exit 0, 7 файлов / 190 тестов PASS**.
- `npm.cmd run typecheck` — **exit 0**.
- `npm.cmd run build` — **exit 0**, `jsEmitted:130`, `recovered:false`.
- `node --check scripts/omp-browser-stack-smoke.mjs`, `node --check scripts/dashboard-ui-smoke.mjs` — обе **exit 0**.
- `git diff --check` — **exit 0**; есть предупреждения Git о нормализации CRLF, ошибок whitespace нет.

Полный suite 83/1189 и browser normal/negative reviewer в этом review не повторял; 83/1189 остаётся результатом исполнителя, не новой независимой проверкой. Production-код и тесты reviewer не менял. Skills: использован `writing-for-agents` для следующего handoff. Платные запросы, real OMP, live v2, Bun/importer, живые homes/ключи, OS isolation, cutover и commit/push/PR не выполнялись.

### Передача следующего пакета

Предыдущее [задание M10](2026-10-16-m10-handoff.md) и [срез отчёта с этим review](2026-10-16-m10-peer-review.md) архивированы. В [AGENT_HANDOFF.md](../AGENT_HANDOFF.md) записан M10-R: исправить три замечания, получить воспроизводимый browser gate, завершить недостающие локальные lifecycle/failure/permission доказательства и записать итог в этот файл. Переход к cutover и закрытие миграции не разрешены этим локальным review.
