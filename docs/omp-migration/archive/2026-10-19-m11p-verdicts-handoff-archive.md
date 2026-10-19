# Архив handoff M11-P и M11-P2 — 19 октября 2026

Этот файл сохраняет прежнее активное задание M11-P, результаты проверок M11-P/M11-P2 и исторический контекст. Актуальный статус и проверка внешнего прогона Windows находятся в [AGENT_HANDOFF.md](../AGENT_HANDOFF.md).

---

# АКТИВНОЕ ЗАДАНИЕ M11-P — ПОДГОТОВИТЬ ВНЕШНИЙ ПИЛОТ И EVIDENCE SCHEMA

## Свежий вердикт координатора

**M10-R2 принят полностью для локальных критериев главы 5, включая browser acceptance на Chrome for Testing 155.** Локальный synthetic loopback/fake-child контур не доказывает actual `omp.exe`, native resume, external egress/isolation и живую provider route.

> **Передано 18 октября 2026.** Прежние задание, дисциплина M10-R.1…R.7 и вердикт координатора сохранены в [архиве](archive/2026-10-18-next-stage-handoff-archive.md). Свежий отчёт M10-R2 и browser-дополнение остаются в [PEER_REVIEW.md](PEER_REVIEW.md).

## Роль и границы

Исполнитель: **Sol**. Это doc-only подготовка внешнего этапа M11, а не запуск пилота. Не изменяй код, тесты, `.scratch`, чужие файлы или `AGENT_HANDOFF.md`. Не выполняй `omp.exe`, native resume, external network egress, live credentials/sessions/homes, paid Doctor/VSLLM, live provider route, OS isolation/ACL, cutover, commit/push/PR. Не запрашивай и не записывай секреты, токены, cookie, реальные endpoint-данные или transcripts.

При 503/5xx не повторяй внешние операции: они вне scope. Зафиксируй в итоговом отчёте только то, что doc-only этап не требует внешнего запроса.

Разрешённые файлы:

- новый `docs/omp-migration/M11_EXTERNAL_PILOT_PLAN.md`;
- `docs/omp-migration/REMAINING_PLAN.md` — только ссылка на новый план и фактический статус M11-P;
- `docs/omp-runtime-runbook-ru.md` — только актуальный верхний статус и ссылка на M11-план;
- `docs/omp-migration/PEER_REVIEW.md` — новый краткий отчёт исполнителя M11-P сверху.

## M11-P.1 — план внешнего пилота

Создай `M11_EXTERNAL_PILOT_PLAN.md`. Документ должен отличать подтверждённые локальные факты от будущих внешних действий и содержать:

1. Цель M11 и четыре непокрытые границы: actual `omp.exe`, native resume, external egress/isolation, живая provider route.
2. Отдельные явные авторизации перед каждой границей: scope/проект, ответственный, разрешённые credential class и маршрут, лимит стоимости и числа запросов, временное окно, критерий остановки. Отсутствие любого поля означает `BLOCKED`, а не разрешение по умолчанию.
3. Последовательные фазы: authorization/preflight; actual-binary launch; native resume; egress and OS-isolation proof; provider-route/pilot acceptance; rollback observation. Для каждой укажи входной gate, безопасный наблюдаемый сценарий, ожидаемый evidence, fail/stop правило и результат, который не считается доказательством.
4. Cutover, удаление legacy, commit/push/PR и изменение production default вынеси как явно исключённые из M11 действия с ссылкой на главу 6.
5. Минимальный rollback/runbook: immutable snapshot до внешнего действия, правило остановки при side effect/неожиданном egress, владелец решения об откате, путь возврата без удаления пользовательских homes/архивов.

## M11-P.2 — проверяемая evidence schema

В том же документе опиши schema (таблицей или JSON-like полями без вымышленных значений), применимую к каждой фазе. Минимальные поля: `phase`, `evidenceId`, UTC time window, actor/approver, authorization reference, project and route identifiers в безопасно редактированном виде, OMP binary version and SHA-256, environment/OS-isolation attestation, credential class без значения, request/cost counters, preflight/run identifiers, native-resume linkage, network-egress observation, expected versus actual result, side-effect assessment, rollback decision, artifact locations, redaction policy и integrity hash.

Определи правила: evidence append-only; секреты, raw headers, cookies, tokens, transcripts и пользовательские absolute paths не записываются; отсутствие обязательного поля даёт `NOT PROVEN` или `BLOCKED`; local synthetic evidence M10-R2 нельзя повышать до evidence реального пилота. Для каждого из четырёх внешних claims задай точный минимальный набор evidence и отрицательный/stop outcome.

## M11-P.3 — синхронизировать статусы и runbook

Обнови только верхние актуальные status-блоки в `REMAINING_PLAN.md` и `omp-runtime-runbook-ru.md`: M10-R2 локально принят, глава 5 ожидает внешнего M11 evidence; M11-P — doc-only preparation in progress/completed according to this work; главы 6–7 и cutover не начаты. Исторические разделы не переписывай. Ссылка из обоих документов должна вести на новый M11-план.

В начало `PEER_REVIEW.md` добавь отчёт: изменённые файлы, перечисление содержимого плана/schema, выполненные локальные проверки, точные неоткрытые внешние границы и подтверждение отсутствия внешних операций. Это отчёт исполнителя, не coordinator verdict.

## Проверка и приёмка

Перед изменениями запиши `git status --short`; не очищай worktree. После каждого документа проверь локально:

```bash
git diff --check
rg -n 'M11_EXTERNAL_PILOT_PLAN|M10-R2|actual omp\.exe|native resume|external egress|cutover' \
  docs/omp-migration/AGENT_HANDOFF.md docs/omp-migration/REMAINING_PLAN.md \
  docs/omp-runtime-runbook-ru.md docs/omp-migration/M11_EXTERNAL_PILOT_PLAN.md
```

Приёмка: документ содержит phase gates и schema выше; каждый внешний claim имеет authorisation gate, evidence и stop criterion; статусы плана/runbook не называют пилот выполненным; ссылки существуют; `git diff --check` проходит. В финальном сообщении дословно повтори отчёт из `PEER_REVIEW.md` и перечисли не выполненные внешние границы.

## Результат проверки M11-P координатором — 18 октября 2026

**Вердикт: принято частично (принято с замечаниями P2).** Документальная подготовка M11-P выполнена по существу; внешний пилот не начат и этим вердиктом не разрешается.

**Подтверждено:**

- M11-P.1 содержит цель и все четыре непокрытые границы, отдельные A1–A4 authorization gates с scope/project, responsible/approver, credential class и route, cost/request caps, UTC window и stop criteria. Записи явно помечены `BLOCKED`; `none`/нулевые caps обозначены как текущий безопасный заблокированный статус, а будущая authorization record обязана содержать фактические значения. Вымышленных credentials, endpoint-данных или лимитов для запуска нет.
- Описаны шесть последовательных фаз с входными gates, безопасными сценариями, ожидаемым evidence, fail/stop правилами и тем, что доказательством не считается.
- Cutover, удаление legacy, commit/push/PR и production default явно исключены со ссылкой на главу 6. Rollback/runbook содержит immutable snapshot, остановку при side effect/неожиданном egress, rollback owner и возврат без удаления пользовательских homes/архивов.
- M11-P.2 содержит все обязательные поля schema, append-only и redaction rules, классификацию `BLOCKED`/`NOT PROVEN`, запрет повышения synthetic M10-R2 и точный минимальный evidence/stop outcome для каждого из четырёх claims. Схема не обещает выполненный пилот.
- M11-P.3 оставляет M10-R2 локальным, M11-P — doc-only preparation, pilot — `NOT STARTED`, а главы 6–7 и cutover — не начаты. Ссылки на новый план существуют и разрешаются; старый M10-R отчёт сохранён в архиве без изменения содержимого.
- Локально повторены `git diff --check`, обязательный `rg`, проверка schema/запрета абсолютных пользовательских путей и аудит относительных ссылок. Внешние операции, live credentials, paid-запросы, настоящий `omp.exe`, native resume, egress/isolation и provider route не выполнялись. Diff содержит только разрешённые M11-файлы плюс ранее существовавшие M10-R2 код/тесты/архивы; код и тесты M11-P не менял.

**P2 — замечание по объёму M11-P.3:** в `REMAINING_PLAN.md` добавлены отдельные датированные status-блоки внутри глав 5, 6 и 7. Задание разрешало менять только верхние актуальные status-блоки; исторический текст не переписан, но эти дополнительные вставки выходят за заявленный scope. Перед следующим документальным обновлением их следует удалить либо явно обосновать отдельным заданием.

**P2 — неоднозначность входного gate:** Phase 1 требует, чтобы были заполнены и одобрены все A1–A4, включая авторизацию живой provider route, хотя раздел authorization gates задаёт независимое разрешение перед соответствующей фазой. При поэтапной выдаче авторизаций это преждевременно блокирует безопасный preflight и ранние внешние границы. До внешнего запуска нужно явно выбрать пофазное правило («только соответствующий A-gate») либо подтвердить намерение требовать все четыре approval заранее.

**Осталось:** actual `omp.exe`, native resume, external egress/isolation и живая provider route остаются `BLOCKED`/`NOT PROVEN`. M11-P по содержанию закрывает doc-only подготовку; P2 требуют отдельного уточняющего блока до открытия внешнего пилота. Открытие внешнего M11 требует отдельного решения пользователя по каждой границе с фактическими scope/project, responsible и approver, credential class и allowlisted route, числовыми cost/request caps, UTC window и stop criterion. Авторизации, evidence и rollback должны быть записаны без секретов и raw data. Архивирование закрытого M11-P handoff/report откладывается до следующего распределения; ручной перенос сейчас не выполняется.

**Следующий блок:** исправить scope status-блоков и зафиксировать правило Phase 1; затем, только после пользовательского решения, выдавать независимые A1–A4 и проверять соответствующий claim-specific minimum evidence. Любой неполный gate остаётся `BLOCKED`, а любой неполный/противоречивый evidence — `NOT PROVEN`; при 503/5xx повтор не выполнять.

## Результат проверки M11-P2 координатором — 18 октября 2026

**Вердикт: принято полностью.** Уточняющий doc-only блок M11-P2 закрывает оба замечания P2; документальная подготовка внешнего пилота M11 закрыта. Внешний пилот этим вердиктом не открыт.

**Замечания:** не осталось.

**Подтверждено:**

- Отчёт Sol «M11-P2» находится в начале `PEER_REVIEW.md`. В `REMAINING_PLAN.md` отсутствуют ровно три датированные status-вставки, перечисленные в отчёте, из глав 5, 6 и 7; текущий diff этого файла меняет только верхний актуальный статус, исторический текст и остальные разделы сохранены.
- В `M11_EXTERNAL_PILOT_PLAN.md` явно действует пофазное правило: Phase 1–2 требуют только A1, Phase 3 — A2, Phase 4 — A3, Phase 5 — A4. A2–A4 не требуются для Phase 1/preflight и Phase 2; Phase 6 использует существующие records без нового A-gate. Последовательность принятых предыдущих evidence и stop-rules согласована с этим правилом.
- Все A1–A4 остаются `BLOCKED`; в плане нет выданной авторизации, live credential, raw route или фактического лимита. Нулевые текущие caps и `none` обозначают безопасное заблокированное состояние до отдельной записи с числовыми значениями.
- План и runbook не называют внешний пилот выполненным: actual `omp.exe`, native resume, external egress/isolation и живая provider route остаются `BLOCKED`/`NOT PROVEN`; cutover, production default и удаление legacy не разрешены.
- Повторены `git diff --check` и обязательный `rg`; относительные ссылки проверены и существуют. Внешние действия, сеть, live credentials/sessions/homes, paid requests, `omp.exe`, native resume, egress/isolation и provider route не выполнялись; 503/5xx не возникали.
- Набор изменённых путей соответствует разрешённому: M11-P файлы (`REMAINING_PLAN.md`, `M11_EXTERNAL_PILOT_PLAN.md`, `PEER_REVIEW.md`), этот handoff и ранее существовавшие M10-R2 код/тесты/архивы. В рамках этой проверки изменён только `AGENT_HANDOFF.md`.

Для открытия внешнего пилота требуется отдельное решение пользователя по каждой из четырёх границ: фактические `scope/project`, `responsible`, `approver`, класс credentials и allowlisted route, числовые cost/request caps, UTC window и stop criterion. До таких решений соответствующий A-gate остаётся `BLOCKED`; следующее распределение выполняется после их фиксации и проверки claim-specific minimum evidence.
