# Управляемый OMP: сборка и проверка на Windows

**M10-R, 17 октября 2026 — локальный пакет выполнен, отчёт исполнителя ожидает независимого review:** normal и negative browser smoke проверены на Brave; evidence и ограничения записаны в [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Это synthetic loopback/fake-child acceptance; cutover и внешние gates не открыты.

**Повторная проверка M10 по ответу из чата, 16 октября 2026:** 10 assertions browser fixture выполнены, preflight и сообщение отмены просмотрены. Независимый повтор вне sandbox дал **exit 1** из-за cleanup `EPERM` за 58.9 s; stdout `ok:true` печатается раньше cleanup. Полный browser gate не принят, исправления CDP/network/evidence и недостающие критерии остаются в M10-R. Логи и границы проверки — в конце [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

**M10 — независимый срез 16 октября 2026, принято частично.** Reviewer повторил целевые 7 файлов / 190 тестов, typecheck, build (`jsEmitted:130`) и syntax/diff checks: PASS. Runtime guard перечисляет `.env`, `.env.local`, `.env.development`, `.env.production`, `.env.test`; generated policy содержит `fetch.enabled=false`. Сброс UI acknowledgement/preflight добавлен в код, но полный browser stack не принят. У нового smoke обнаружены неограниченное ожидание CDP, публикация успеха до cleanup с удалением screenshots и отсутствие проверки накопленных network failures. Полный suite 83/1189 и прежние Edge `EPERM`/navigation timeout — сведения исполнителя, reviewer их не повторял и причину Edge-сбоя не устанавливал. Матрица — [STEP6_PERMISSION_BOUNDARY.md](omp-migration/STEP6_PERMISSION_BOUNDARY.md), полный verdict — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

**Результат M10-R:** browser smoke завершает normal path `exit 0` после cleanup и сохраняет structural report и пять screenshots (`ready-preview`, `blocked-preview`, `unknown-preview`, `ready-preflight`, `cancelled`) вне удаляемого profile/fixture-root. Negative runner проверяет spawn, CDP close, `Network.loadingFailed` и cleanup failure; каждый путь даёт `exit 1` без ложного `ok:true`. Smoke использует fake child и loopback, поэтому real `omp.exe`, native resume, OS isolation, paid Doctor, live v2 и Step 5 остаются `NOT PROVEN`/`BLOCKED`.

**Независимое review M9, 1 октября 2026 — локально принято.** Повторно прошли целевые 55/55, typecheck, build (130 JS), полный suite 83/1188, browser smoke 38 checks и negative 2/2; reviewer просмотрел ready/blocked скриншоты. Новые tier/reason-коды публичного preview описаны ниже, неизвестные внешние HTTP-клиенты не проверены. Реальный OMP-пилот не выполнялся. [Вердикт](omp-migration/PEER_REVIEW.md), [архив M9](omp-migration/archive/2026-10-01-m9-handoff.md); первоначальное [задание M10](omp-migration/archive/2026-10-14-m10-initial-handoff.md) было посвящено локальной границе прав до внешнего пилота.

**M9 / Step 6, 1 октября 2026 — готовность к пилоту больше не называется прошедшим пилотом.** В генерируемом `POST /api/omp/preview` принятая цепочка получает `evidenceTier:"doctor-l3-ready-for-pilot"`; полное Doctor/local evidence при закрытом маршруте — `"doctor-l3-evidence-route-blocked"`. Это только предпосылки для preflight/пилота, не доказательство OMP-запуска. `verdict:"ready"`, response shape, fail-closed gate, permission policy и explicit launch не менялись. GREEN unit/service/HTTP 55/55, typecheck/build, полный suite 83/1188, browser normal 38 checks и negative 2/2 — PASS; фактически просмотрены unknown/ready/blocked и legacy-подписи. Источник проверок и ограничений — [отчёт M9](omp-migration/PEER_REVIEW.md).

**Совместимость preview M9:** `real-paid-pilot` → `doctor-l3-ready-for-pilot`; `real-pilot-evidence-route-blocked` → `doctor-l3-evidence-route-blocked`. Bundled UI принимает и старые значения, но переводит их в честные подписи Doctor/local evidence. Persisted v2 `realPilot`/Doctor hash и run schema не менялись; tier туда не записывается. Отдельной CLI preview-команды нет: CLI передаёт launcher dashboard. Неизвестные внешние HTTP-клиенты не проверены: при разборе tier им нужен указанный переход; старое название никогда не следует считать доказательством прошедшего OMP-пилота. Reason-коды `level-3-real-pilot-evidence` и `no-paid-pilot-evidence-yet` заменены на `doctor-level-3-and-local-provenance` и `no-doctor-level-3-evidence-yet`.

**Внешние gates не открыты:** Step 4 по-прежнему без свежего Doctor PASS, live v2 и реального пилота; Step 5 по [M8](omp-migration/STEP5_FIXTURE_IMPORT_DECISION.md) остаётся **BLOCKED/NOT PROVEN**. Платные запросы, реальные OMP/Bun/importer, живые homes/transcript/ключи, cutover и commit/push/PR в M9 не выполнялись. Общая миграционная `/goal` открыта.

**M8 / Step 5, 1 октября 2026 — только doc-only решение.** [Fixture-import decision](omp-migration/STEP5_FIXTURE_IMPORT_DECISION.md) фиксирует Bun library API как кандидат, а исполнение импорта и автоматический повтор — **BLOCKED/NOT PROVEN**; существующий Node capability остаётся `unsupported`. Explicit source root + `sessionDir` не изолируют транзитивное чтение home `.env` и blob/log paths. До запуска нужны отдельно разрешённый OS filesystem/network-isolated Bun-runner, строгий error-bearing scan/readback, метка операции до copy и verified-finalize с межпроцессным владением. Не использовать `SessionManager.open()` для проверки missing/corrupt target и не трактовать tolerant listing `[]` как разрешение повторить запись. Таблица сбоев и следующая точка решения — в decision; фактический doc-only gate — в [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Bun/OMP, живые данные, сеть, платный Doctor, live v2 и cutover не запускались. История прежних reviewer-вердиктов сохранена в [архиве](omp-migration/archive/2026-10-01-pre-m8-peer-review.md).

**Независимое review M8, 1 октября 2026 — статическое решение принято, Step 5 остаётся BLOCKED.** Ключевые source claims сверены напрямую; pinned probe `unsupported`/`drift:[]`, checkout clean, 135 локальных ссылок и 46 явных source-line диапазонов проверены без ошибок, diff-check exit 0. При review прежние 14 разделов возвращены в основной [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md); архивная копия сохранена, исторические ссылки снова показывают нужные вердикты. Bun/importer и реальные данные не запускались. Следующее [M9 / Step 6](omp-migration/archive/2026-10-01-m9-handoff.md) устраняет ложную подпись preview «платный пилот подтверждён»: accepted gate пока означает только готовность к пилоту. Внешние gates VSLLM, live v2, OMP-пилота и isolated Bun-runner остаются открытыми.
Текущие незавершённые этапы и границы разрешений — в [REMAINING_PLAN.md](omp-migration/REMAINING_PLAN.md); порядок действий следующего агента — в [AGENT_HANDOFF.md](omp-migration/AGENT_HANDOFF.md). Датированные результаты ниже являются историческими checkpoint, а не действующим разрешением на запуск.

**Независимое review M7 — принято частично, 30 сентября 2026.** Целевой fixture Vitest 15/15, typecheck и diff-check прошли; build и полный suite reviewer не повторял. Проверка на fake `fetch` выявила два дефекта: `maxResponseBytes:NaN` пропускает 307 247 байт при штатном пределе 256 KiB, а чужой профиль/модель (`other-provider`, `openai-chat-completions`, `https://other.invalid/v1`, `unrelated-model`) допускаются к запросу. `maxTimeoutMs:NaN` тоже не валидируется. До [архивного M7-R](omp-migration/archive/2026-09-30-m7-r-handoff.md) путь нельзя было считать ограниченным одним согласованным VSLLM-запросом. Полный вердикт — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Живой запрос, live v2 и OMP-пилот не выполнялись.
**Независимое review M7-R — локально принято, 30 сентября 2026.** Целевой Vitest **35/35**, typecheck и diff-check прошли; reviewer fixture дополнительно подтвердил отказ для дробного `maxTimeoutMs` и невалидного `profile.timeoutMs` до secret/fetch. В отчёте исполнителя «20 негативных» означает 19 отказных и один положительный сценарий; build и полный 83/1186 suite reviewer не повторял. Локальный one-shot probe готов как fixture-only основание для отдельного решения по платному запросу, но live auth-kind и `no-text-output` остаются NOT PROVEN. [M7-R архивирован](omp-migration/archive/2026-09-30-m7-r-handoff.md); историческое [M8 / Step 5](omp-migration/archive/2026-10-01-m8-handoff.md) выбирало синтетический импортный маршрут и безопасный повтор. Read-only pinned probe для Step 5: `unsupported` / `drift:[]`, реального импорта нет. Полный вердикт — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).
**M7-R — два дефекта opt-in probe закрыты локально, 30 сентября 2026 (отчёт исполнителя, не независимая приёмка).** По независимому review M7: `src/diagnostics/responses-structure-probe.ts` теперь валидирует таргет, модель и опциональные лимиты ДО `ProviderHttpRequestBuilder.build()` и чтения `secretRef`. Невалидный `maxResponseBytes`/`maxTimeoutMs` (`NaN`/`Infinity`/ноль/отрицательное/дробное/выше потолка 256 KiB / 30 000 ms) и любой чужой таргет (не `vsllm` / `https://vsllm.cc/v1` / `openai-responses` / `gpt-5.4-mini`) → `INVALID_REQUEST`, `requestCount:0`, без чтения секрета и fetch; `describeResponsesStructureProbe` для неверного таргета возвращает `null`. Один запрос/`128`/`stream:false`/без tools-retry/`redirect:"error"`/origin-check/allowlisted сводка и отсутствие авто-вызова сохранены. RED→GREEN: `tests/responses-structure-probe.test.ts` 19 FAIL/16 PASS → **35 passed**. Fresh gate: `npx tsc --noEmit` exit 0, `npm run build` `jsEmitted:130`, полный `npm test` **83 файла / 1186 тестов** PASS, `git diff --check` exit 0. Живой запрос НЕ выполнялся; 18 маршрутов `pending`; live auth-kind NOT PROVEN. Отчёт — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

**M7 — fixture-only один структурный VSLLM-путь и dry-run, 30 сентября 2026 (отчёт исполнителя, не независимая приёмка).** Добавлен узкий opt-in модуль `src/diagnostics/responses-structure-probe.ts` поверх `ProviderHttpRequestBuilder` и `classifyResponsesStructure()`. `runResponsesStructureProbe` шлёт максимум один `responses`-запрос (`max_output_tokens=128`, `stream:false`, без tools/ретраев, `redirect:"error"`, повторная проверка origin, ограниченные время и объём чтения) и отдаёт либо allowlisted структурную сводку, либо один нормализованный `errorType` — без тела/headers/request-id/секрета/пути даже при ошибке; API-auth берётся только из profile, отдельная portal cookie не подставляется. `describeResponsesStructureProbe` — сетенезависимый dry-run descriptor (значение ключа не читается). Путь не вызывается из Doctor `run()`, dashboard, preflight или запуска OMP и ничего не сохраняет — fail-closed gate и health snapshot не затронуты. RED→GREEN: `tests/responses-structure-probe.test.ts` 15/15. Fresh gate: `npx tsc --noEmit` exit 0, `npm run build` `jsEmitted:130`, полный `npm test` **83 файла / 1166 тестов** PASS, `git diff --check` exit 0. Фактический VSLLM-запрос НЕ выполнялся; live API auth-kind не читался (**NOT PROVEN**); платный запрос, live v2 и OMP-пилот остаются отдельными решениями. Отчёт — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

**Независимое review M6-R + STEP5-PROBE-R2 — локально принято, 30 сентября 2026.** Reviewer повторил целевой Vitest 8 passed / 14 skipped, typecheck exit 0, probe smoke 8/8, закреплённый read-only probe `unsupported`/`drift:[]`, `node --check` и diff-check exit 0. Дробные usage counts и `EACCES`/`EPERM` больше не дают ложных структурных вердиктов; build и полный 82/1151 suite reviewer не повторял. При подготовке следующего этапа исправлена опасная неточность M6.3: inference использует API-auth provider profile через `ProviderHttpRequestBuilder`, а portal cookie относится к отдельной связи; точный live API auth-kind не установлен. Историческое [задание M7](omp-migration/archive/2026-09-30-m7-handoff.md) готовило one-shot путь только на fixtures и dry-run; платный VSLLM-запрос, live v2 и OMP-пилот не выполняются. Вердикт — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

**Независимое review M6 — принято частично, 29 сентября 2026.** Датированная матрица 18 `pending` сохранена; свежий live eval не проводился. Локальный классификатор превращает дробный usage count `3.9` в `3` вопреки контракту; целевой Vitest дал 7 passed / 14 skipped (21 total). В production остались два `M6_2_*_PLACEHOLDER` комментария. Вместе с ранее открытым ложным `skipped` при `stat → EACCES` это было передано в [архивное задание](omp-migration/archive/2026-09-30-m6-r-step5-probe-r2-handoff.md); полный verdict — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Внешние gates VSLLM остаются закрытыми.

**M6-R + STEP5-PROBE-R2 — оба локальных дефекта закрыты локально, 29 сентября 2026 (отчёт исполнителя, не независимая приёмка).** `normalizeCount()` в `src/diagnostics/provider-doctor.ts` теперь принимает usage-счётчик только как неотрицательное безопасное целое, иначе `null` (без округления: `3.9`/`Infinity`/`NaN`/отрицательное/вне диапазона → `null`); оба `M6_2_*_PLACEHOLDER` удалены; честный целевой Vitest = **8 passed | 14 skipped (22 total)**. `scripts/omp-import-probe.mjs` считает checkout отсутствующим только при `ENOENT`; `EACCES`/`EPERM`/иная ошибка `stat()` → структурный отказ exit 1 без утечки путей/содержимого/сырой ошибки/environment, прежние absent-skip / missing-source-refusal / clean-accepted различимы; probe-smoke поднят 6→8 (RED→GREEN). Fresh gate: `npx tsc --noEmit` exit 0, `npm run build` `jsEmitted:129`, полный `npm test` **82 файла / 1151 тест** PASS, `node --check` обоих probe-скриптов и `git diff --check` exit 0. Fail-closed Doctor, health snapshot и реальный OMP/сеть/Bun не затронуты; отчёт исполнителя — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Внешние gates VSLLM и общая миграционная `/goal` остаются открытыми.

**Текущий срез, 29 сентября 2026:** VSLLM `gpt-5.4-mini` дважды прошёл проверку соединения и списка моделей, но свежий Doctor L3 завершился `FAIL` на генерации текста (`no-text-output` во втором прогоне). Последний health snapshot хранит `FAIL`; локальный v2-кандидат больше не проходит gate пилота. Повторные платные запросы остановлены, live v2 не опубликован, реальный OMP-пилот не запускался. Подробности — в [инвентаре Step 4](omp-migration/STEP4_READONLY_INVENTORY_2026-09-29.md). Локальный dashboard после обновления snapshot открытого OMP-диалога перечитывает route preview и временно блокирует запуск до ответа; новый verdict не `ready` или ошибка preview отзывает прежний успешный preflight. Повторное открытие диалога также требует нового preflight. Это подтверждено только браузерным fixture smoke, не реальным OMP.

**Локальный пакет M6 / глава 2, Step 4 — локально выполнен, ждёт независимого review (29 сентября 2026, без commit/push):** per-profile матрица Step 4 расширена до 18 строк (все `pending`, свежесть live-metadata **NOT PROVEN**); в `src/diagnostics/provider-doctor.ts` добавлен отдельный сетенезависимый экспортируемый классификатор `classifyResponsesStructure` (только allowlisted структурные поля, не вызывается из `run()`, fail-closed gate и health snapshot не тронуты), RED→GREEN 7 новых тестов; переоценка v2-кандидата против последнего snapshot — `accepted:false`, кандидат не опубликован; спецификация единственного ограниченного структурного запроса подготовлена в [инвентаре Step 4](omp-migration/STEP4_READONLY_INVENTORY_2026-09-29.md), но запрос НЕ выполнен. Fresh gate: `npx tsc --noEmit` exit 0, `npm run build` `jsEmitted:129`, полный `npm test` **82 файла / 1150 тестов** PASS, `git diff --check` exit 0. Платный запрос, live v2 и реальный OMP-пилот остаются отдельными gates. STEP5-PROBE-R принят частично: `stat → EACCES` у существующего checkout пока даёт ложный `skipped`; детали — [в PEER_REVIEW](omp-migration/PEER_REVIEW.md).

Состояние кабинетов `recovered` теперь видно как просьба проверить сохранённые связи и вход; `corrupt` по-прежнему блокирует зависимые действия. Это проверено на fixture через реальный dashboard/HTTP, без проверки живых аккаунтов. Для повторных тестов на этом хосте задавайте `TEMP` и `TMP` только дочернему процессу на томе с достаточным местом: C: достиг `ENOSPC` при полном Vitest. `dashboard-ui-smoke` теперь удаляет Chrome-профиль текущего запуска после проверки; старые накопленные temp-каталоги он не трогает.

> Актуально на 23 сентября 2026: прежнее разрешение VSLLM на пилот
> приостановлено после независимого ревью. Live evidence/decision версии 1
> сохранены, но новый preflight отклоняет их кодом
> `OMP_MIGRATION_EVIDENCE_V2_REQUIRED`. Повторный локальный smoke на закреплённом
> OMP прошёл 18/18; свежий Doctor L3 не прошёл из-за квоты `glm-5.2-free`.
> Запасные модели тоже не подтвердили Responses-маршрут. Не запускать реальный
> OMP-пилот и не публиковать v2 decision до нового успешного Doctor L3.
> Подробности и SHA-256: [Step 4 mapping](omp-provider-mapping-2026-09-16.md).

Состояние: **16 сентября 2026, миграция выполняется, cutover не принят**. Прямой OMP-путь dashboard/CLI реализован, но реальные провайдерные пилоты не выполнялись. [Step 4: текущая офлайн-матрица профилей](omp-provider-mapping-2026-09-16.md) охватывает 18 профилей; все остаются `pending`.
Это продолжение [плана](superpowers/plans/2026-09-14-omp-migration-ru.md). Прямая интеграция dashboard/CLI реализована за явным выбором OMP, но это ещё не приёмка реальных провайдеров и не cutover.

## Что уже проверено

- Исходник: `unsigned-gg/omp`, commit `0c6c981ee5838d97700180383077eb0a3790637c`, package `18.0.4`.
- Portable Bun `1.4.0`; глобальный PATH не изменён.
- Настоящий OMP, не mock агента, обработал шесть локальных сценариев: Chat Completions / Responses / Messages, каждый без инструментов и с `read` → результат чтения → второй запрос → окончательный ответ.
- Для каждого сценария использованы только loopback HTTP, фиктивный ключ и тестовый проект с кириллицей/пробелами. Старые CLI и bridges не участвовали; платных inference-вызовов не было.
- Сначала эта матрица прошла на Bun/source и на **предварительном standalone**, имеющем ограничение native-зависимости ниже. Это не полная приёмка окончательной сборки.
- Компилятор выбранного маршрута, выдача только необходимых child-env credentials и вычисление provider/account-scoped путей: **121 regression-тест**, независимый review после исправлений принят.
- Runtime preflight/preparation: **26 regression-тестов** (включая RED до реализации и дополнительных safety fixes). Проверяет pin/checksum, cwd, mapping, storage layout, отсутствие непроверенных project settings, доступность ключа и подтверждение прав без запуска агента и без сети.
- **Дополнение:** точная native-сборка и повторная standalone-сборка завершены. Обновлённая матрица через **наш compiler + managed runtime** прошла все 6 сценариев на новом артефакте; проверяется фактическое наличие/отсутствие tools в запросе и отсутствие ключа во всех файлах run home.
- Run repository: 40 тестов, включая конкурирующие экземпляры, ошибки записи/fsync/rename, повреждённые записи и lifecycle. Независимое review принято.
- Настоящий RPC: ready → get_state → idle abort → stdin EOF, exit 0, **0 запросов к fixture upstream**, публичная проекция без ключа; raw private frames содержат authorization (см. ниже).
- Настоящий Windows ConPTY TUI: отрисован выбранный model ID и проект с кириллицей, Ctrl+D → exit 0, без timeout/cancel, onboarding и запросов к fixture upstream. Видимое тестовое окно не открывалось; это проверка TUI, не готового dashboard launcher.

## Важное ограничение предварительной сборки

NPM `@oh-my-pi/pi-natives-win32-x64@18.0.4` **не соответствует этому fork**, несмотря на одинаковый номер версии. В нём отсутствуют `DiffStream`, `rasterizeSvg`, `warmHighlighter`, объявленные нашим закреплённым исходником.

Предварительный executable сохранён как `.provider-dock/tools/omp-0c6c981ee583/omp-provisional.exe`; его нельзя использовать как совместимый production-артефакт.

Текущий `omp.exe` в том же каталоге пересобран с native из **точного исходника**:

- standalone SHA-256: `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`;
- native SHA-256: `76c41471f546f7d4818164e0d0c61aedc14a3bf6aa89ced2e38ab3a537ed1a90`;
- все 76 bindings, на которые ссылается JS, присутствуют; generated module имеет 87 exports, включая enums;
- tracked generated files после native/binary build совпадают с pinned Git source;
- одна source-built baseline-совместимая native-библиотека установлена под обоими именами variants, чтобы исключить загрузку старой;
- provenance — `artifact.json` рядом с executable; статус всё ещё `isolated-validation-not-production`.

Native build завершился с предупреждениями dead-code/linker/future compatibility, exit 0; они не заменяют чистую установку/полную security acceptance.

## Проверенные источники инструментов

| Артефакт | Источник | SHA-256 |
| --- | --- | --- |
| Bun archive | `https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64-baseline.zip` | `b929c54a9badb104a16dedd23aab6152c86793ae653d4e6b13983ffd0c882a66` |
| Bun executable | распакован из указанного архива | `627d2e4775c24bdedee2cd7ccc18dcadae061e5345274ab6e3c4c797927bfb8f` |
| rustup-init.exe | `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe` | `6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e` |

Rust toolchain: `nightly-2026-08-08-x86_64-pc-windows-msvc`; rustc `1.99.0-nightly (1a98b1e13 2026-08-07)`.
Имеющийся Visual Studio 2022 BuildTools содержит C++/CMake/Ninja.

Большие caches/target/temp размещены на локальном фиксированном F:, поскольку на C: оставалось около 1,6 GB. Ничего не удалялось для освобождения места.

## Воспроизведение сборки

Рабочий checkout — `.scratch/omp`; сначала проверить `git rev-parse HEAD` и `git status --short`.
Не переключать автоматически на release другого репозитория.

1. Проверить SHA-256 portable Bun до запуска, добавить его каталог **только в environment команды**.
2. В checkout:

   ```text
   bun install --frozen-lockfile --ignore-scripts --filter @oh-my-pi/pi-coding-agent --filter @oh-my-pi/collab-web --filter @oh-my-pi/pi-natives
   ```

   Cache `BUN_INSTALL_CACHE_DIR` направить на достаточно вместительный локальный диск.
   Install scripts намеренно не выполняются автоматически; необходимые assets генерируются build-командами ниже.

3. Для native-build установить environment только процесса:

   ```text
   CARGO_HOME=F:\ProviderDockBuild\omp-0c6c981ee583\cargo
   RUSTUP_HOME=F:\ProviderDockBuild\omp-0c6c981ee583\rustup
   RUSTUP_TOOLCHAIN=nightly-2026-08-08-x86_64-pc-windows-msvc
   CARGO_TARGET_DIR=F:\ProviderDockBuild\omp-0c6c981ee583\target
   TEMP=F:\ProviderDockBuild\omp-0c6c981ee583\temp
   TMP=<тот же каталог>
   OMP_NATIVE_CARGO_PROFILE=ci
   RUSTFLAGS=-C target-cpu=x86-64-v2 -C target-feature=+crt-static
   ```

   На child PATH добавить portable Bun и `<CARGO_HOME>\bin`. Выполнить:

   ```text
   bun packages/natives/scripts/build-bindings.ts
   ```

   Скрипт выбирает имя `modern` по CPU хоста даже при baseline RUSTFLAGS. До упаковки проверить фактически полученный файл и не смешивать старую предварительную baseline-библиотеку с новой. Сравнить exports с закреплённым `native/index.js`; записать checksum и diff generated bindings.

   Windows PowerShell 5 + `$ErrorActionPreference='Stop'` + `*>` может превратить обычный cargo stderr в `NativeCommandError`. Для длинной сборки использовать Node child_process с перенаправлением stdout/stderr в файл, проверять реальный exit code; не перезапускать живую сборку из-за отсутствия вывода.

4. `BUN_COMPILE_EXECUTABLE_PATH` должен указывать на проверенный portable Bun. Выполнить:

   ```text
   bun packages/coding-agent/scripts/build-binary.ts
   ```

   Скрипт генерирует stats/tool-view/native assets, собирает standalone и возвращает временные tracked placeholders. После завершения проверить status, размер, checksum и `--version`.

5. Повторить проверку настоящего runtime **через наш compiler/preparation**:

   ```powershell
   npm run build
   node scripts/omp-runtime-smoke.mjs --executable "<полный путь к проверяемому omp.exe>"
   node scripts/omp-rpc-smoke.mjs --executable "<полный путь к проверяемому omp.exe>"
   node scripts/omp-tui-smoke.mjs --executable "<полный путь к проверяемому omp.exe>" --native "<полный путь к source-built native .node>"
   ```

   Эта обновлённая версия smoke сама хеширует **явно переданный тестовый** executable; production-регистрация обязана сравнивать с заранее записанной доверенной checksum. Отчёты — `.provider-dock/omp-validation/smoke-*`. Поиск утечек охватывает DB/WAL/SHM/config/logs, а не только `agent.db`.

## Контракт управляемого запуска

`src/clients/omp/omp-runtime.ts`:

- `preflight(selection)` возвращает безопасный результат/`OperationDiagnostic`, не раскрывает environment и не создаёт файлов.
- `prepare(runId, selection)` повторно проверяет артефакт и выдаёт **внутреннюю** process specification с ephemeral secrets. Объект нельзя сериализовать/возвращать browser API.
- Изменяемые конфиги находятся в свежем `<scope>/runs/<runId>/agent`; история — в provider/account-scoped sessions. Подмена конфигурации уже запущенного агента исключена новым каталогом.
- `HOME`/`USERPROFILE`, `PI_CODING_AGENT_DIR`, XDG и AppData направлены в managed run home. `PI_CONFIG_DIR` — относительное `config`: абсолютное значение неверно обрабатывается upstream через `path.join(os.homedir(), ...)`.
- Native loader использует отдельный XDG location; `<XDG_DATA_HOME>/omp` создаётся заранее.
- Из ambient environment исключены чужие API-ключи, legacy homes, proxy и NODE/Bun injection settings.
- `auto` без подтверждённого provider/account/model/origin mapping завершается `PROTOCOL_UNRESOLVED`, а не угадывает протокол.
- Выставлены `always-ask`, только `read`, выключены discovery/skills/extensions/LSP/MCP project config и retry. `startup.setupWizard`, `startup.checkUpdate`, `startup.showSplash` явно false. Это **не OS-песочница**: чтение вне проекта и сетевые возможности read не гарантированно ограничены. Поэтому требуется новое явное подтверждение `read-only-pilot-no-sandbox`; старые permissions не переносятся.
- Pinned OMP загружает project settings раньше выключения discovery. Поэтому пилот **отказывается запускаться при наличии непроверенных project settings** OMP/Claude/Codex/Cursor/Gemini/OpenCode: `OMP_PROJECT_SETTINGS_UNREVIEWED`. Даже безобидный конфиг пока требует отдельного явного импорта. Ни содержание, ни имя файла не изменяются; удалять оригиналы ради запуска не следует.

Проверка ссылок/junctions и свежие каталоги — защита от ошибочной конфигурации, не от злонамеренного локального процесса того же пользователя.

### Обнаруженные дополнительные риски

- Независимое review compiler выявило повторную интерпретацию raw-header secret upstream resolver-ом (command/env substitution), Azure URL rewrite и неверную обработку forward-slash UNC. Исправления приняты повторным review: небезопасный raw-header путь запрещён (официальный Anthropic native `x-api-key` остаётся), неподдержанный Azure Chat rewrite запрещён, UNC исправлен. Это сужает набор пока поддерживаемых маршрутов; такие реальные профили нельзя объявлять мигрированными.
- Настоящий RPC probe показал, что `get_state` возвращает resolved `Authorization` в `data.model.headers`. **Сырые RPC frames нельзя сохранять в диагностике или пересылать браузеру.** Они допустимы только в приватном канале дочернего процесса. Добавлен отдельный `omp-rpc-projection.ts`: только проверенные lifecycle-поля, совпадение request/provider/model, без model headers, prompts, tools descriptions и произвольного error text. Четыре regression-теста прошли RED → GREEN; проверка реального RPC дополнительно контролирует публичную проекцию и отдельно сообщает факт наличия секретов в private frames.
- В pinned CLI явный `--tools read` имеет приоритет над `--no-tools`. В smoke это обнаружено по настоящему запросу и исправлено удалением явного списка в zero-tool cases; assertions проверяют переданный upstream набор.
- Первый ConPTY probe застрял на setup wizard. Причина: новый home и отсутствующий флаг `startup.setupWizard=false`. Одновременно исправлен неверный `update.checkOnStartup`: такого setting в pin нет. Повторный probe прошёл после использования действительных `startup.*` настроек.
- Project `.omp/config.yml` может включить write-tier TTS и `tts: allow` поверх read-only флагов; malformed YAML может быть автоматически переименован upstream в `.broken-*` до tool approval. Preflight presence gate предотвращает оба пути до старта процесса, не пытаясь «починить» чужой конфиг.

### Интеграция dashboard, CLI и default composition

`src/application/omp-launch-service.ts` — это прямой seam поверх runtime и supervisора. Он не вызывает legacy Codex/Claude launchers и не маршрутизирует OMP через старые bridges.

Контракт запуска:

- Требуются явные `providerId`, `modelId`, `accountId` (OMP account), `projectDirectory` и отдельное подтверждение `read-only-pilot-no-sandbox`.
- `preflight()` обязателен перед `launch()`; неподтверждённый `auto`, auth, endpoint, protocol или artifact pin приводит к fail-closed результату.
- Публичные результаты содержат только sanitized `OperationDiagnostic`; `prepare()`, child environment, argv, raw RPC frames, stderr и секреты не покидают сервер.
- Default composition: `createDefaultProviderDock()` / `createDefaultProviderDockAsync()` возвращают `.application` и `.ompLauncher`; прежние `createDefaultApplication()` APIs остаются source-compatible и возвращают только application.
- OMP runtime использует `<data-root>/runtime/omp`, run repository — `<data-root>/runtime/omp-runs`.
- Composition регистрирует только pinned артефакт `.provider-dock/tools/omp-0c6c981ee583/omp.exe` с SHA-256 `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba` и source commit `0c6c981ee5838d97700180383077eb0a3790637c`. `omp-provisional.exe` не используется.

CLI:

```powershell
providerdock launch omp `
  --provider PROVIDER_ID `
  --model MODEL_ID `
  --omp-account ACCOUNT_ID `
  --project DIRECTORY `
  --omp-read-only-pilot-no-sandbox
```

Успешный вывод — только `OMP run started: <runId>`. Неуспешный preflight/launch — только `OMP <phase> failed: <CODE>: <safe message> [<operationId>]`. Флаг `--approval` не заменяет отдельное OMP-подтверждение.

Dashboard API:

```text
POST /api/omp/preflight
POST /api/omp/launch
GET  /api/omp/runs
POST /api/omp/runs/<runId>/cancel
```

API использует Zod-валидацию, перезапускает reconciliation и возвращает копии записей с sanitized diagnostics. UI показывает OMP-аккаунт и отдельное подтверждение; preflight включается только после заполнения маршрута, submit — после успешного preflight и подтверждения, изменение модели сбрасывает preflight. OMP использует только `api/omp/launch` и `api/omp/runs`, без legacy `POST api/launches`.

Финальная локальная матрица 15 сентября прошла: `omp-launch-service` — **1 файл / 6 тестов**, `provider-dashboard-omp` — **1 файл / 7 тестов**, `provider-dock-cli` — **1 файл / 16 тестов**, `default-omp-composition` — **1 файл / 1 тест**, `npm test` — **86 файлов / 841 тест**, `npm run typecheck`, `npm run build`, `node scripts/dashboard-ui-smoke.mjs` и `git diff --check`. Step 3 закрыт по локальной реализации/верификации; миграция остаётся открытой до mapping реальных профилей, согласованных пилотов, импорта истории, portal recovery и cutover.

### Контракт supervisора процесса

`src/clients/omp/omp-process-supervisor.ts`:

- Повторно выполняет `preflight()`, создаёт запись через `OmpRunRepository` и только сервер-side вызывает `prepare()`.
- TUI запускается с `stdio: "inherit"` и доходит максимум до `TERMINAL_OPEN`; READY без RPC-evidence не заявляется.
- RPC использует закрытые pipe, ограничение строки 2 MiB, безопасную проекцию control-frames и записывает только sanitized diagnostics.
- READY означает полученный `ready` frame (protocolVersion 1); затем отправляется `get_state`, а валидный `state` переводит запуск в `RUNNING` с безопасным sessionId.
- Отмена RPC отправляет `abort` и stdin EOF, ждёт grace и останавливает только собственный child; TUI отменяется немедленно. **Итог зависит от подтверждения (M3-R):** собственный `close` child → `CANCELLED`; если grace истёк при потенциально живом child, либо `preflight`/`prepare` ещё висит и child не создан — запуск остаётся в НЕтерминальном `CANCELLING` + `OMP_CANCEL_UNCONFIRMED` (НЕ `FAILED`, НЕ `CANCELLED`), остаётся видимым и отменяемым, dashboard помечает «остановка не подтверждена». Гарантированное жёсткое OS-завершение child на Windows без новой привилегии — `BLOCKED / NOT PROVEN`, не `PASS`. Чужой PID и PID из persisted record не сигналятся. Владение собственным run регистрируется в `tracked` (с pre-generated `runId`) **до** публикации record через `create()`, поэтому cancel, пришедший в окно публикация→регистрация, не теряется: он фиксирует намерение и предотвращает будущий spawn (итог `CANCELLED`), а не возвращает stale `VALIDATING` (M3-RACE). Записи run-store сериализованы по всему supervisor (`serializeWrite`), поэтому fail-fast writer-lock не теряет переход отмены между параллельными run; сам lock остаётся fail-closed для чужого процесса. Событие `ChildProcess.error` (например `EPERM`/`ESRCH` при недоставке kill-сигнала) само по себе не считается выходом: терминально завершается только истинный spawn-failure без созданного процесса (`child.pid===undefined`), иначе ownership и слушатель `close` сохраняются и запуск остаётся отменяемым; синхронный throw из `kill()` глушится `safeKill` (M3-R2).
- Перезапуск дашборда через `reconcileAfterRestart()` помечает непристроенные активные записи как `INTERRUPTED` / `OMP_SUPERVISOR_OWNERSHIP_LOST`; поздние события старого supervisor не перезаписывают terminal state.
- Фейковые child-процессы покрывают spawn error, early exit, timeout, успешную инициализацию, поздний отказ, отмену и рестарт. Реальный TUI smoke перепроверен после добавления `rpcModel`: exit 0, zero upstream requests, secret-free output, no onboarding. Runtime и RPC smokes также перепроверены.

### Интегрированный harness M2/M3 (управляемый fake-child; реальный omp.exe BLOCKED)

> **НЕЗАВИСИМОЕ REVIEW M5-R2 — локальный пакет принят, 29 сентября 2026, HEAD `5025cb3`.** Recovery fixture 32/32 и negative 2/2, typecheck/build (`jsEmitted:129`), полный Vitest 82/1143, package smoke normal 22 checks и negative 23/23, dashboard normal 35 + negative 2/2, credential recovery normal 20/20 + negative 6/6, import probe `unsupported`/`drift:[]`, diff-check — exit 0. Дополнительный reviewer regression обнаружил ложную классификацию текстового упоминания `ENOTCACHED` при другом npm error code; negative smoke RED (1 FAIL) → GREEN после проверки именно строки `npm error code ENOTCACHED`. Pack: 129 source-matched JS, orphan/missing=0. Полный offline install из пустого cache остаётся BLOCKED, foreign-home isolation и OS crash/multi-process race — NOT PROVEN. Это локальная приёмка M5-R2, а не разрешение на real OMP, paid Doctor, live v2, publish или cutover. Детали — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md).

> **ИСТОРИЯ — НЕЗАВИСИМЫЙ VERDICT M5-R — ПРИНЯТ ЧАСТИЧНО, 28 сентября 2026, HEAD `5025cb3`.** Reviewer заново получил typecheck/build exit 0 (`jsEmitted:129`), package smoke normal 21/21 и negative 16/16, полный `npm test` 82/1143 и diff-check exit 0. Обычный pack теперь 129 source-matched JS без трёх прежних orphan. Но новый build-helper удаляет `.dist-prev` в начале, теряя единственную прежнюю сборку после прерывания в окне `dist→backup→dist`, и не сериализует конкурентные build. Offline npm child не изолирует cache/config от пользовательского окружения; `only-if-cached` без `ENOTCACHED` может ложно объявить cache miss. Живые данные/реальные ключи не исследовались, их повреждение не установлено. Старый [M5-R handoff](omp-migration/archive/2026-09-28-m5-r-handoff.md) архивирован; тогда был активен [M5-R2](omp-migration/archive/2026-09-29-step5-probe-r-handoff.md) с fixture crash/concurrency и temp npm-cache/config. Полный offline install и foreign-home isolation остаются BLOCKED/NOT-PROVEN.

> **ОТЧЁТ ИСПОЛНИТЕЛЯ M5-R2, 29 сентября 2026 — ждёт независимого review.** `scripts/build-dist.mjs` восстановит backup при состоянии B, а состояние C (`dist` и `.dist-prev` вместе) остановит без удаления — нужно вручную установить, какая копия целая; lock fail-closed, при наблюдаемой подмене lock дальнейшая публикация прекращается, прежний `dist` и чужой lock остаются. Fixture recovery normal 32/32 и negative 2/2; controlled RED на прежнее удаление backup, неоднозначный C и lock-successor, затем GREEN. `scripts/package-safety-smoke.mjs` передаёт всем npm child owned temp cache/userconfig/globalconfig/prefix и распознаёт cache miss только по `ENOTCACHED`; fixture normal `ok:true`/22 checks (включая один честный BLOCKED и один NOT-PROVEN), negative 22/22, controlled old-env/old-classifier RED→GREEN. typecheck/build, 82/1143 Vitest, dashboard normal/negative, credential recovery normal/negative, import-probe и diff-check зелёные; pack 129 source-matched JS, orphan/missing=0. Это fixture-приёмка исполнителя, не новая независимая приёмка M5-R и не доказательство OS-level crash/multi-process isolation. Реальный offline install из пустого cache **BLOCKED**; foreign-home isolation **NOT PROVEN**. Подробности — [PEER_REVIEW.md](omp-migration/PEER_REVIEW.md). Не выполнять live/publish/commit без отдельного решения.

> **ИСТОРИЯ — НЕЗАВИСИМЫЙ VERDICT M5 — ПРИНЯТ ЧАСТИЧНО, 28 сентября 2026, HEAD `5025cb3`.** Fresh gate: `npm test` 82/1143, merged transcript 46/46, typecheck/build, dashboard normal/negative, recovery normal/negative, import-probe `unsupported`/`drift:[]`, package smoke normal/negative и diff-check — зелёные. Однако `npm run build` оставляет три orphan JS под `dist/ui/` (`portal-browser-batch`, `portal-browser-login`, `portal-extension-login`), и настоящий `npm pack` их включает: source-matched безопасность пакета НЕ доказана; утечка секрета не установлена. Причина неуспеха `npm install --offline` также не классифицирована, поэтому `offline-cache-miss` — неподтверждённое утверждение. Старый [M5 handoff](omp-migration/archive/2026-09-28-m5-handoff.md) архивирован; тогда был активен [M5-R](omp-migration/archive/2026-09-28-m5-r-handoff.md). Исполнительский отчёт сохранён [в PEER_REVIEW](omp-migration/PEER_REVIEW.md). Реальные ключи/сессии/OMP, publish и live cutover остаются вне разрешения.

> **ОТЧЁТ ИСПОЛНИТЕЛЯ M5-R — source-matched пакет и честная офлайн-приёмка (доведён до локальной проверки, ждёт независимого re-review; 28 сентября 2026, HEAD `5025cb3`, без commit/push).** Это отчёт исполнителя, а не reviewer-приёмка; вердикт M5 выше НЕ переписан. **M5-R.1** — `npm run build` теперь идёт через `scripts/build-dist.mjs`: компиляция в чистый `.dist-staging`, sanity-check (`cli.js`+`jsCount>0`), атомарный своп в `dist` с резервом `.dist-prev` и откатом; `assertOwned` жёстко стопит любой delete/rename не по известному basename под repoRoot (никакого broad `rm` по вычисленному корню), провал сборки не заменяет рабочий `dist` частично. Три orphan (`portal-browser-batch`/`-login`, `portal-extension-login`) больше НЕ попадают в `npm pack`; smoke сверяет НАБОР путей `src/*.ts`→`dist/*.js` (`orphanCount:0`, `manifestCount:131`, `distJsInPack:129`), детерминированный orphan-negative fixture RED→GREEN. **M5-R.2** — `classifyInstallFailure` отдаёт приоритет `package-error` (`TAR_BAD_ARCHIVE`/`EINTEGRITY`/`ETARGET`/…) над `offline-cache-miss` (`ENOTCACHED`/`only-if-cached`), читая stderr, но НИКОГДА не печатая сырой stderr; реальный `npm install --offline` репортится отдельным `npmOfflineInstall` (PASS / BLOCKED:offline-cache-miss / BLOCKED:offline-install-unclassified / FAIL), `package-error`⇒FAIL без fallback, а `tarball-extract-offline` bin-проверка независима и не превращает BLOCKED/FAIL в PASS (`m52.status:BLOCKED`). Fixture-путь через установленный bin (`providers set/show/list` вымышленного профиля, без секрета/сети) с положительным `canaryScan` (leaks≥1) в temp-root; `HOME`/`USERPROFILE` не менялись, foreign-home-isolation **NOT-PROVEN**. Негативный набор: синтетические сигнатуры + РЕАЛЬНЫЙ битый `.tgz`→`package-error` + РЕАЛЬНЫЙ uncached-spec→`offline-cache-miss`. **M5-R.3 gate:** `tsc --noEmit` exit 0; `npm run build` `{ok:true,jsEmitted:129}`; `npm test` — 1 раскрытый flaky-FAIL `omp-run-repository…bounds directory enumeration` (I/O-стресс 1001 запись), изолированный повтор 42/42, второй полный прогон **82/1143 PASS** (host-timing, не регрессия, повтор не спрятан); `package-safety-smoke` `ok:true` 21 + `--negative` 16; `dashboard-ui-smoke` normal 35 + `--negative`; `credential-recovery-smoke` 20/20 + `--negative` 6/6; `omp-import-probe` `unsupported`/`drift:[]`; `git diff --check` exit 0; hygiene-scan чист. **Границы:** оффлайн-install без кэша честно **BLOCKED**, полная offline-инсталляция НЕ проверена; foreign-home **NOT PROVEN**; real omp.exe/paid Doctor/OS-hard-kill/live v2/Bun importer/`npm publish`/commit-push-PR вне разрешения. Возврат на независимое re-review.

> **ИСТОРИЯ — ВЕРДИКТ M4-R2 — независимый review ПРИНЯТ ЛОКАЛЬНО, 28 сентября 2026, HEAD `5025cb3`.** Reviewer заново получил `npm test` **84/1143 PASS**, targeted **5/162 PASS**, typecheck/build exit 0, dashboard normal 35 checks/negative PASS, recovery normal 20/20/negative 6/6 PASS, actual importer-probe `unsupported`/`drift:[]` и diff-check exit 0. DPAPI unavailable даёт credential BLOCKED/общий отказ; snapshot всех portal originals обнаруживает дрейф non-active файлов; bounded scan охватывает target vault и fail-closed на unreadable. Это fixture-only, не старый Windows vault/реальная upstream-cookie/реальный OMP. Предыдущий handoff сохранён [в архиве](omp-migration/archive/2026-09-28-m4-r2-handoff.md), тогда был активен [M5](omp-migration/archive/2026-09-28-m5-handoff.md): безопасный локальный пакет и уменьшение test-файлов. Live OMP/paid Doctor/live v2/commit-push-PR не разрешены.

> **ОТЧЁТ ИСПОЛНИТЕЛЯ M5 — офлайн-пакет и компактные тесты (доведён до локальной проверки, ждёт независимого review; 28 сентября 2026, ветка `omp-integration`, HEAD `5025cb3`, без commit/push).** Это отчёт исполнителя, вердикт M4-R2 выше не переписан. Session-scope: `package.json` (`files`-allowlist), новые untracked `scripts/package-safety-smoke.mjs`, слияние трёх transcript-тестов в один файл; production-код не тронут. **M5.1** — в `package.json` добавлен `"files": ["dist/**/*.js"]`, `private:true` сохранён; `npm pack --dry-run --json --ignore-scripts` сверяется по allowlist (только `dist/**/*.js` + метаданные npm; НИ ОДНОГО `src`/`tests`/`docs`/`scripts`/`.env-key`/`.provider-dock`/`.scratch`/`*.pdv`/`sessions`/`screenshots`/чужой home/credential), негативный fixture доказывает, что decoy в собственном temp-root не попадает в pack даже без `.gitignore`. **M5.2** — tarball и `npm install --offline --ignore-scripts --no-audit --no-fund` в отдельных `mkdtemp`; оффлайн-установка честно **BLOCKED** (`offline-cache-miss`), НЕ онлайн-fallback и НЕ подмена source-checkout; поведение установленного bin проверено через `tarball-extract-offline` при отдельных temp `PROVIDER_DOCK_HOME`/`CODEX_HOME`/`CLAUDE_CONFIG_DIR`, очищенном ambient env и НЕтронутых `HOME`/`USERPROFILE`; `--help` и read-only `providers list --json` отработали, пустой fixture-root не становится «imported»/«production-ready». **M5.3** — `transcript-inventory`+`transcript-import-plan`+`transcript-import-preview` слиты в один `tests/transcript-migration.test.ts` тремя разделёнными top-level `describe` с собственными helpers/SCOPE; тела `it` перенесены дословно, ассерции не переписаны, нет `.skip`/`.only`; удалены только три заменённых файла; **46 runtime-тестов** (12 inventory + 25 plan + 9 preview) сохранены; **84 → 82 test-файла, 1143 теста**. **M5.4 gate** — typecheck/build exit 0; merged suite **46 PASS**; полный `npm test` **82/1143 PASS** (первый прогон — 4 flaky 5000 ms таймаута на несвязанных real-I/O/native-dialog тестах, повторно чисто; host-timing, НЕ следствие слияния, универсальная причина не заявляется); `dashboard-ui-smoke` `ok:true`+`--negative`; `credential-recovery-smoke` `ok:true` 20/20 + `--negative` 6/6; настоящий `omp-import-probe.mjs` `unsupported`/`drift:[]`; `package-safety-smoke.mjs` `ok:true` 15 checks + `--negative` 5 checks; `git diff --check` exit 0; hygiene-scan чист. **Границы:** оффлайн `npm install` без кэша — честно **BLOCKED** (`offline-cache-miss`); реальный native OMP import — **NOT PROVEN** (`unsupported`); `npm publish`/commit/push/PR/real omp.exe/live ключи-сессии/live v2/paid Doctor/Bun importer/cutover вне разрешения. Возврат на независимое review.

> **ИСТОРИЯ — предыдущий reviewer-вердикт: независимый M4-R review ПРИНЯТ ЧАСТИЧНО, 28 сентября 2026, HEAD `5025cb3`.** Fresh reviewer: `npm test` **84/1143 PASS**, целевые **5/162 PASS**, typecheck/build exit 0, dashboard normal 35 checks/negative PASS, recovery normal 20/20/negative 3/3 PASS, настоящий import-probe `unsupported`/`drift:[]`, diff-check exit 0. Safe unreadable CONFLICT, explicit fixture activation и verified-backup path приняты. Но forced native-DPAPI unavailable оставляет `sourcePreserved:true/ok:true/exit:0` при девяти BLOCKED credential checks, а mutation non-active `providers.json` в portal backup-сценарии оставляет portal preservation и общий PASS. Оба probe только в памяти на новых fixtures; реальной порчи/утечки не установлено. Активен узкий [M4-R2](omp-migration/archive/2026-09-28-m4-r2-handoff.md), плюс честное bounded-scan покрытие; live credentials/старый DPAPI-профиль/OMP/OS-hard-kill/upstream/paid Doctor/live v2/commit-push-PR вне разрешения.

> **ИСТОРИЯ — предыдущий reviewer-вердикт: независимый M4 review ПРИНЯТ ЧАСТИЧНО, 27 сентября 2026, HEAD `5025cb3`.** Fresh reviewer: `npm test` **84/1136 PASS**, целевые пять suites **155 PASS**, typecheck/build exit 0; normal browser smoke **35 checks**, dashboard `--negative` PASS (оба fault-child ожидаемо exit 1); recovery smoke **15 PASS / native DPAPI available**; настоящий importer-probe `unsupported`/`drift:[]`, diff-check exit 0. NUL guard, CLI/HTTP controls и наконец постоянная finally-wiring регрессия приняты. Но изменённые fixture source bytes при прежнем count дают ложный sourcePreserved/ok, canary в target vault вне scanPaths не обнаруживается, unreadable EISDIR даёт raw CLI rejection (ключ сохранён), recovery activation/verified-backup user-path частичный. Следующий [M4-R](omp-migration/archive/2026-09-28-m4-r2-handoff.md) закрывает эти четыре конкретных требования, не повторяет принятую реализацию. Mutant failures — слабости acceptance, не установленная реальная порча/утечка. Реальные keys/cookies/старый DPAPI-профиль/live recovery/OMP/OS-hard-kill/paid Doctor/live v2/commit-push-PR вне разрешения.

> **ИСТОРИЯ — предыдущий независимый вердикт: независимый M3-RACE review ПРИНЯТ ЛОКАЛЬНО, 27 сентября 2026, HEAD `5025cb3`.** Fresh reviewer: полный `npm test` **84/1122 PASS**, supervisor/repository/harness **3/107 PASS**, typecheck/build exit 0, штатный browser smoke **1/1 PASS / 35 checks**, import-probe `unsupported`/`drift:[]`, diff-check exit 0. Cancel в publication-window предотвращает spawn; собственный tracker зарегистрирован до create. Forced-error до normal timer restore на копии smoke только в памяти реально прошёл через `finally`: nativeRestored=true, timerReleased=true, ticks=0, reArmed=1; до CDP initialization cleanup тоже безопасен, первичная fixture-причина сохранена (ожидаемый exit 1). Первичная CRLF-sensitive ошибка reviewer-wrapper второго probe исправлена только в памяти; не дефект приложения. Persistent smoke пока проверяет helper на обычном пути, не аварийную проводку finally. Следующий [M4-CREDENTIAL-SAFETY](omp-migration/archive/2026-09-28-m4-r2-handoff.md) укрепляет эту регрессию и закрывает отдельный подтверждённый unknown-reference deletion риск при portal corruption; реальный OMP/OS-hard-kill/live recovery/paid Doctor/live v2/commit-push-PR остаются вне разрешения.

> **ИСТОРИЯ — отчёт исполнителя M3-RACE перед независимым review: оба переоткрытых дефекта закрыты, ждёт re-review (27 сентября 2026, ветка `omp-integration`, HEAD `5025cb3`, без commit/push).** (1) Потеря cancel в окне публикация→владение устранена: supervisor регистрирует ownership (`this.tracked.set` с pre-generated `runId`) **до** `runs.create()` (`omp-process-supervisor.ts:136-172`), а ownership point −1 (`if (entry.cancelling) return settleCancelBeforeSpawn(...)`) ловит cancel из этого окна и завершает `CANCELLED` без spawn; `omp-run-repository.ts` принял optional `runId?` (совместимо с прежними вызовами, fail-closed на коллизии id). RED→GREEN: unit `omp-process-supervisor.test.ts:642` + HTTP `omp-integration-harness.test.ts:849`; управляемый pre-fix RED дал HTTP `VALIDATING` (:894) и unit spawn=1 (:675) — совпадает с reviewer-JSON (`stateReturnedByCancel:"VALIDATING"`, `spawnsAfterRelease:1`) → GREEN (2 passed). `cancel()` untracked-ветка не менялась: чужой/orphan run без ownership, PID из persisted record не сигналится, lock fail-closed без stale-reclaim. (2) Error-path cleanup браузерного smoke: `scripts/dashboard-ui-smoke.mjs` вынес outer `cleanupTimerControl` (no-op default + замыкание над живым `cdp`/`socket` после init CDP), `finally` его вызывает; genuine RED на текущем коде дал `{"cleanupError":"ReferenceError","cleanupMessage":"cdp is not defined"}` и `{"timerReleased":false,"ticks":1}` (совпадает с reviewer-JSON) → GREEN с исполняемой негативной fixture-проверкой (non-vacuous), production `setInterval(…,10000)` не тронут. Gate: `tsc --noEmit`/build exit 0; supervisor suite ×3 = 47 passed; полный `npm test` — **84 файла / 1122 теста PASS, exit 0** (первый прогон FAIL на `omp-run-repository.test.ts:503`, где старый boundary-тест кодировал прежний контракт — исправлен вместе с дефектом 1); штатный browser smoke ×3 = `ok:true` / **35 checks**; import-probe `unsupported`/`drift:[]`; `git diff --check` exit 0. Counts до/после: baseline 84/1119 → reviewer M3-FINAL-R 83+1fail / 1118+1fail → **сейчас 84/1122** (+3 теста; smoke checks 34→35). Host-timing флейк `:617` устранён детерминированной переписью, но универсальное отсутствие race — **гипотеза/лимитация**, не доказано; корреляция с нагрузкой доказательством не считается. Scope этой сессии — supervisor.ts, run-repository.ts, два test-файла, run-repository.test.ts, smoke.mjs, три документа; остальные изменённые файлы vs `5025cb3` — прежняя принятая M-серия. Полная таблица факт→файл/строка→тест→статус — [в архивном handoff](omp-migration/archive/2026-09-28-m4-r2-handoff.md). Реальный OMP/OS-hard-kill/live v2/paid Doctor/Bun importer/M4/commit/push/PR — вне разрешения.

> **ИСТОРИЯ — re-review M3-FINAL-R (superseded фиксом M3-RACE выше), 27 сентября 2026, HEAD `5025cb3`: пакет НЕ ПРИНЯТ ПОЛНОСТЬЮ.** Свежий штатный smoke — **1/1 PASS, 34 checks** (browser fault-stop и нормальный timer restore подтверждены); typecheck/build/import-probe (`unsupported`, `drift:[]`)/diff-check — exit 0. Свежий полный `npm test` — **83 файла PASS / 1 FAIL; 1118 PASS / 1 FAIL**: cancel зависшего preflight возвращает `VALIDATING` вместо `CANCELLING`. Targeted retry прошёл, но не отменяет FAIL. Независимая детерминированная fixture-проверка через настоящий dashboard HTTP: опубликованный run при ещё не завершившемся `create()` не зарегистрирован в `tracked`; cancel возвращает **200 / VALIDATING**, затем release всё равно даёт spawn и **TERMINAL_OPEN**. Отдельный forced-error smoke перед нормальным restore обнаружил **ReferenceError: cdp is not defined** в `finally`: `cdp` объявлен внутри `try`, ошибка проглочена catch, cleanup не выполнен. Активное задание — [M3-RACE](omp-migration/archive/2026-09-28-m4-r2-handoff.md): исправить оба дефекта и закрепить детерминированными проверками. Это не доказывает причину всех прежних timing-сбоев и не приписывает production-race последней smoke-правке. Reviewer изменил только существующие документы. Реальный OMP/OS-hard-kill/live v2/paid Doctor/commit/push/PR/M4 — вне разрешения.

> **ИСТОРИЯ — отчёт исполнителя M3-FINAL-R перед независимым re-review (27 сентября 2026, ветка `omp-integration`, HEAD `5025cb3`, без commit/push).** Закрыты оба оставшихся пункта браузерной приёмки, изменён только `scripts/dashboard-ui-smoke.mjs` (production не тронут). (.3) Отдельный controlled fault-run в браузере: исходная причина `OMP_INITIALIZATION_TIMEOUT` держится в non-terminal `CANCELLING` (виден, причина показана, кнопка stop доступна), retry = ровно один POST тому же run без смены причины и без ложного terminal, controlled close → **FAILED** с той же причиной и снятием stop-control, raw canary отсутствует в DOM/HTTP (санитайзинг через настоящий `copyOmpRunRecord`→`sanitizeOperationDiagnostic`). (.4) Test-side restore таймера: после controlled rounds все перехваченные section requests завершены, native `window.setInterval` и исходный background callback восстановлены **ровно один раз**, управляющие globals нейтрализованы, cleanup в т.ч. при ошибке; production `provider-dashboard-script.ts:498` не тронут, тест-hooks в production не попадают. Обе проверки сначала показали RED (управляемая поломка controlled-close → тайм-аут `until FAILED`; управляемая поломка restore → `actual:false`), затем GREEN после отката. Gate: build exit 0; штатный smoke **3 последовательных** `ok:true` по **34 checks** (+1 подтверждающий на свежем dist); `npm test` **84 файла / 1119 тестов** exit 0; typecheck exit 0; `omp-import-probe` `unsupported`/`drift:[]`; `git diff --check` exit 0 (CRLF-only); скан diff чист. Счётчики: файлы 84→84, vitest 1119→1119, smoke checks **32→34 (+2)**. **Гипотеза/ограничение:** host-timing-объяснение флейка полного suite и `staleReturn=0` в единичном probe **не** доказывают универсальное отсутствие race и **не** устанавливают причину AV/GC; в этой сессии штатный smoke не флейкал. Реальный OMP/OS-hard-kill/live v2/платный Doctor/commit/M4 — вне разрешения. Ниже — история.

> **История — независимое review M3-FINAL (27 сентября 2026, superseded вердиктом выше):** два прежних дефекта исправлены локально; свежий reviewer gate — 84 файла / 1119 тестов, typecheck/build/import-probe/diff-check exit 0, штатный browser smoke 3/3 по 32 checks. На свежем dist timeout+EPERM сохраняет `CANCELLING` и причину, retry сигнализирует тому же child, собственный close с exit 0 даёт один `FAILED` с исходной причиной. **Пакет принят частично по спецификации:** ещё нет отдельного browser fault-stop→FAILED и не восстановлен test-side timer-control после controlled rounds. Активна узкая [M3-FINAL-R](omp-migration/archive/2026-09-28-m4-r2-handoff.md); повторная production-переделка не требуется. Датированные отчёты ниже — история. Реальный OMP/OS-hard-kill/production-готовность остаются BLOCKED / NOT PROVEN.

> Независимое review M3-R2 (26 сентября 2026): узкий дефект `handleChildError` исправлен и повторно подтверждён на свежем dist — kill→EPERM без close сохраняет ownership, две отмены дают `CANCELLING` и kill-count 1 → 2, собственный close даёт один `CANCELLED`. Настоящий Node ENOENT корректно даёт `OMP_SPAWN_FAILED`. `npm test` 84 файла / 1106 тестов, typecheck/build/import-probe/diff-check — exit 0. **Весь M3 и полный gate НЕ приняты:** `failAndStop` всё ещё пишет terminal `FAILED` до подтверждённой остановки при RPC timeout/protocol failure; штатный dashboard smoke упал из-за фонового refresh в controlled pending queue. Диагностический smoke с временным управлением timer — не штатный PASS. Активный следующий пакет — [M3-FINAL](omp-migration/archive/2026-09-28-m4-r2-handoff.md). Реальный `omp.exe` и гарантированный OS-hard-kill остаются `BLOCKED / NOT PROVEN`.

> **Результат M3-FINAL (26 сентября 2026, ветка `omp-integration`, без commit/push):** оба открытых результата M3-R2 закрыты локально. `failAndStop()` при подтверждённом spawn больше НЕ пишет terminal `FAILED` до kill — исходная причина держится pending, terminal отдаётся собственному `close` (`FAILED` даже при exit 0); не подтверждённый stop остаётся non-terminal `CANCELLING`, run виден и cancellable, stop-control не исчезает. Штатный `dashboard-ui-smoke` детерминирован (round-identity на стороне теста), production-interval `provider-dashboard-script.ts:498` не тронут: `ok:true`, **32 checks**, 3× зелёный без in-memory patch/retry. Gate на чистом источнике: `npm test` **84 файла / 1119 тестов** ×3, typecheck/build/`omp-import-probe` (`unsupported`, `drift:[]`)/`git diff --check` — exit 0. Полный gate в изоляции зелёный (11 прогонов подряд); ранее наблюдавшийся флейк ~7 несвязанных real-I/O тестов — чувствительность к host-timing под самостоятельно созданной нагрузкой, **не** дефект M3 и **не** RPC-ложь. Гарантированный OS-hard-kill и реальный `omp.exe` остаются `BLOCKED / NOT PROVEN`. Возврат на review; M4/commit не начинались.

Точная команда воспроизведения:

```powershell
npx vitest run tests/omp-integration-harness.test.ts
```

Что он делает: один end-to-end сценарий через РЕАЛЬНЫЕ `OmpLaunchService`/`OmpProcessSupervisor`/`OmpRuntime` (тот же seam, что в production composition, без test-only bypass), обе поверхности (CLI `launch omp` + dashboard preview→preflight→launch→runs/cancel) и прямой RPC `supervisor.start({mode:"rpc"})`, плюс шестистрочная матрица сбоев и restart/ownership. Проходит на loopback `127.0.0.1` с fixture-маркером как единственным ключом; общий fixture — `tests/support/omp-route-fixtures.ts`, управляемый ребёнок — `tests/support/omp-fake-child.mjs`. Локальный итог: **16/16 тестов зелёные** (M2: 10/10 → M3.3 усилил тот же файл до 16, второй suite не создан).

M3.3 добавил в **тот же** файл: строгий fail-closed loopback-gate, отвергающий неверные method(405)/path(404)/protocol(400)/model(400)/marker-auth(401) без печати маркера; проверку, что tool-turn `readMarker` привязан к фактическим байтам fixture (краснеет при подмене файла/хеша); broken-SSE child возвращает 0 при чисто дочитанном stream, поэтому неожиданный успех **ломает** `expect не-SUCCEEDED`; dashboard-путь через один failure и один cancel; project-settings fail-closed на fresh temp dirs (`.omp`/`.claude`/`.codex`/`opencode` → `OMP_PROJECT_SETTINGS_UNREVIEWED`), не трогая рабочий `.claude/settings.local.json`.

Ограничения (не переопределять в отчётах):

- **Реальный `omp.exe` НЕ запускается.** Вместо pinned artifact — управляемый fake-child. Причина: на этой машине нет OS-изоляции egress, оставляющей доступным loopback (M2.1 п. 2 задания); создание такой изоляции — неавторизованное изменение системы. Все actual-binary участки — `BLOCKED`.
- Это **не** OS/network sandbox и **не** подтверждение против настоящего OMP: проверяется только граница ProviderDock.
- Отсутствие test-only bypass обеспечено тем, что `artifact.sha256` = реальный stream-hash fake-child, `artifact.sourceCommit` = `ompConfigSchemaCommit`, а единый `MemorySecretStore` даёт тот же credential-fingerprint, что и продукт: `verifyArtifact()`/`assertCredentialGeneration`/route-acceptance принимают fixture штатным кодом.
- Ребёнку не передаются реальные ключи или ambient credential env; decoy-переменные (в т.ч. `NODE_OPTIONS=--require=…`) служат канарейкой отбрасывания env-allowlist.
- Полный отчёт «сценарий → реальный бинарник / управляемый child → тест/артефакт → PASS/FAIL/BLOCKED» и числа до/после — в [статусе M2](omp-migration/archive/2026-09-28-m4-r2-handoff.md) и актуальном [статусе M3](omp-migration/archive/2026-09-28-m4-r2-handoff.md) задания. Реальный TUI/RPC остаётся BLOCKED без egress-изоляции; «реальный OMP не ретраит/не меняет ключ» помечено `NOT PROVEN`.

## Что остаётся до рабочего перехода

**Credential safety — независимый M4-R2 verdict, 28 сентября:** Fixture-only recovery закрыт: unreadable/corruption не разрешают managed-remove, CLI/HTTP дают safe CONFLICT, backup→masked list→явная активация→resolveActive и portal verified-backup проходят. DPAPI BLOCKED теперь не выдаёт общий PASS, все portal originals покрыты snapshot; credential recovery normal 20/20 и negative 6/6 PASS. Это не доказывает восстановление старого Windows vault или действующую upstream-cookie. Живые managed credentials при неизвестных references не удалять; для live recovery требуется отдельное решение. Историческое [задание M5](omp-migration/archive/2026-09-28-m5-handoff.md) — только офлайн-пакет, fixture installed CLI и компактные тесты.

**Credential safety — результат исполнителя M4-R2, ждёт независимого re-review (28 сентября 2026, ветка `omp-integration`, HEAD `5025cb3`, без commit/push).** Два ложных PASS reviewer'а закрыты локально правкой ровно одного code-файла (`scripts/credential-recovery-smoke.mjs`, untracked); M4-R.1 fail-closed `isReferenced()` в `src/core/security/credential-bindings.ts` НЕ трогался; 84 test-файла сохранены; RED→GREEN — только обратимая правка Edit-ом, не git-checkout. Reviewer-вердикт M4-R выше не переписан, отчёт исполнителя M4-R ниже остаётся историей.
> (M4-R2.1 — forced-unavailable DPAPI больше не маскируется общим `ok:true`.) Ветка credential теперь tri-state EXECUTED / BLOCKED / FAIL: `flags.sourceBytesStable` по умолчанию `undefined` (не `true`), а `SMOKE_MUTATE="dpapi-unavailable"` через `probeDpapi()` даёт девять BLOCKED-проверок и `flags.blocked=true` без вызова protect/unprotect. В `main()` `sourcePreserved = !credentialBlocked && sourceBytesStable===true && portalFlags.sourcePreserved===true`, а `result.ok` дополнительно требует `!credentialBlocked` — два независимых зуба (default-`undefined` И gate). Portal-only PASS отражается отдельным `portalSourcePreserved:true` и не подменяет BLOCKED. RED→GREEN: контролируемая поломка (default `true` + снятие обоих gate) воспроизвела reviewer-JSON №1 `{"forcedDpapiUnavailable":true,"exit":0,"dpapiAvailable":false,"sourcePreserved":true,"ok":true,"blockedChecks":9}` → откат → GREEN `credentialBranch:"BLOCKED", sourcePreserved:false, ok:false, blockedChecks:9, apiKeyPreservation:"BLOCKED", metadataRecovery:"BLOCKED", child-exit 1`. Статус: ЗАКРЫТ ЛОКАЛЬНО.
> (M4-R2.2 — изменение non-active portal original больше не проходит.) Перед каждым сценарием снимается `snapshotTree` КАЖДОГО portal-fixture, и `sourceRootPreserved(before,after,allowedChanged)` сравнивает всё дерево (идентичный набор ключей + побайтовое равенство каждого не-разрешённого ключа); разрешённые исключения — A/C `accounts.json`, B собственный `protected.bin`, D ничего. Точечные сравнения убраны; `cOthersIntact` сведён только в агрегат `portalSourcePreserved`; `canaryScan` bounded (depth 24 / files 4000 / 4 MiB / 64 MiB, любой limit/read-error → `unreadable>0` + отказ); vault-canary перенесён в `join(targetRoot,"vault")`. RED→GREEN: поломка (возврат селективного `cOthersIntact`) воспроизвела reviewer-JSON №2 `{"mutatedPortalProviderMetadata":true,"exit":0,"sourcePreserved":true,"ok":true,"portalSourceCheck":"PASS","portalBackupCheck":"PASS"}` → откат → GREEN `portalSourcePreserved:false, sourcePreserved:false, ok:false, child-exit 1`; то же для `portal-backup-file`; canary-зуб `maxFiles:1` → `unreadable:7, limitHit:"file-count", ok:false, exit 1` → откат → GREEN `leaks:0, unreadable:0`. Постоянный `--negative` runner держит мутанты m1 source-bytes / m2 vault-canary / m3 dpapi-unavailable / m4 portal-provider-metadata / m5 portal-backup-file + контроль none. Статус: ЗАКРЫТ ЛОКАЛЬНО.
> Gate (свежая перепроверка): typecheck exit 0; `npm run build` exit 0; целевые пять suites **5 файлов / 162 теста**; полный `npm test` **84 файла / 1143 теста** (M4-R2 не добавляет `*.test.ts`); dashboard normal `ok:true` **35 checks** + `--negative` `ok:true` (оба fault-child exit 1); recovery normal `ok:true` (EXECUTED, 20/20, sourcePreserved true, canary scanned 55/leaks 0/unreadable 0, blockedChecks 0, apiKeyPreservation/metadataRecovery PASS, upstreamCookieValidity BLOCKED) + `--negative` `ok:true` **6/6**; `omp-import-probe` `unsupported`/`drift:[]`. **Границы (не переопределять):** мутации доказывают детект дрейфа лишь на СОБСТВЕННЫХ временных fixtures — это НЕ реальное повреждение/утечка/потеря ключей пользователя; native DPAPI — только текущий пользователь и вымышленные значения; live upstream-cookie/старый vault/реальный omp.exe/OS-hard-kill/paid Doctor/live v2/commit-push-PR остаются вне разрешения. Полная таблица факт→файл→тест→статус — [в архивном handoff](omp-migration/archive/2026-09-28-m4-r2-handoff.md).

**ИСТОРИЯ — Credential safety: результат исполнителя M4-R до независимого review, ждёт независимого re-review (27 сентября, локально, без commit/push):** четыре переоткрытых пункта закрыты локально правкой ровно двух файлов (`src/core/security/credential-bindings.ts`, `scripts/credential-recovery-smoke.mjs`; 84 test-файла сохранены). (1) `isReferenced()` теперь fail-closed на ЛЮБОМ незавершённом чтении, не только на corruption: unreadable EISDIR/EACCES/EIO дают безопасный CONFLICT (CLI exit 1 / HTTP 409 secret-free), а не сырой Error. (2) Recovery smoke снимает байтовый baseline до recovery и требует `sourcePreserved===true && canary.leaks===0 && canary.unreadable===0` для `ok:true`; canary сканирует весь созданный fixture-space, read-failure считается «неизвестностью», а не «нет утечки»; постоянный `--negative` runner доказывает, что acceptance ловит изменение originals и plaintext-утечку. (3) User-path завершён: реальный CLI `credentials list --json` (masked-only) → явная fixture-активация → `resolveActive` только в памяти, плюс positive recovery из проверенного backup и усиленный safe-refusal. **Руководство сохраняется:** не удалять живые managed credentials при неизвестных references и не переносить fixture-PASS на реальные ключи до приёмки reviewer'ом. Reviewer-мутации доказывают детект только на СВОИХ временных fixtures — не реальное повреждение/утечку ключей пользователя. Live vault/upstream-cookie/omp.exe/OS-hard-kill/paid Doctor/live v2 остаются вне разрешения; DPAPI round-trip — только текущий пользователь и вымышленные значения.

**ИСТОРИЯ — результат исполнителя M4 до независимого review (27 сентября 2026, локально, ждёт независимого review, без commit/push):** `isReferenced()` в `src/core/security/credential-bindings.ts:80-108` переписан fail-closed — при `PortalRepositoryCorruptionError` без совпадения по профилю он бросает `CredentialManagerError("CONFLICT", …)` (безопасная причина, без пути/секрета) вместо ложного «не используется»; `list()` остаётся corruption-tolerant. Тот же guard подтверждён через CLI (`CONFLICT`, exit 1) и настоящий HTTP (`409 CREDENTIAL_CONFLICT`, secret-free, ничего не удалено). Сквозная репетиция backup/recovery на изолированных `mkdtemp`-хранилищах (`scripts/credential-recovery-smoke.mjs`) прошла: `ok:true`, 15/15 checks, `dpapi.available:true`, `canary.leaks:0`; `apiKeyPreservation`/`metadataRecovery` — PASS, `upstreamCookieValidity` — **BLOCKED** (нет сети). DPAPI round-trip — только текущий пользователь и новые фиктивные значения; он НЕ доказывает восстановление старого Windows-профиля. Приёмка reviewer'ом — отдельно; до неё указание выше (не удалять живые managed credentials при повреждённых references) остаётся в силе.

- Clean-machine/полная compatibility/security acceptance source-matched сборки (основная шестисценарная матрица уже прошла).
- Реальные TUI и RPC lifecycle acceptance в интегрированном dashboard/CLI пути; отдельные RPC/TUI smokes уже прошли, но не заменяют приёмку.
- Полная security/retry/tool acceptance; пока не включать shell/write/task/eval/MCP/extensions.
- Перенос истории по явным source roots с отчётом и provenance; оригиналы сохранить.
- Quiescent verified backup после остановки writers и staged recovery порталов. Текущий core manifest — **inventory, не такой backup**.
- Проверка всех фактически настроенных профилей и отдельно согласованные реальные пилоты.
- Только после этих gates — OMP-only cutover и удаление активного legacy-кода. Установки/пользовательские homes не удалять «заодно».

Актуальный read-only inventory на **16 сентября**: **18 providers / 36 файлов protected secrets** (10 Chat / 7 auto / 1 Messages). Значения 17/35 из handoff 15 сентября больше не актуальны; дополнительный профиль не отброшен. `accounts.json` по-прежнему 280047 NUL bytes, SHA-256 `88894e28ee6b8da1255d95b5cd2ada7e2729eae5d6fa90a6a3179f4d0f686e43`; не заменялся. Число сессий заново не подтверждалось.

### Step 4: офлайн-матрица, не приёмка реальных провайдеров

Отчёт: `docs/omp-provider-mapping-2026-09-16.md`; source/manifest/fingerprints:
`.provider-dock/omp-mapping-2026-09-16-ExxykD/`.
Повторная проверка подтвердила неизменность 38 allowlisted source files и assessments после review-fixes.
Ни один ключ не расшифровывался; account IDs, approved origins и portal associations не назначались.

Новый actual-binary smoke прошёл **16/16 локальных сценариев** для восьми настроенных model IDs.
Только собственный loopback fake upstream, fixture keys и homes на F:; остальные 10 профилей явно skipped.
Это не remote compatibility, не подтверждение capabilities и не разрешение реального inference.
Текущие блокеры: 7 unresolved auto, 3 из них также unsupported static headers; сторонний Messages `x-api-key` у `justwoker-2`; 2 явных Chat-профиля без выбранной модели.
Для всех 18 нужны явные identity/origin/capability decisions перед отдельным разрешением пилота.

### VSLLM: разрешённый маршрут пилота на 23 сентября 2026

Первый точный маршрут прошёл все gates до запуска процесса:

```text
providerId: vsllm
accountId: 16568
baseUrl: https://vsllm.cc/v1
origin: https://vsllm.cc
modelId: glm-5.2-free
protocol: openai-responses
capabilities: text, streaming, tools
```

Doctor level 3 прошёл четыре согласованных inference-запроса; actual-binary
loopback smoke прошёл оба сценария для этой пары; production OMP preflight
вернул `api=openai-responses`. Evidence и decision находятся в
`<data-root>/migration` и читаются fail-closed.

Это разрешение **на pilot**, а не завершённая миграция. Следующая граница —
фактический одноразовый запуск OMP, который снова обращается к платному
провайдеру. До отдельного решения не выполнять его автоматически и не удалять
legacy runtime, историю или пользовательские homes.

### Обновление после ревью: evidence версии 2

Прежние live-файлы evidence и route-decision версии 1 сохранены, но новый
preflight их не принимает и возвращает `OMP_MIGRATION_EVIDENCE_V2_REQUIRED`.
Для нового решения требуется отдельный сохранённый результат Doctor level 3
с отпечатком конфигурации и ссылки на выбранный ключ. Проверяются точные
провайдер, модель, протокол, время, PASS и возможности text/streaming/tools.
Повторный локальный smoke на закреплённом OMP прошёл 18/18 сценариев; v2
evidence подготовлено в assessment-каталоге. Следующая операция с VSLLM —
новый Doctor level 3 для получения отпечатка; его четыре inference-запроса
требуют отдельного разрешения. После него можно собрать v2 route-decision,
опубликовать оба live-файла и повторить preflight.

## Восстановление после crash-lock (ручная процедура оператора)

Оба on-disk замка **fail-closed**: удерживаемый замок никогда не забирается
автоматически. Писатель ждёт до busy-timeout, затем бросает ошибку с **точным**
путём замка и секрет-независимой инструкцией. Данные при этом не меняются.

- **Реестр ключей** — `FileCredentialMetadataRepository`: замок это каталог
  `<registry>.json.lock` с маркером `owner.json` (`{ownerId, pid, acquiredAt}`).
  Ошибка: `CredentialRegistryLockError` — «…the lock at '<path>' was held for the
  whole wait and is never reclaimed automatically. No changes were made. Retry;
  if no ProviderDock process is running, the owner crashed — remove that lock
  directory manually to recover. It holds no account data or secret.»
- **Порталы** — `FilePortalRepository`: замок это файл `<accounts>.json.lock`.
  Ошибка: `PortalRepositoryLockError` — «Portal account store is locked by
  another writer ('<path>'). No changes were made. Retry; if no ProviderDock
  process is running, delete that lock file to recover — it holds no account
  data or secret.»

Процедура (не автоматизировать; не удалять живой или неизвестный замок):

1. **Повторить операцию.** При кратковременной конкуренции второй писатель
   пройдёт после освобождения замка; повтор — первое и обычно достаточное
   действие.
2. **Проверить писателей.** Убедиться, что не выполняется ни один процесс
   ProviderDock (CLI, dashboard, supervisor). Если есть сомнение — считать замок
   живым и НЕ трогать: crashed-owner неотличим от живого преемника, занявшего
   замок в промежутке.
3. **Сохранить при сомнении.** Не изменять данные и сам замок, пока живой
   писатель не исключён доказательно.
4. **Удалить только названный замок.** Только при доказанно остановленных
   процессах удалить именно тот путь из сообщения (каталог `…lock` для реестра,
   файл `…lock` для порталов). Замок не содержит ключей или данных аккаунта.
5. **Повторить и проверить хранилище.** Повторить операцию и убедиться, что
   `list()` реестра/порталов читается штатно.

Замечание об атомарности: managed-import порталов и vault не разделяют общую
транзакцию. Частичный сбой не «чинится» молча — сервис возвращает явный
`PORTAL_IMPORT_RECOVERY_REQUIRED`, и восстановление выполняется по шагам выше,
без предположения об атомарности между portal-файлом и секрет-хранилищем.
