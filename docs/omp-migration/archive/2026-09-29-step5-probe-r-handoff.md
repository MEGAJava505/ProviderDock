# АРХИВНОЕ ЗАДАНИЕ — STEP5-PROBE-R: ОТКАЗ ПРИ НЕПОЛНОМ ЗАКРЕПЛЁННОМ CHECKOUT

> Это сохранённая точка передачи. Текущее задание — в [AGENT_HANDOFF.md](../AGENT_HANDOFF.md); независимый частичный verdict STEP5-PROBE-R — в [PEER_REVIEW.md](../PEER_REVIEW.md).

> **Точка передачи, 29 сентября 2026; `omp-integration` / HEAD `5025cb3`.** Рабочее дерево накопительно dirty; не сбрасывай и не присваивай себе чужие изменения. Продолжай [главу 3 общего плана](../REMAINING_PLAN.md) и читай [границы Step 5](../../omp-step5-import-blocker-2026-09-24.md). Это узкая локальная правка доказательства, не разрешение на Bun/import, реальные transcript, платный Doctor, live v2 или пилот.

**Goal:** `scripts/omp-import-probe.mjs` различает отсутствующий целиком optional `.scratch/omp` и существующий, но неполный/нечитаемый закреплённый checkout. Во втором случае он возвращает отказ с ненулевым exit, а не `skipped` с exit 0. Сохранить уже работающую проверку pin и локального дрейфа шести upstream-файлов.

## Что уже сделано и где остановились

- Probe проверяет HEAD `0c6c981ee5838d97700180383077eb0a3790637c` и отсутствие локального diff у `foreign-session-import.ts`, `codex-session-store.ts`, `claude-session-store.ts`, `session-manager.ts`, `session-listing.ts`, `session-loader.ts`. Настоящий закреплённый checkout сейчас дал `pinnedCheckoutRevision:true`, `pinnedImportSourcesClean:true`, `drift:[]`. Это статическое доказательство, а не импорт.
- В `scripts/omp-import-probe-smoke.mjs` добавлен пятый fixture-сценарий `missing-source-refused`: он удаляет только созданный в собственном temp Git checkout `session-loader.ts` и ждёт `exit 1`, `drift:["pinnedImportSourcesPresent"]`, без `skipped:true`. **RED уже воспроизведён** командой `node scripts/omp-import-probe-smoke.mjs`: exit 1; `unpinned-checkout-refused`, `pinned-clean-checkout-accepted`, `modified-persistence-source-refused`, `modified-import-source-refused` — PASS; только `missing-source-refused` — FAIL. Fixture после запуска убран.
- Причина RED в `scripts/omp-import-probe.mjs`: `readText()` возвращает `undefined` при любом отказе чтения, а общий ранний `if` для любого из шести файлов печатает `{skipped:true,reason:"pinned-omp-checkout-absent"}` и возвращает 0 до Git-проверок. Исправление **ещё не внесено**. Предыдущий smoke 4/4 и настоящий probe прошли до нового RED. Документы уже описывают шесть охраняемых файлов; итог нового отказа в них ещё не записан.

## Как продолжить

1. Сверь `git status --short` и текущие файлы. Повтори только целевой RED, если код с точки передачи не изменился; не ослабляй `missing-source-refused` ради зелёного результата.
2. В probe сначала определи, существует ли сама `.scratch/omp` как ожидаемый checkout. При её полном отсутствии сохрани явно обозначенный `skipped` (не выдавай его за проверенный verdict). Если checkout существует, но любой из шести файлов отсутствует или не читается, выведи только безопасный структурный отказ, например `drift:["pinnedImportSourcesPresent"]`, и заверши с exit 1. Не печатай абсолютные пути, содержимое файлов или environment. Остальные Git/fact checks сохрани.
3. Доведи fixture до GREEN. Добавь в тот же owned temp smoke отдельную проверку полного отсутствия checkout, чтобы отличие от неполного checkout было наблюдаемым. Реальный upstream не меняй. Проверь `node --check` обоих скриптов, штатный `node scripts/omp-import-probe.mjs` (`unsupported`, `drift:[]`) и `git diff --check`; untracked smoke проверь отдельно, поскольку Git diff его не охватывает. Если затронешь TypeScript/runtime, запусти относящиеся тесты, typecheck, build и полный suite. Для полного `npm test` используй process-local `TEMP`/`TMP` внутри `.provider-dock/test-temp` на E:, так как C: ранее давал `ENOSPC`; не меняй пользовательские переменные.
4. Коротко обнови [блокер Step 5](../../omp-step5-import-blocker-2026-09-24.md) и [REMAINING_PLAN.md](../REMAINING_PLAN.md): точный RED→GREEN, команды и границу статического доказательства. Сохрани историю M5-R2 и предыдущих этапов. Отдельно просмотри свой diff и перечисли любые непроверенные пункты.

**Граница приёмки:** неполный или нечитаемый существующий checkout даёт проверяемый отказ и ненулевой exit; отсутствующий целиком checkout даёт явно помеченный `skipped`; чистый закреплённый checkout сохраняет `drift:[]`; fixture демонстрирует все три исхода. Никакой статус Step 5 `imported` или `supported` из этого не следует. Не делать commit/push/PR и не запускать Bun, OMP, сетевые/платные запросы или доступ к живым homes по этому заданию.

**Отчёт после цели:** после локальной проверки подготовь финальный ответ пользователю в формате `Сделано / Проверено / Не проверено / Skills`. В [PEER_REVIEW.md](../PEER_REVIEW.md) добавь раздел `## STEP5-PROBE-R — отчёт исполнителя` и запиши **тот же текст, который выведешь пользователю после /goal**, с фактическими exit/count, RED→GREEN, изменёнными файлами, ограничениями и статусом общей `/goal`; token usage указывай только если доступен. Сначала запиши и перечитай раздел в `PEER_REVIEW.md`, затем отправь пользователю совпадающий текст. Это отчёт исполнителя, не независимая приёмка; общую миграционную `/goal` не отмечай complete по результату одного probe.

---

# АРХИВНОЕ ЗАДАНИЕ — M5-R2: ВОССТАНОВИМАЯ СБОРКА И ИЗОЛИРОВАННЫЙ NPM

> **Архивный статус, 29 сентября 2026:** локальный пакет выполнен и независимо принят в пределах fixture и изолированного npm после дополнительного RED→GREEN для классификатора `ENOTCACHED`; полный offline install и foreign-home isolation остаются BLOCKED/NOT PROVEN. Отчёт исполнителя и reviewer verdict — в [PEER_REVIEW.md](../PEER_REVIEW.md). Чекбоксы ниже сохранены как исходные критерии того задания; на момент закрытия M5-R2 следующее задание ещё не начиналось.

> **For agentic workers:** Выполняй по шагам с проверкой RED→GREEN. Рабочее дерево dirty; сохраняй чужие изменения. Это сохранённое задание M5-R2, предыдущие [M5](2026-09-28-m5-handoff.md) и [M5-R](2026-09-28-m5-r-handoff.md) сохранены. Историческое требование исполнителю: после выполнения вернуть на независимое review, не называя свой отчёт приёмкой. Никаких commit/push/PR.

**Goal:** Локальный source-matched package остаётся восстановимым при прерывании/конкурентной сборке, а проверка `npm --offline` не обращается к обычному пользовательскому npm-cache и не объявляет произвольную ошибку cache miss.

**Architecture:** `scripts/build-dist.mjs` управляет строго ограниченным набором generated-output каталогов и должен сначала распознать состояние `dist`/staging/backup, лишь потом удалять что-либо. `scripts/package-safety-smoke.mjs` запускает каждый npm child с собственным временным cache/config/log пространством и отдельно фиксирует вердикты pack, offline install и установленного bin. **Tech Stack:** Node >=20, npm offline, TypeScript/Vitest. **Spec:** этот файл, [план миграции](../REMAINING_PLAN.md) и независимый verdict M5-R в нём.

## Факты review и границы

28 сентября 2026: `npm run typecheck` и штатный `npm run build` exit 0 (`jsEmitted:129`); package smoke normal 21/21 и negative 16/16 PASS; полный `npm test` 82 файла / 1143 теста PASS; `git diff --check` exit 0. Три прежних orphan под `dist/ui/` после build отсутствуют — эту принятую часть сохрани. Путь installed `providers set/show/list` на вымышленном профиле подтверждён в temp data-root. Реальный `npm install --offline` по-прежнему BLOCKED; foreign-home isolation не доказана.

**Переоткрыто 1 — потеря recovery-copy:** `scripts/build-dist.mjs` в начале безусловно делает `rmOwned(BACKUP, ".dist-prev")` до компиляции. Если прошлый процесс прервался **после** `rename(dist → .dist-prev)` и **до** `rename(.dist-staging → dist)`, то `dist` отсутствует, а `.dist-prev` — единственная предыдущая работоспособная сборка. Следующий запуск удалит её ещё до возможности отката. Тот же helper использует фиксированные `.dist-staging`/`.dist-prev` без межпроцессной сериализации; второй build может удалить staging первого. Штатный зелёный build не проверяет эти состояния. Не устраняй это увеличением retry или игнорированием ошибок.

**Переоткрыто 2 — npm child не изолирован:** `runNpm()` создаёт child без `env`, поэтому тот наследует настройки npm, включая обычный cache/config/log путь пользователя. `--offline` запрещает сеть, но **не означает** отсутствие чтения/записи npm-cache. Мы не утверждаем, что живые ключи были затронуты, но текущая фраза «никаких real homes» не доказана. Дополнительно `classifyInstallFailure()` считает один лишь текст `only-if-cached` cache miss: `EACCES ... only-if-cached` ошибочно стал бы принимаемым `BLOCKED:offline-cache-miss`. Нужен код ошибки `ENOTCACHED`, а неизвестная ошибка не должна давать общий `ok:true`.

**Не трогать:** реальные ключи, cookie, `.env-key`, `.provider-dock`/живые homes и сессии; сеть, real OMP/VSLLM, paid Doctor, live v2, Bun importer, OS firewall, `npm publish`, cutover/legacy removal. Не проводить разрушительную crash-репетицию на настоящем `dist`: только в собственном temp fixture. Не чистить чужой cache/home задним числом. Если fixture не способен доказать отсутствие иных HOME-доступов без OS-изоляции, оставь `foreignHomeIsolation:NOT-PROVEN`.

## M5-R2.1 — recovery-state и конкурентная сборка

**Files:** `scripts/build-dist.mjs`; один fixture-only тест или smoke в `tests/`/`scripts/` по существующей структуре. Не менять production modules.

- [ ] До правки в собственной временной копии build-helper создай четыре состояния: (A) `dist` есть / backup нет; (B) `dist` нет / backup содержит canary; (C) `dist` и backup оба есть; (D) параллельный второй build. Для B запусти fake `tsc`, возвращающий ошибку: текущий алгоритм должен дать RED — canary-backup удалён. Для D проверь, что второй build не удаляет staging первого; если RED не воспроизведён, зафиксируй наблюдение и не заявляй race доказанным.
- [ ] Прежде любого cleanup различай эти состояния. B — восстанови прежний `dist` **или** fail-closed, сохранив backup без модификации; C — не удаляй неоднозначный backup до подтверждения нового `dist`; D — сериализуй замену/cleanup (fail-closed lock с ownership или эквивалент) либо используй уникальный staging плюс защищённую swap-секцию. Не auto-reclaim потенциально живой lock. Все rename/remove — только по проверенным абсолютным путям внутри repo generated-output; не следуй junction/symlink наружу. Если восстановление невозможно, сохрани байты и выведи secret-free manual-recovery code.
- [ ] Подтверди GREEN в fixture: fail `tsc`, неполный `cli.js`, сбой swap, прерванный swap B и concurrent D не теряют последнюю целую сборку и не публикуют partial `dist`. После нормального build pack manifest остаётся 129 source-matched JS, orphan=0/missing=0. Не удаляй настоящий `dist`/backup вручную ради RED.

## M5-R2.2 — изоляция npm и точный verdict ошибки

**Files:** `scripts/package-safety-smoke.mjs` (возможно общий небольшой helper для npm child внутри этого файла). Не менять runtime CLI.

- [ ] RED: fixture перехватывает env/эффекты `runNpm()` и показывает отсутствие собственного cache/config; classifier на `npm error code EACCES ... only-if-cached` сейчас даёт ложный `offline-cache-miss`. Тест должен реально падать до правки.
- [ ] Для **всех** `npm pack`/`npm install --offline` child используй owned temp `npm_config_cache` и пустой owned `npm_config_userconfig`/`npm_config_globalconfig` (или эквивалентную подтверждённую npm-изоляцию); нормализуй inherited `NPM_CONFIG_*`/`npm_config_*` так, чтобы пользовательская настройка не переопределила fixture; сохраняй только нужные для запуска `PATH`/Windows system vars. Не печатай raw stderr, абсолютные пути и данные env. Убедись, что logs/cache появляются только в temp-root; не сканируй настоящий HOME. Cleanup только созданных roots с проверкой ownership.
- [ ] Cache miss распознавай по конкретному npm коду `ENOTCACHED`, не по общему `only-if-cached`. `EACCES`/`EPERM`/`ENOSPC`, malformed tarball, integrity failure и unknown cause не могут дать принимаемый `BLOCKED:offline-cache-miss`; `FAIL` либо непринимаемый `BLOCKED-UNCLASSIFIED` с exit 1. Сохрани отрицательные проверки настоящего битого tarball и настоящего uncached spec, но теперь с temp npm-cache и нулевой сетью.
- [ ] Убедись, что независимые поля `packageVerified`, `installedBinVerified`, `npmOfflineInstall` и общий `ok` не подменяют отказ успехом. Installed CLI продолжает `--help`, empty list и fixture `set/show/list` с записью в temp `PROVIDER_DOCK_HOME`; `foreignHomeIsolation` остаётся честно NOT-PROVEN без OS-изоляции.

## M5-R2.3 — gate, документы, возврат

- [ ] Fresh `npm run typecheck`, `npm run build`, целевые fixture-regressions, полный `npm test` (не одновременно с I/O-heavy smoke), package smoke normal/negative, dashboard normal/negative, credential recovery normal/negative, `omp-import-probe.mjs`, `git diff --check`. Покажи каждый exit/count и все ретраи/FAIL отдельно. Не маскируй флейк ослаблением assertion, `.skip`, timeout или глобальным retry.
- [ ] Проверь diff+untracked на секреты/debug/временные файлы, без чтения живых значений. Коротко обнови [REMAINING_PLAN.md](../REMAINING_PLAN.md) и [runbook](../../omp-runtime-runbook-ru.md) **только отчётом исполнителя**, сохранив независимый verdict и историю; этот handoff остаётся заданием, новых task/plan Markdown не создавать.
- [ ] Если [PEER_REVIEW.md](../PEER_REVIEW.md) отсутствует, создай. После /goal добавь раздел **M5-R2**: фактическая дата, точная модель только если достоверно известна (иначе «не указана»), затем тот же финальный отчёт, который покажешь пользователю: факт → файл/строка → RED→GREEN → статус, gate, ограничения, изменённые файлы, status /goal и token usage лишь если доступны. Прочитай раздел обратно. Это отчёт исполнителя, **не** независимая приёмка. Остановись и верни на review; M6 и внешние границы не начинай.
