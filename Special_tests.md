# Специальные тесты ProviderDock: что проверять и ожидаемый результат

## Назначение и статус

ProviderDock — локальный менеджер нескольких provider-профилей и compatibility gateway для coding agents; в этой спецификации описана локальная OMP-интеграция: подготовка маршрута, preflight, запуск и lifecycle run, dashboard и сохранение run records.

Цель проверок — подтвердить поведение текущей кодовой базы на изолированных fixtures и loopback-сценариях, включая отказные ветви, и явно отделить локальный PASS от доказательств, требующих внешнего пилота.

Текущий статус: ветка `omp-integration`; M10-R2 принят для локальных критериев главы 5; browser acceptance на Chrome for Testing 155 принят (normal 12/12, negative 4 фазы); M11-P — `doc-complete`, то есть подготовлены план и evidence schema. Внешний пилот не запускался.

Числа ниже разделяют два среза. Принятый M10-R2 baseline: 7 suite-файлов / 199 тестов PASS. В текущем рабочем дереве повторённый целевой запуск тех же семи suite: 7 файлов / 228 тестов PASS; изменённые локально файлы `tests/omp-run-repository.test.ts` и `tests/omp-integration-harness.test.ts` объясняют отличие от baseline. Текущий повтор по suite:

| Suite | Что проверяется | Текущий повтор |
| --- | --- | ---: |
| `tests/omp-run-repository.test.ts` | Создание, чтение, переходы состояний, durable storage, защита от небезопасных файлов и конкурентных/атомарных замен run record. | 44/44 PASS |
| `tests/omp-runtime.test.ts` | Fail-closed preflight, pinned artifact и checksum, route/credential binding, подготовка изолированных конфигов и среды запуска, отсутствие утечки секретов и ambient credentials. | 37/37 PASS |
| `tests/omp-launch-service.test.ts` | Gates перед запуском, проверка route/evidence и выбора, безопасное создание/отказ launch request и связь результата с run. | 25/25 PASS |
| `tests/omp-process-supervisor.test.ts` | Spawn, readiness/lifecycle, terminal states, cancel, timeout и завершение/учёт дочернего процесса. | 47/47 PASS |
| `tests/omp-integration-harness.test.ts` | Сквозные локальные сценарии и loopback startup с ограниченным deadline, включая bind refusal и отсутствие callback. | 19/19 PASS |
| `tests/provider-dashboard-omp.test.ts` | OMP dashboard API: preview/preflight/launch/runs/cancel, authorization gates и безопасные ошибки. | 15/15 PASS |
| `tests/provider-dashboard-server.test.ts` | HTTP server, dashboard API и UI-serving границы, включая корректную сериализацию и отказные ответы. | 41/41 PASS |

## Browser smoke

Browser smoke соединяет браузер, реальный локальный dashboard stack, launch service, runtime, supervisor, fake child и run store. Fake child и loopback намеренны: такой smoke не запускает реальный `omp.exe` и не проверяет внешний provider.

Normal smoke содержит 12 checks. PASS означает exit code 0, `ok:true`, отсутствие неожиданных browser JS exceptions, network failures и HTTP failures, успешный cleanup собственных ресурсов и сохранённые структурный `report.json` и screenshots.

| Check | Ожидаемый результат PASS |
| --- | --- |
| Dashboard stack | Реальная UI/API-цепочка доступна и выполняет локальные сценарии. |
| Preflight acknowledgement gate | Без явного acknowledgement запуск закрыт; успешный preflight открывает только выбранный подтверждённый запуск. |
| Stale evidence | Изменение выбора provider/account/model/project отзывает acknowledgement и preflight; старый поздний ответ preflight не возвращает разрешение на launch. |
| Run ID | Один и тот же `runId` виден в HTTP response, store и UI. |
| Fake-child cwd | Процесс запускается в выбранном project directory; проверяется fixture cwd. |
| Read-marker bytes | Loopback получает ожидаемые fixture-байты и контракт запроса, без использования живого provider. |
| Exceptions | Нет необработанных JavaScript исключений браузера. |
| CDP close | Закрытие CDP socket отклоняет незавершённую команду; smoke не зависает. |
| Spawn error | Ошибка запуска браузера приводит к честному отказу и сохраняемой диагностике. |
| Network failure | Неожиданный `Network.loadingFailed` приводит к отказу, а не к ложному PASS. |
| Side-effect failure | После одного побочного эффекта ошибка не вызывает automatic retry/fallback; terminal record сохраняется после restart. |
| Cancel | Отмена через dashboard переводит run в `CANCELLED`; повторная terminal cancel не создаёт запуск, запрос или новый переход. |

В negative smoke проверяются 4 независимые fault-фазы: `spawn`, `cdp-close`, `network`, `cleanup`. Общий smoke должен завершиться exit 0 с `ok:true`, потому что все отказы ожидаемы; каждый дочерний сценарий обязан завершиться ненулевым exit, не печатать `ok:true`, сохранить `report.json` с `ok:false` без вложенного успешного результата, сохранить исходную причину и удалить принадлежащий fixture root. Для `cleanup` ожидается ошибка cleanup в отчёте и успешная fallback-очистка root.

Принятый browser acceptance M10-R2: normal 12/12 и все четыре negative-фазы PASS на Chrome for Testing 155. Запуск вручную описан ниже; для Chrome нужно задать `PROVIDERDOCK_TEST_BROWSER` на путь к исполняемому файлу браузера.

## Регрессии и bounded failures

- **`OMP_RUN_UNSAFE_PATH` и гонка чтения с atomic rename.** В `tests/omp-run-repository.test.ts` подмена файла во время `opened-fstat` и `after-read-fstat` должна распознаваться как transient changed read (`OmpRunStorageError` с `OMP_RUN_CHANGED`), а не ошибочно как `OMP_RUN_UNSAFE_PATH`. Следующее чтение возвращает целую новую запись (`STARTING`); смешанная/невалидированная запись не возвращается. Symlink, hardlink, non-regular object и прочие небезопасные identity по-прежнему fail-closed с `OMP_RUN_UNSAFE_PATH`.
- **Bounded startup при bind refusal.** В `tests/omp-integration-harness.test.ts` bind на занятом loopback-порту должен завершиться ошибкой, а startup без `listening`/`error` callback — `deadline exceeded`; оба пути снимают свои listeners/timers и не оставляют зависший процесс. Regression принимает PASS только при bounded завершении, а не при внешнем timeout.

## Build, typecheck и syntax checks

Ожидаемые результаты для текущего локального набора:

- `npm run build` — exit 0, JSON содержит `"ok":true` и `"jsEmitted":130`.
- `npm run typecheck` — exit 0.
- `node --check scripts/omp-browser-stack-smoke.mjs` — exit 0.
- `node --check scripts/dashboard-ui-smoke.mjs` — exit 0.
- `git diff --check` — exit 0, без whitespace errors.

В этой сессии build, typecheck и оба `node --check` выполнены успешно. Browser smoke здесь не повторялся: `PROVIDERDOCK_TEST_BROWSER` не задан; принят его зафиксированный результат M10-R2.

## Осталось BLOCKED / NOT PROVEN

Локальные тесты, fake child, loopback и synthetic evidence не доказывают четыре внешние границы пилота:

1. **Actual `omp.exe`** — утверждённая версия и SHA-256, реальный lifecycle.
2. **Native resume** — продолжение реального OMP run с доказуемой связью с исходным состоянием.
3. **External egress/isolation** — заявленная OS/network isolation, разрешённый маршрут и отсутствие неожиданного egress.
4. **Живая provider route** — ограниченный запрос к утверждённому провайдеру и подтверждение результата/side effects.

Все четыре границы остаются `NOT PROVEN`/`BLOCKED`; M11-P подготовил только план. Не использовать live credentials, сессии или paid requests на основании локального PASS.

## Как запускать

Полный целевой прогон семи OMP/dashboard suites (принятый M10-R2 baseline — 199; в текущем рабочем дереве число может быть больше из-за последующих изменений):

```sh
npx vitest run \
  tests/omp-run-repository.test.ts \
  tests/omp-runtime.test.ts \
  tests/omp-launch-service.test.ts \
  tests/omp-process-supervisor.test.ts \
  tests/omp-integration-harness.test.ts \
  tests/provider-dashboard-omp.test.ts \
  tests/provider-dashboard-server.test.ts
```

Dashboard subset: `npx vitest run tests/provider-dashboard-omp.test.ts tests/provider-dashboard-server.test.ts` — baseline 56/56 PASS.

Browser smoke после сборки (подставить локальный путь к browser executable):

```sh
npm run build
PROVIDERDOCK_TEST_BROWSER=/path/to/chrome node scripts/omp-browser-stack-smoke.mjs
PROVIDERDOCK_TEST_BROWSER=/path/to/chrome node scripts/omp-browser-stack-smoke.mjs --negative
```

Normal ожидает 12/12 checks; negative — четыре описанные fault-фазы. Smoke работает на собственной временной fixture и loopback; ему не нужны живые provider credentials или внешний endpoint.

Общие локальные gates:

```sh
npm run typecheck
npm run build
node --check scripts/omp-browser-stack-smoke.mjs
node --check scripts/dashboard-ui-smoke.mjs
git diff --check
```

## Критерии внешнего пилота M11

Каждая граница требует собственного authorization gate и отдельной append-only evidence-записи:

| Gate | Что авторизует | Минимальный результат, прежде чем принять claim |
| --- | --- | --- |
| A1 | Actual `omp.exe` | Pinned version/SHA-256, ограниченный lifecycle и run linkage, наблюдение процесса/egress, side-effect assessment. |
| A2 | Native resume | Принятая исходная фаза, immutable source-state hash, `nativeResumeLinkage`, before/after hashes, проверка повторных side effects. |
| A3 | External egress/isolation | Attestation среды и изоляции, allow/deny policy, наблюдение разрешённого пути и отрицательная проверка неожиданного egress, teardown evidence. |
| A4 | Живая provider route | Только после прохождения предыдущих фаз: redacted route, credential class, request/cost caps и counters, ожидаемый/фактический результат, side-effect и rollback decision. |

Запись каждого gate должна содержать `scope/project`, `responsible`, `approver`, `credential class and route`, `cost limit`, `request limit`, `UTC time window` и `stop criterion`. Фазы строго последовательны: Phase 1–2 используют A1, Phase 3 — A2, Phase 4 — A3, Phase 5 — A4, Phase 6 — rollback observation. Отсутствие поля соответствующей авторизации блокирует фазу; нельзя перескакивать через `BLOCKED`, `NOT PROVEN`, незакрытый stop outcome или отсутствующую integrity-проверку.

Evidence schema должна включать как минимум phase и claim, authorization reference, actor/approver, redacted project/run linkage, inventory и integrity hashes, UTC timestamps, наблюдаемые request/cost counters, expected-versus-actual result, side-effect assessment и `status`. Допустимые статусы: `PASS`, `FAIL`, `NOT PROVEN`, `BLOCKED`; `PASS` возможен только при полном наборе обязательных полей, соответствующем authorization gate и проверяемом integrity hash. При 401/403/429, 5xx/503, timeout, cap breach, route drift, unexpected egress, side effect или неполном evidence — остановка; 503/5xx не повторять.
