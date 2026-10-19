# Архив handoff перед независимой проверкой M11 evidence — 19 октября 2026

Исторические статусы ниже относятся к моменту публикации соответствующих разделов. Актуальный вердикт: [AGENT_HANDOFF.md](../AGENT_HANDOFF.md). Исходный архив `2026-10-19-m11-external-pilot-handoff-archive.md` сохранён без изменений; здесь собраны прежний handoff и его вердикт 30f95f7. При переносе исправлены только относительные ссылки.

## Handoff до проверки evidence

# Текущий статус M11

Прежние разделы и вердикт `30f95f7` сохранены в [архиве](2026-10-19-m11-external-pilot-handoff-archive.md).

## M11 runbook опубликован — 19 октября 2026

- Runbook: [M11_PILOT_RUNBOOK.md](../M11_PILOT_RUNBOOK.md).
- Публикационный commit: `f2da23a` (runbook и handoff опубликованы).
- Дальше пользователь заполняет authorization A1, выполняет Phase 0–2 и пушит evidence обратно; Sunny передаст его Astra на ревью.

## Ранее архивированный контекст и вердикт 30f95f7

# Текущий статус M11

Прежние задание M11-P, вердикты M11-P/M11-P2 и их контекст сохранены в [архиве](2026-10-19-m11p-verdicts-handoff-archive.md). Отчёты Sol и browser acceptance остаются в [PEER_REVIEW.md](../PEER_REVIEW.md).

Локальная фаза главы 5 подтверждена на двух платформах: Linux VPS и Windows пользователя. Это усиливает готовность к внешнему пилоту M11, но не доказывает actual `omp.exe`, native resume, external egress/isolation или живую provider route. Для начала M11 пользователь должен отдельно авторизовать A1–A4 по соответствующим границам; пофазное правило уже зафиксировано в [M11_EXTERNAL_PILOT_PLAN.md](../M11_EXTERNAL_PILOT_PLAN.md).

## Результат проверки внешнего прогона пользователя (30f95f7) координатором — 19 октября 2026

**Вердикт: принято полностью.** Коммит `30f95f7` честно документирует Windows-прогон локального synthetic/loopback контура. Он не открывает внешний пилот и не повышает локальные evidence до proof четырёх внешних claims.

**Подтверждено по evidence:**

- `manifest.json` содержит 17 опубликованных файлов; размеры и все SHA-256 совпали. `vitest.json` содержит 7 suite-файлов и ровно **228 passed**, без failed/skipped; `summary.json` согласован: **228/228**, `typecheck` и все заявленные gates с exit 0.
- `build-output.txt` подтверждает `{"ok":true,"jsEmitted":130}`; `typecheck-output.txt` подтверждает успешный `tsc --noEmit`. Source SHA-256 для `tests/omp-run-repository.test.ts` совпадает с указанным в summary.
- `browser-normal/report.json` имеет `ok:true`, **12** checks и успешные удаления browser profile/fixture root. `browser-negative/runner.json` имеет `ok:true`; все четыре фазы — `spawn`, `cdp-close`, `network`, `cleanup` — дали ожидаемый child exit 1. Их отдельные отчёты имеют `ok:false`, исходную причину (где применимо), не содержат успешного `result`, и имеют `rootRemoved:true`.
- `regression-before.txt` фиксирует ожидаемый исходный Windows-сбой **226/228** с `OMP_RUN_IO_FAILED`. `regression-mutation.json` фиксирует, что обе целевые регрессии падают при классификации `nlink=0` как `OMP_RUN_UNSAFE_PATH`; исходный production source восстановлен. Production-код коммитом не менялся.

**Оценка fixture-фикса:** правка ограничена двумя atomic-replacement fixtures. На Windows `rename` поверх открытого дескриптора возвращает `EPERM`, в отличие от POSIX rename-over-open. Для Windows fixture теперь получает реальные metadata старого файла, закрывает настоящий handle, выполняет реальный переход к новой записи, затем моделирует только свойства отсоединённого POSIX-descriptor (`nlink=0`) и EOF после полного чтения старых fixture-байтов. На POSIX остаётся реальный rename-over-open. Assertions не ослаблены: по-прежнему требуется `OMP_RUN_CHANGED`, факт инъекции и последующее чтение целой новой записи `STARTING`; mutation показывает чувствительность к неверной классификации. Фикс минимален и обоснован, не подгоняет production-поведение под Windows.

**Локальный повтор на Linux VPS:** `git diff --check 9ce3f3b..30f95f7`, `npm run typecheck` и `npx vitest run tests/omp-run-repository.test.ts tests/omp-integration-harness.test.ts` прошли; целевые suites дали **63/63 PASS**. Повтор сделан из временного снимка именно `30f95f7`, без изменения исходников или тестов рабочего дерева.

**P1:** нет.

**P2:**

- В `regression-mutation.json` сохранились две ссылки stack trace на абсолютный workspace path `E:/Projects/...`. Имени пользователя, токенов, credentials и absolute user-home paths в text/JSON evidence не найдено; PNG также не содержат таких строк. Перед следующим опубликованием evidence следует заменить и этот workspace prefix, поскольку он противоречит заявленной полной redaction workspace paths.
- Среда координатора не позволила выполнить обязательные `git fetch`/`git pull`: запись в `.git/FETCH_HEAD` запрещена read-only mount. `origin/omp-integration` уже указывал на `30f95f7`, поэтому diff и локальный повтор были выполнены по этому объекту. Это ограничение среды проверки, не замечание к коммиту.

**Дальше:** внешний M11 остаётся `NOT STARTED`. Нужны отдельные авторизации A1–A4 от пользователя — по одной на actual `omp.exe`, native resume, external egress/isolation и живую provider route — с полями и пофазным порядком из [M11_EXTERNAL_PILOT_PLAN.md](../M11_EXTERNAL_PILOT_PLAN.md). До соответствующей авторизации каждая граница остаётся `BLOCKED`.
