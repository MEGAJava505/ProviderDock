# Текущий статус M11

Прежние разделы «M11 runbook опубликован» и вердикт `30f95f7` перенесены в [архив проверки evidence](archive/2026-10-19-m11-evidence-handoff-archive.md).

## Результат проверки M11 evidence координатором — 19 октября 2026

**Вердикт: пакет принят частично; безусловный PASS фаз 0–4 и 6 не подтверждён. Внешний пилот не завершён, A4 законно BLOCKED.** P1 не найдено. Нужны append-only уточнения P2 по A1, времени rollback и redaction идентификаторов.

Проверен `f95c2e5ee5d41ea5b9123a8bdb61afda9d535853`, включая `5f6d1cd`, относительно `b9fa02f`. Контракт: [M11_PILOT_RUNBOOK.md](M11_PILOT_RUNBOOK.md), фиксированный evidence-контракт, и [M11_EXTERNAL_PILOT_PLAN.md](M11_EXTERNAL_PILOT_PLAN.md), разделы 2–4. Пути evidence ниже относительны к `evidence/m11-pilot/` проверенного коммита; `:N` означает строку.

### Фазы: claim против evidence

| Фаза | Вердикт | Подтверждение и границы |
|---|---|---|
| 0 — preparation | PASS | `phase0-preparation/{local-gates,snapshot-observation,summary}.json`: 228/228, семь suites, build/typecheck и остальные gates exit 0; bundle, metadata и binary имеют SHA-256/read-only attestation. Вложенный snapshot manifest hash проверен. Isolated provider state отсутствовал, оригинальный state не копировался. |
| 1 — A1 authorization/preflight | NOT PROVEN | `authorization-explicit-user-000044`, `fresh-isolation-proof-000045`, `preflight-explicit-user-pass-000046`: positive host control, deny contained loopback/outside-file, AppContainer attestation есть. Probe 08:17:52–08:17:53 раньше начала указанной authorization 08:18:37.258, при этом `observationWithinWindow:true` (P2-1). |
| 2 — A1 actual binary | NOT PROVEN полного evidence | `actual-launch-pass-000047` / `summary-reviewed-000082`: actual OMP 18.0.4, SHA-256 `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`, 08:18:47–08:18:54, exit 0, deadline 45 s, ACP initialize/session-new/EOF, native state hash. Сам bounded launch подтверждён. Отдельного observed process tree нет, network block summary относится к inert preflight (P2-2); Phase 1 требует уточнения. |
| 3 — A2 native resume | PASS наблюдения (*) | `authorization-continuation-000050`, `preflight-continuation-000051`, `native-resume-pass-000052`, `side-effects-continuation-000053`, `summary-reviewed-000083`: один native `--resume`, source/run/session/model linkage, readonly copy, одинаковый before/after SHA-256 `edf5116475f6d0d419d23813f40a28fa251ced5b536ed3b55c3d3a8c6505b6ea`, exit 0 в 08:20:21–08:20:23, messageCount/duplicateMessages 0. Только idle resume без inference. |
| 4 — A3 egress/isolation | PASS наблюдения (*) | `authorization-correction-000060`, `preflight-correction-000061`, `external-egress-pass-000062`, `summary-reviewed-000084` и audit sources: AppContainer без network capabilities; direct TCP → EACCES; unlisted broker route отклонён до сети; один allowlisted TLS 1.3 HEAD → 200, pinned peer, 57 request bytes / 315 response-header bytes, payload 0, provider requests/cost 0, teardown. Только inert Node + host stdio broker. |
| 5 — A4 provider route | BLOCKED | Цепочки pending `000066/000073`, blocked preflight `000067/000074`, blocked summary `000069/000075`, reviewed summary `000085`: нет protected scoped/ephemeral credential, конкретной модели/принудительного cost cap и открытого UTC window. `runId:not-started`, requests/cost 0. `profile-created-000072` подтверждает только отключённый профиль. |
| 6 — rollback observation | NOT PROVEN итоговой записи | `rollback-pass-000076`: bundle/state/binary hashes согласованы с Phase 0, restored tree совпадает с Git tree `b9fa02f`, fsck 0, own processes/profile mappings 0, sockets/brokers closed, native source сохранён, user homes/archives не удалены. Summary `000086` указывает окно 08:29:52.396–08:29:52.396, а итоговый postcheck выполнен 08:29:58 (P2-3). |

(*) PASS A2/A3 относится к собственным наблюдениям указанного сценария. Он не закрывает замечания A1 и не открывает последовательный gate A4. A3 не доказывает direct OMP TCP, host-wide capture или negative child-spawn behavior; эти ограничения честно заявлены.

A1 запускался дважды: сохранены STOP `000040` (около 49 секунд, лимит не доказан), отказ approval review `000043` (команда не исполнялась), новая явная пользовательская authorization `000044` и один успешный повтор. `pilot-status-reviewed-000087` честно считает два A1 запуска и один A2; первый STOP не скрыт. Это не automatic retry после 5xx.

### Инвентаризация, schema и integrity

**147 файлов: 95 JSON, 52 TXT; шесть фазовых каталогов, 11 файлов в корне.** Все 36 обязательных файлов присутствуют: `authorization.json`, `preflight.json`, `run-log.txt`, `side-effects.json`, `summary.json`, `integrity-hashes.txt` в каждом каталоге. Полный список — в приложении.

Исторические `summary.json` A1–A4/Phase 6 содержат ранний BLOCKED с объяснением в `reason`/`actualResult` и `run-log.txt`. Продолжение добавлено новыми файлами; текущие summary выбираются через `pilot-status-reviewed-000087.currentArtifacts`. Во всех шести текущих summary присутствуют обязательные поля. Их наличие не устраняет семантические замечания ниже.

В Phase 0 `authorizationRef:none`, binary/isolation/resume явно неприменимы. В текущих A3/Phase 6 binary version/hash — `not-applicable`, поскольку в этих фазах OMP не запускался. В A4 отсутствие actual run обосновано. Native source, бинарник и bundle оставлены локально, как указано в snapshot observation/audit index: исходные байты координатору не предоставлены и заново не хешировались.

- **36 манифестов / 828 записей SHA-256** проверены по фактическим байтам, пути разрешены относительно каталога манифеста. Проверены все final/continuation/preflight/review и исходные manifests. Missing/mismatch: **0**.
- `integrity-hashes-final-000088.txt` покрывает **146 из 147** файлов, исключая только себя, как заявлено. Phase review manifests покрывают соответствующие каталоги, исключая себя.
- **84 внутренних `integrityHash`**, пять `publishedSourceSha256` audit index и `snapshot-observation.manifestSha256` совпали. Внутренний JSON hash воспроизведён рекурсивной сортировкой ключей JavaScript `localeCompare`, `JSON.stringify(..., null, 2)`, UTF-8 и одним LF, без верхнего `integrityHash`. Python lexicographic sort даёт пять ложных несовпадений; с фактическим comparator расхождений нет. Название canonicalization не определяет comparator/locale — ограничение воспроизводимости, не P1 mismatch.
- 88 уникальных непрерывных `evidenceId`, `000001`–`000088`. Все 55 файлов `5f6d1cd` побайтово сохранены; `f95c2e5` добавил 92 файла.
- Оба коммита меняют только evidence: код, тесты, dependency manifests и docs ими не изменены.

### Redaction-аудит

Проверены **все 147 файлов**, включая audit source TXT, журналы и manifests: keyword/path/email patterns из задания, Windows/POSIX paths, bearer/key/JWT/private-key patterns, account/route/profile fields, чтение audit sources. **Секретов, credential/token values, captured raw headers, cookies, raw transcripts/payloads, абсолютных пользовательских путей, email и имён аккаунтов не найдено. P1 нет.** Это аудит опубликованного пакета, не неопубликованных Windows logs/vault.

**P2-4: найдены буквальные идентификаторы.** `m11-iana-control` буквально используется audit-кодом как действующий control broker route, `unlisted-control` — отрицательный тестовый route literal. `m11-pilot` — реальный заданный пользователем ID локального профиля. Это не секреты и не upstream account IDs; утечка live provider route ID не установлена. Но строгому требованию редактировать идентификаторы пакет отвечает не полностью. Все места перечислены в приложении. `m11-pilot-route` объявлен redacted alias; свидетельства, что это сырой upstream route ID, нет.

Все **79 keyword matches** разобраны: policy-текст/запреты, Windows access-token API, output-token cap и инструкции не присылать секрет. Это ложные срабатывания на секреты. Десять URL — публичная Microsoft documentation, не provider endpoints. Широкий drive-prefix regex дополнительно совпал с `https:` и тремя regex-литералами; actual absolute paths нет. HEAD/Host/Connection в broker source — статический шаблон с переменной host, не captured headers. Указатель всех keyword matches приведён ниже.

### Замечания и исправления владельцем evidence

**P1: нет.** Ни mismatch, ни опубликованный секрет не обнаружены.

| ID | Приоритет | Файл/строка и проблема | Требуемая append-only correction |
|---|---|---|---|
| P2-1 | P2 | `A1-actual-binary/fresh-isolation-proof-000045.json:6,28,54`; `preflight-explicit-user-pass-000046.json:80–83`; `authorization-explicit-user-000044.json:71–73`: probe раньше связанного окна, несмотря на `observationWithinWindow:true`. | Разделить время observation и записи/approval; сослаться на реально действовавшее разрешение inert probe. Не расширять прошлое окно задним числом и не объявлять probe неавторизованным без проверки прежних разрешений. Actual launch 08:18:47 находится внутри `000044`. |
| P2-2 | P2 | `A1-actual-binary/actual-launch-pass-000047.json:39–49`, `summary-reviewed-000082.json:44–65`: Job cap 1/attestation есть, observed process tree нет; network block взят из preflight. `actual-acp-controller-audit.py.txt:24` инициализирует provider counters нулями, не читает monitor. | Предоставить существующее нормализованное process/run/parent-child observation с временем/binary linkage и источник/границы network counters. Если не наблюдалось — сохранить NOT PROVEN этой части; будущий новый прогон требует отдельного разрешения. Zero-capability attestation поддерживает deny direct network, но не измеряет attempted egress. |
| P2-3 | P2 | `phase6-rollback-observation/summary-reviewed-000086.json:74–77` против `rollback-pass-000076.json:34,40,52`: summary копирует preflight instant, пропуская итоговый postcheck. | Новая summary с фактическим окном финальной проверки и отдельными ссылками на ранние restore/teardown observations. `authorization-continuation-000070.json:36` уже честно объясняет ранний restore; не представлять его сделанным после поздней authorization. |
| P2-4 | P2 | File/line список идентификаторов ниже; `validation-final-000081` и `validation-reviewed-000088` содержат безоговорочный `redactionScan:PASS`. | Новая review-запись уточняет scope прежнего scan; владелец согласует безопасные aliases либо явное исключение для публичных fixture IDs. Новые evidence редактируются последовательно. Старые файлы/история не изменены; иное требует отдельного решения владельца. |
| P2-5 | P2 | `A4-provider-route/preflight-blocked-000074.json:43–55`, `summary-reviewed-000085.json:46–58`: `accepted:true` для AppContainer, удалённого в 08:28:42 (`rollback-pass-000076.json:40–45`), тогда как A4 metadata сняты после 08:33. | Обозначить attestation как историческую A1–A3. Перед A4 заново подтвердить реально используемую среду и route; старый флаг не открывает execution gate. Текущий BLOCKED корректен. |

Текущий `pilot-status-reviewed-000087` честен об общем результате: `BLOCKED`, `externalPilotAccepted:false`, live provider claim `NOT PROVEN`. PASS `validation-*` ограничен structure/integrity validation и не заменяет внешнюю приёмку. Заявленные full-schema/redaction PASS не проверяют отмеченные семантические противоречия. PASS `profile-created-000072` явно относится только к metadata. Следующие status/validation должны отразить замечания и новые superseding ссылки.

### Точный чек-лист снятия блокировки A4

Требования ниже относятся к будущей подготовке пользователя. Эта проверка не разрешает live/paid выполнение; значение ключа не передаётся в чат, evidence, Git или аргументы команды.

1. **Предыдущие gates.** Владелец добавляет corrections P2-1/2/3, решение по P2-4, новые status/validation/manifests и получает приёмку цепочки. Для A4 нужны fresh snapshot/binary/route bindings, process ownership, deny-by-default policy, allowlist, monitors и teardown. A3 control-route proof не разрешает provider route; удалённый AppContainer не является работающей изоляцией.
2. **Выбранный механизм: env одной сессии для импорта в штатный Windows DPAPI vault.** Код использует `DpapiFileSecretVault`/`WindowsDpapiProtector` (`src/application/create-default-application.ts`); интеграция с Windows Credential Manager не предполагается. Пользователь выпускает отдельный краткоживущий credential только для необходимой операции и согласованного route/model, с проверяемым TTL/caps, без production/admin permissions. Ciphertext хранится в штатном vault вне checkout под Windows-учётной записью оператора с ограниченным доступом. В evidence — только класс, redacted reference, expiry и факт защищённого хранения.
   В локальной PowerShell-сессии использовать скрытый ввод (`Read-Host -AsSecureString`), передать значение через process-scoped env только на время штатного `providerdock secrets set <LOCAL_SECRET_REFERENCE> --from-env <SESSION_VARIABLE_NAME>`. Поддержка этой команды проверена в `src/cli/provider-dock-cli.ts:1212–1230`. В аргументах только имена. В `finally` удалить env, освободить временный buffer/secure input, закрыть сессию; очистить clipboard, если использовался. Никаких `setx`, user/machine env, plaintext файла, command literal с ключом, transcript/debug/env dump. Связать protected reference только с pilot profile через штатную конфигурацию; проверить наличие без печати значения или masked suffix. При ошибке DPAPI/доступа/binding — BLOCKED. Хранение вне repo обязательно; имеющиеся `.gitignore` для `.env*`, `.provider-dock/`, `*.pdv` — дополнительная защита от случайного добавления, не защита plaintext.
3. **Новая `A4-authorization.json`** в `A4-provider-route/`, с новым монотонным `evidenceId`; существующие `authorization.json`/pending records не заменять. Будущие preflight/run/summary ссылаются на эту новую запись. До старта обязательны:

   | Поля | Требования |
   |---|---|
   | `phase`, `evidenceId`, `authorizationRef`, `supersedes`, `scope`, `project`, `projectIdRedacted` | Phase 5/A4, уникальный ID, ссылки на pending/принятые gates, только согласованный pilot scope. |
   | `responsible`, `approver`, `costApprover`, `observationOwner`, `rollbackOwner`, `approvalRef` | Назначенные роли и проверяемое одобрение до запуска, redacted identifiers, без выдуманных подписей. |
   | `credentialClassAndAllowlistedRoute`, `credentialClass`, `routeIdRedacted`, `credentialRefRedacted` | Scoped/ephemeral; ровно один allowlisted route; alias вместо реального ID, mapping защищён локально. Ни значения, ни suffix ключа, ни raw endpoint. |
   | `credentialExpiryUtc`, `credentialScope`, `vaultMechanism` | Подтверждённый issuer TTL не позже конца утверждённого окна; ограничения route/model/permissions; проверенный DPAPI vault. |
   | `selectedModel` | Точный model ID/revision и provider binding; без `auto`/fallback. Для частного ID — redacted reference с защищённым проверяемым mapping. |
   | `costLimit`, `requestLimit`, `limits`, `costEnforcement` | Числовой cost cap/валюта, конечный request cap минимального сценария, max input/output tokens, timeout/byte caps, retries=0; источник тарифа, механизм принудительного ограничения до dispatch/во время run, before/after counters. Предложенные прежними pending records значения не являются approval. |
   | `utcTimeWindow.start/end` | Будущее короткое UTC окно, вмещающее preflight, запрос, stop/teardown/отзыв; факт попадания подтверждается наблюдением. |
   | `stopCriterion` | Stop при 401/403/429, 5xx/503, timeout, route/model/hash drift, unexpected response/egress/child/side effect, cap breach, unknown counters или exposure. Automatic retries запрещены, особенно после 503/5xx. |
   | `executionMechanism`, `environmentAttestationRef`, `osIsolationAttestationRef` | Штатный CLI/API путь, свежая allow/deny policy ровно для provider route, credential только нужному процессу, monitors/teardown. |
   | `expectedResult`, `sideEffectPolicy`, `revocationPlan`, `rollbackDecision` | Нормализованный outcome, допустимые эффекты, ответственный за issuer revocation/подтверждение, восстановление без удаления пользовательских данных. |
   | `issuedAtUtc`, `status`, `gateStatus`, `redactionPolicy`, `integrityHash` | Дата и явное approval готовой authorization, canonical hash/manifest. PASS readiness authorization не означает PASS provider run; любой пробел → BLOCKED. |

4. **Модель.** Route owner выбирает конкретную доступную scoped credential модель из актуального каталога/своей панели, с известным тарифом и обеспечиваемыми caps. Зафиксировать один и тот же ID/revision в authorization, локальной pilot route/model binding и fresh preflight; указать источник/дату проверки каталога/тарифа без account/endpoint. Сверить runtime selection до dispatch. Модель A2 не переносить: там не было inference. Если получение каталога требует remote call, оно отдельно разрешается и учитывается; координатор его не делал.
5. **После прогона: отзыв и проверка логов.** Сохранить UTC/run linkage, нормализованный response class, before/after request/cost counters, allow/deny observations, side-effect/rollback decision. Остановить свои процессы, выключить pilot/autohealth. Владелец отзывает именно pilot credential у issuer, фиксирует подтверждение с UTC/redacted reference; затем штатно удаляет только соответствующий local vault entry после проверки bindings. Local removal не равен revocation. Дополнительный live request «проверить неработающий ключ» без отдельного разрешения запрещён.
   Проверить application/controller/gateway logs, shell history/transcripts, temp/config/crash artifacts и staged Git diff; у issuer — usage/revocation audit за окно и после отзыва. Сопоставить route/model/request/cost counters; исключить лишние запросы/потребителей. Проверка по полному значению credential — только локально, без значения в аргументах команд или печати matches. В evidence: проверенные источники/UTC границы, количество совпадений, unreadable/недоступные источники, revocation confirmation, residual process/egress check. Недоступный log = непроверено. Повторить redaction scan всех добавляемых файлов и SHA-256 manifests. Нулевые находки/отзыв доказывают только проверенный scope, не абсолютное отсутствие любой утечки.

### Локальная проверка и ограничения

Исходное дерево чистое, `omp-integration` на `b9fa02f`. Запрошенный fetch остановился: `cannot open .git/FETCH_HEAD: Read-only file system`; checkout/pull исходного дерева не выполнялись. Для чтения создан checkout в `/tmp` через `git init`, разрешённый `git fetch origin omp-integration` и checkout `f95c2e5`. Другой внешней сети, Windows-запуска, live keys/paid requests при ревью не было.

`git diff --check b9fa02f..f95c2e5`, `git diff --check`, `npm run typecheck` — exit 0. Typecheck выполнен и в исходном дереве, и для `f95c2e5` с уже установленными локальными зависимостями; временная ссылка удалена. Полный vitest не повторялся: код/тесты/зависимости неизменны. Проверены commit scope, сохранность 55 прежних файлов, hashes и итоговый документационный diff. Windows pilot не повторялся; неопубликованные binary/state/bundle/logs остаются непроверенными координатором.

Результат оставлен только в этом handoff и новом архиве, без commit/push. Исходная ветка по-прежнему на `b9fa02f` и не содержит evidence; Sunny нужно сохранить эти два документа при синхронизации своей копии с `f95c2e5` перед commit. Evidence и код не изменены.

### Приложения: все файлы и указатель redaction

**Полная инвентаризация** (порядок внутри каталогов лексикографический):

```text
evidence/m11-pilot/
  A1-actual-binary/  (45 файлов)
    actual-acp-controller-audit.py.txt
    actual-launch-pass-000047.json
    actual-launch-stop-000040.json
    approval-review-stop-000043.json
    authorization-acp-000038.json
    authorization-correction-000007.json
    authorization-correction-000041.json
    authorization-explicit-user-000044.json
    authorization-native-node-probe-000014.json
    authorization-native-profile-work-000012.json
    authorization-owned-fixture-000010.json
    authorization-resume-000036.json
    authorization-runtime-profile-000008.json
    authorization.json
    binary-inventory-observation.json
    containment-launcher-audit.py.txt
    diagnosis-continuation-000037.json
    final-cleanup-observation.json
    fresh-isolation-proof-000045.json
    host-capabilities-observation.json
    integrity-hashes-continuation-20261019.txt
    integrity-hashes-final-20261019.txt
    integrity-hashes-preflight-000039.txt
    integrity-hashes-preflight-000042.txt
    integrity-hashes-preflight-000046.txt
    integrity-hashes-review-20261019.txt
    integrity-hashes.txt
    isolation-observation-stop-000009.json
    isolation-observation-stop-000011.json
    isolation-observation-stop-000013.json
    isolation-observation-stop-000015.json
    preflight-correction-pass-000042.json
    preflight-explicit-user-pass-000046.json
    preflight-observer-stop-000006.json
    preflight-pass-000039.json
    preflight.json
    profile-cleanup-after-stop.json
    profile-setup-observation.json
    run-log-continuation-20261019.txt
    run-log.txt
    side-effects-continuation-000048.json
    side-effects.json
    summary-pass-000049.json
    summary-reviewed-000082.json
    summary.json
  A2-native-resume/  (18 файлов)
    authorization-continuation-000050.json
    authorization.json
    integrity-hashes-continuation-20261019.txt
    integrity-hashes-final-20261019.txt
    integrity-hashes-preflight-000051.txt
    integrity-hashes-review-20261019.txt
    integrity-hashes.txt
    native-resume-controller-audit.py.txt
    native-resume-pass-000052.json
    preflight-continuation-000051.json
    preflight.json
    run-log-continuation-20261019.txt
    run-log.txt
    side-effects-continuation-000053.json
    side-effects.json
    summary-pass-000054.json
    summary-reviewed-000083.json
    summary.json
  A3-egress-isolation/  (26 файлов)
    authorization-continuation-000055.json
    authorization-correction-000060.json
    authorization-local-diagnosis-000058.json
    authorization.json
    egress-broker-audit.py.txt
    egress-probe-audit.mjs.txt
    egress-stop-000057.json
    external-egress-pass-000062.json
    integrity-hashes-continuation-20261019.txt
    integrity-hashes-diagnosis-000058.txt
    integrity-hashes-final-20261019.txt
    integrity-hashes-preflight-000056.txt
    integrity-hashes-preflight-000061.txt
    integrity-hashes-review-20261019.txt
    integrity-hashes.txt
    local-diagnosis-000059.json
    preflight-continuation-000056.json
    preflight-correction-000061.json
    preflight.json
    run-log-continuation-20261019.txt
    run-log.txt
    side-effects-continuation-000063.json
    side-effects.json
    summary-pass-000064.json
    summary-reviewed-000084.json
    summary.json
  A4-provider-route/  (22 файлов)
    authorization-pending-000066.json
    authorization-pending-000073.json
    authorization.json
    integrity-hashes-continuation-20261019.txt
    integrity-hashes-final-20261019.txt
    integrity-hashes-preflight-000067.txt
    integrity-hashes-preflight-000074.txt
    integrity-hashes-review-20261019.txt
    integrity-hashes.txt
    preflight-blocked-000067.json
    preflight-blocked-000074.json
    preflight.json
    profile-created-000072.json
    provider-metadata-observation-000065.json
    run-log-continuation-20261019.txt
    run-log.txt
    side-effects-continuation-000068.json
    side-effects.json
    summary-blocked-000069.json
    summary-blocked-000075.json
    summary-reviewed-000085.json
    summary.json
  audit-source-index-000079.json
  integrity-hashes-continuation-000080.txt
  integrity-hashes-continuation-20261019.txt
  integrity-hashes-final-000081.txt
  integrity-hashes-final-000088.txt
  integrity-hashes.txt
  phase0-preparation/  (8 файлов)
    authorization.json
    integrity-hashes.txt
    local-gates.json
    preflight.json
    run-log.txt
    side-effects.json
    snapshot-observation.json
    summary.json
  phase6-rollback-observation/  (17 файлов)
    authorization-continuation-000070.json
    authorization.json
    integrity-hashes-continuation-20261019.txt
    integrity-hashes-final-20261019.txt
    integrity-hashes-preflight-000071.txt
    integrity-hashes-review-20261019.txt
    integrity-hashes.txt
    preflight-continuation-000071.json
    preflight.json
    rollback-pass-000076.json
    run-log-continuation-20261019.txt
    run-log.txt
    side-effects-continuation-000077.json
    side-effects.json
    summary-pass-000078.json
    summary-reviewed-000086.json
    summary.json
  pilot-status-continuation-000080.json
  pilot-status-reviewed-000087.json
  pilot-status.json
  validation-final-000081.json
  validation-reviewed-000088.json
```

**Все места P2-4** (идентификаторы, не секреты):

| Файл | Строки | Содержание |
|---|---|---|
| `A3-egress-isolation/authorization-continuation-000055.json` | 22 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/authorization-correction-000060.json` | 22 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/egress-broker-audit.py.txt` | 6 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/egress-probe-audit.mjs.txt` | 12 | Буквальный отрицательный fixture route |
| `A3-egress-isolation/egress-probe-audit.mjs.txt` | 15 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/egress-stop-000057.json` | 56 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/external-egress-pass-000062.json` | 67, 90 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/local-diagnosis-000059.json` | 52 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/preflight-continuation-000056.json` | 75 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/preflight-correction-000061.json` | 75 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/summary-pass-000064.json` | 56 | Буквальный allowlisted control broker route |
| `A3-egress-isolation/summary-reviewed-000084.json` | 112 | Буквальный allowlisted control broker route |
| `A4-provider-route/profile-created-000072.json` | 45 | Реальный локальный pilot profile ID (публично задан пользователем) |
| `A4-provider-route/run-log-continuation-20261019.txt` | 3 | Реальный локальный pilot profile ID (публично задан пользователем) |
| `A4-provider-route/summary-reviewed-000085.json` | 4 | Реальный локальный pilot profile ID (публично задан пользователем) |
| `pilot-status-continuation-000080.json` | 72, 77 | Реальный локальный pilot profile ID (публично задан пользователем) |
| `pilot-status-reviewed-000087.json` | 73, 78 | Реальный локальный pilot profile ID (публично задан пользователем) |

**Все keyword matches, признанные не секретами** (79 строк):

| Файл | Строки |
|---|---|
| `A1-actual-binary/actual-launch-pass-000047.json` | 63 |
| `A1-actual-binary/actual-launch-stop-000040.json` | 58 |
| `A1-actual-binary/approval-review-stop-000043.json` | 47 |
| `A1-actual-binary/authorization-acp-000038.json` | 54 |
| `A1-actual-binary/authorization-correction-000041.json` | 51 |
| `A1-actual-binary/authorization-explicit-user-000044.json` | 54 |
| `A1-actual-binary/containment-launcher-audit.py.txt` | 88, 89, 98, 100, 102, 156, 157, 159, 160, 162, 165, 173 |
| `A1-actual-binary/diagnosis-continuation-000037.json` | 268 |
| `A1-actual-binary/fresh-isolation-proof-000045.json` | 69 |
| `A1-actual-binary/preflight-correction-pass-000042.json` | 66 |
| `A1-actual-binary/preflight-explicit-user-pass-000046.json` | 65 |
| `A1-actual-binary/preflight-pass-000039.json` | 65 |
| `A1-actual-binary/preflight.json` | 77 |
| `A1-actual-binary/run-log.txt` | 6, 7 |
| `A1-actual-binary/side-effects-continuation-000048.json` | 38 |
| `A1-actual-binary/summary-pass-000049.json` | 43 |
| `A1-actual-binary/summary-reviewed-000082.json` | 71 |
| `A1-actual-binary/summary.json` | 84 |
| `A2-native-resume/authorization-continuation-000050.json` | 50 |
| `A2-native-resume/native-resume-pass-000052.json` | 67 |
| `A2-native-resume/preflight-continuation-000051.json` | 69 |
| `A2-native-resume/preflight.json` | 44 |
| `A2-native-resume/side-effects-continuation-000053.json` | 34 |
| `A2-native-resume/summary-pass-000054.json` | 35 |
| `A2-native-resume/summary-reviewed-000083.json` | 76 |
| `A2-native-resume/summary.json` | 46 |
| `A3-egress-isolation/authorization-continuation-000055.json` | 59 |
| `A3-egress-isolation/authorization-correction-000060.json` | 62 |
| `A3-egress-isolation/authorization-local-diagnosis-000058.json` | 44 |
| `A3-egress-isolation/egress-stop-000057.json` | 64 |
| `A3-egress-isolation/external-egress-pass-000062.json` | 79 |
| `A3-egress-isolation/local-diagnosis-000059.json` | 66 |
| `A3-egress-isolation/preflight-continuation-000056.json` | 64 |
| `A3-egress-isolation/preflight-correction-000061.json` | 64 |
| `A3-egress-isolation/preflight.json` | 44 |
| `A3-egress-isolation/side-effects-continuation-000063.json` | 36 |
| `A3-egress-isolation/summary-pass-000064.json` | 45 |
| `A3-egress-isolation/summary-reviewed-000084.json` | 99 |
| `A3-egress-isolation/summary.json` | 46 |
| `A4-provider-route/authorization-pending-000066.json` | 37, 52 |
| `A4-provider-route/authorization-pending-000073.json` | 52 |
| `A4-provider-route/preflight-blocked-000067.json` | 59 |
| `A4-provider-route/preflight-blocked-000074.json` | 60 |
| `A4-provider-route/preflight.json` | 44 |
| `A4-provider-route/profile-created-000072.json` | 55 |
| `A4-provider-route/provider-metadata-observation-000065.json` | 37, 50 |
| `A4-provider-route/side-effects-continuation-000068.json` | 34 |
| `A4-provider-route/summary-blocked-000069.json` | 38 |
| `A4-provider-route/summary-blocked-000075.json` | 40, 53 |
| `A4-provider-route/summary-reviewed-000085.json` | 64, 65 |
| `A4-provider-route/summary.json` | 46 |
| `audit-source-index-000079.json` | 14 |
| `phase0-preparation/authorization.json` | 48 |
| `phase6-rollback-observation/authorization-continuation-000070.json` | 39 |
| `phase6-rollback-observation/preflight-continuation-000071.json` | 49 |
| `phase6-rollback-observation/preflight.json` | 44 |
| `phase6-rollback-observation/rollback-pass-000076.json` | 87 |
| `phase6-rollback-observation/side-effects-continuation-000077.json` | 39 |
| `phase6-rollback-observation/summary-pass-000078.json` | 38 |
| `phase6-rollback-observation/summary-reviewed-000086.json` | 56 |
| `phase6-rollback-observation/summary.json` | 46 |
| `pilot-status-continuation-000080.json` | 77 |
| `pilot-status-reviewed-000087.json` | 78 |

**Прочие ложные срабатывания path/URL scan:** Microsoft documentation URLs в `A1-actual-binary/authorization-native-node-probe-000014.json:76,77,78`, `authorization-native-profile-work-000012.json:71,72,73`, `authorization-owned-fixture-000010.json:69,70`, `authorization-runtime-profile-000008.json:66,67`; regex literals в `A1-actual-binary/containment-launcher-audit.py.txt:282,283,286`. Email/account-name scan: 0. Строка `phase0-preparation/side-effects.json:7` содержит относительное имя каталога evidence, а не profile/account identifier.
