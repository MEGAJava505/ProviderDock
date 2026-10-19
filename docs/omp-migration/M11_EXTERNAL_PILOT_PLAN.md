# M11 — план внешнего пилота и проверяемая evidence schema

**Срез:** 18 октября 2026. **Статус M11-P:** doc-only preparation завершена. **Статус внешнего M11 pilot:** `NOT STARTED`; ни один внешний claim этим документом не принят.

Этот документ задаёт безопасный порядок подготовки и возможного проведения внешнего пилота ProviderDock в проекте `omp-integration`. Он отделяет локально подтверждённые факты от будущих действий, для которых нужны отдельные авторизации и проверяемая evidence. Локальный M10-R2 принят только по критериям главы 5; synthetic loopback/fake-child не доказывает actual `omp.exe`, native resume, external egress/isolation или живую provider route.

## 1. Цель, границы и правило разрешения

Цель M11 — получить ограниченное, воспроизводимое и обратимое evidence по четырём внешним границам:

1. **actual `omp.exe`** — запуск именно утверждённого бинарника с зафиксированными версией и SHA-256;
2. **native resume** — продолжение фактического OMP run из сохранённого состояния с однозначной связью до исходного запуска;
3. **external egress/isolation** — доказательство разрешённого сетевого маршрута и запрета неожиданного egress в заявленной OS/network isolation;
4. **живая provider route** — один заранее ограниченный маршрут к утверждённому провайдеру с учётом запросов, стоимости и side effects.

M11-P создаёт только план, authorization gates, фазовые сценарии и схему evidence. Отсутствие любого обязательного поля в authorization record означает `BLOCKED`; оно не даёт разрешения «по умолчанию». Пока нет подписанной записи с ответственным, окном и лимитами, соответствующая граница остаётся `BLOCKED`.

Локальные тесты M10-R2, fake-child, loopback, synthetic provider, статический preview, описание маршрута и этот план могут быть входным контекстом, но не могут быть повышены до evidence внешнего пилота.

## 2. Отдельные authorization gates

Ниже приведены четыре независимые записи, которые должны быть заполнены и одобрены **до** входа в соответствующую фазу. Значения секретов, токенов, cookies и raw endpoint не записываются. Текущий статус каждой записи — `BLOCKED`: M11-P не выполняет внешний запрос и не создаёт авторизацию.

### A1 — actual `omp.exe`

- **Scope/project:** ProviderDock / `omp-integration` / M11; только утверждённый actual `omp.exe`, один изолированный запуск и наблюдение его lifecycle.
- **Responsible:** назначенный M11 pilot operator и владелец бинарника; имя ответственного и отдельный approver должны быть указаны в authorization record.
- **Allowed credential class and route:** `none` для binary-only preflight/launch; provider credential и live route запрещены в этой записи. Если запуск должен обратиться к сети, нужна отдельная A3/A4 authorization.
- **Cost limit / request limit:** текущий лимит `0` currency и `0` provider requests; будущая запись обязана указать конечные числовые лимиты до запуска.
- **UTC time window:** сейчас `none`; будущая запись обязана содержать явные `start` и `end` в UTC.
- **Stop criterion:** немедленная остановка при hash/version mismatch, неразрешённом child/process, любом неожиданном egress, side effect, превышении времени или лимита, либо отсутствии наблюдаемого exit/result.
- **Gate status:** `BLOCKED` до заполнения всех полей и approval.

### A2 — native resume

- **Scope/project:** тот же ProviderDock / `omp-integration` / M11; только resume ранее зафиксированного изолированного run, без нового provider request.
- **Responsible:** M11 runtime owner и pilot operator; назначенный approver должен подтвердить разрешение на native resume.
- **Allowed credential class and route:** `none`; resume проверяется на redacted fixture/state и не получает live credential или provider route.
- **Cost limit / request limit:** текущий лимит `0` currency и `0` external/provider requests; будущая запись обязана указать конечные лимиты resume attempts и requests.
- **UTC time window:** сейчас `none`; нужна явная ограниченная UTC window.
- **Stop criterion:** остановить при отсутствии linkage, изменении исходного state, повторном side effect, неоднозначном terminal state, несанкционированном network access или любой попытке обойти native resume contract.
- **Gate status:** `BLOCKED` до заполнения всех полей и approval.

### A3 — external egress/isolation

- **Scope/project:** ProviderDock / `omp-integration` / M11; доказать deny-by-default OS/network isolation и отдельно разрешённый контрольный маршрут.
- **Responsible:** владелец OS/network isolation и security approver; оператор не может сам ослаблять policy или ACL.
- **Allowed credential class and route:** `none` для isolation probe; только заранее allowlisted synthetic sink/control route. Live provider credential и необъявленный destination запрещены.
- **Cost limit / request limit:** текущий лимит `0` currency и `0` live provider requests; для контрольного probe будущая запись обязана указать конечное число попыток и байтовый/временной предел.
- **UTC time window:** сейчас `none`; нужна явная UTC window, включающая preflight, observation и teardown.
- **Stop criterion:** немедленная остановка при неожиданном destination, DNS/proxy обходе, невозможности получить attestation, расхождении allowlist, side effect или утечке данных; при 503/5xx повтор не делать.
- **Gate status:** `BLOCKED` до заполнения всех полей и approval.

### A4 — живая provider route

- **Scope/project:** ProviderDock / `omp-integration` / M11; один утверждённый redacted route identifier и только минимальный pilot acceptance сценарий после A1–A3.
- **Responsible:** владелец provider route, M11 pilot operator и cost approver; все три роли должны быть явно указаны в authorization record.
- **Allowed credential class and route:** только scoped/ephemeral pilot credential класса, утверждённого approver; значение credential не записывается. Разрешён ровно один заранее allowlisted route identifier; raw URL, headers и cookies не записываются.
- **Cost limit / request limit:** текущий лимит `0` currency и `0` requests; будущая запись обязана указать конечный cost cap, request cap и запрет автоматических retries.
- **UTC time window:** сейчас `none`; нужна явная короткая UTC window с владельцем наблюдения.
- **Stop criterion:** остановка при 401/403/429, 5xx/503, timeout, unexpected response shape, превышении cap, side effect, unexpected egress или невозможности безопасно редактировать evidence. После 503/5xx запрос не повторять.
- **Gate status:** `BLOCKED` до заполнения всех полей и approval.

### Authorization record — обязательный минимум

Для каждой A1–A4 должна существовать отдельная append-only запись с полями `scope/project`, `responsible`, `approver`, `credential class and route`, `cost limit`, `request limit`, `UTC time window` и `stop criterion`. Запись с пропуском, неоднозначным «разумным» лимитом, устным согласованием или ссылкой только на локальный fixture считается `BLOCKED`.

## 3. Последовательные фазы M11

Фазы выполняются строго по порядку. Пофазное правило входного gate: перед каждой внешней фазой проверяется только соответствующий границе A-gate, а не все четыре сразу: Phase 1–2 (actual `omp.exe`) — A1, Phase 3 (native resume) — A2, Phase 4 (external egress/isolation) — A3, Phase 5 (живая provider route) — A4. Отсутствие ещё не открытых A2–A4 не блокирует Phase 1/preflight или Phase 2; неполный соответствующий gate блокирует только свою фазу. Phase 6 — rollback observation по существующим records и без новой A-гейт. Нельзя перескочить к provider route, если предыдущая фаза имеет `BLOCKED`, `NOT PROVEN`, незакрытый stop outcome или отсутствующую integrity-проверку. Каждая фаза создаёт отдельный append-only evidence record; отсутствие записи не трактуется как успех.

### Фаза 1 — authorization / preflight

- **Входной gate:** A1 заполнен и одобрен для границы actual `omp.exe`; scope, owner, UTC window, cost/request caps и stop rule проверены; immutable snapshot создан до любого внешнего действия; для preflight counters нулевые. A2–A4 на этой фазе не требуются.
- **Безопасный наблюдаемый сценарий:** read-only preflight в изолированном рабочем каталоге с redacted identifiers; проверить binary inventory, policy, snapshot digest, counters и отсутствие live credential. Никакого запуска `omp.exe`, native resume или provider request на этой фазе.
- **Ожидаемое evidence:** `phase=authorization/preflight`, `authorizationRef=A1`, snapshot hash, preflight ID, zeroed counters, actor/approver и integrity hash.
- **Fail/stop:** любое отсутствующее поле A1, просроченное окно, mismatch snapshot/hash, неясный owner/route, unsafe preflight environment или найденный секрет → `BLOCKED`, дальнейшие фазы не начинать.
- **Не является доказательством:** M10-R2 PASS, локальный `git diff --check`, synthetic report, статическая конфигурация или одна лишь подпись этого плана.

### Фаза 2 — actual-binary launch

- **Входной gate:** принят Phase 1; A1 approved; pinned binary version/SHA-256 совпадают; launch environment и process ownership attested.
- **Безопасный наблюдаемый сценарий:** один bounded запуск actual `omp.exe` в изолированной среде с inert/fixture input и без live provider credential; наблюдать только version, process/run identifiers, exit/result, bounded stdout classification и egress counters.
- **Ожидаемое evidence:** binary version и SHA-256, launch/preflight/run linkage, process lifecycle, expected-versus-actual result, egress observation и side-effect assessment.
- **Fail/stop:** hash/version mismatch, unexpected child, timeout, output/exit contradiction, side effect, unexpected egress или превышение cap → остановить процесс по runbook, пометить `NOT PROVEN`/`BLOCKED`, не повторять автоматически.
- **Не является доказательством:** fake-child, loopback-only harness, `omp.exe` filename без hash, успешная компиляция или запуск без OS attestation.

### Фаза 3 — native resume

- **Входной gate:** Phase 2 evidence принято; A2 approved; исходный run state immutable и имеет redacted linkage; snapshot и counters сохранены.
- **Безопасный наблюдаемый сценарий:** один остановленный/завершённый checkpoint открыть штатным native resume, продолжить в той же изолированной среде и сверить linkage, state transition и отсутствие duplicate side effect; provider request не добавлять.
- **Ожидаемое evidence:** native-resume linkage к исходному `runId`/state hash, resume attempt counter, before/after integrity hashes, terminal result и side-effect assessment.
- **Fail/stop:** linkage отсутствует или меняется, resume создаёт новый несвязанный run, state двусмысленен, повторяется side effect или появляется сеть → stop, `NOT PROVEN`, rollback observation при необходимости.
- **Не является доказательством:** synthetic transcript replay, ручное копирование state, локальный fake resume, UI «resume» без native linkage или отсутствие ошибки без state hash.

### Фаза 4 — egress and OS-isolation proof

- **Входной gate:** Phase 2 и, если применимо, Phase 3 приняты; A3 approved; security/OS owner предъявил attestation, а monitor умеет различать разрешённый и неожиданный destination.
- **Безопасный наблюдаемый сценарий:** bounded запуск с deny-by-default policy, synthetic sink/control route и заранее перечисленным allowlist; наблюдать destination class, direction, byte/request counters и policy decision без raw headers/cookies/tokens.
- **Ожидаемое evidence:** environment/OS-isolation attestation, policy/allowlist reference, network-egress observations, counters, expected-versus-actual route decision и teardown result.
- **Fail/stop:** любой unexpected egress, DNS/proxy bypass, неattested namespace/ACL, невозможность получить negative observation или side effect → немедленно остановить и не продолжать к A4.
- **Не является доказательством:** отсутствие строки в stdout, loopback-only PASS, успешный процесс без network telemetry, synthetic deny test без OS attestation или ручное утверждение оператора.

### Фаза 5 — provider-route / pilot acceptance

- **Входной gate:** A4 approved; Phase 1–4 имеют принятые evidence и integrity hashes; route, credential class, cost/request caps и observation owner совпадают.
- **Безопасный наблюдаемый сценарий:** минимальное число заранее разрешённых live requests по одному redacted route identifier; без retries, background refresh, tool expansion или изменения production default. Считать request/cost counters до и после.
- **Ожидаемое evidence:** redacted project/route identifiers, credential class без значения, request/cost counters, preflight/run linkage, response class, expected-versus-actual result, side-effect assessment и approver decision.
- **Fail/stop:** 401/403/429, 5xx/503, timeout, unexpected content, cost/request cap, side effect, route drift или missing field → stop и `NOT PROVEN`/`BLOCKED`; при 503/5xx не делать retry.
- **Не является доказательством:** local synthetic provider, Doctor/local snapshot, route config, HTTP status без route/credential/counter evidence или один успешный запрос без side-effect assessment.

### Фаза 6 — rollback observation

- **Входной gate:** внешние действия завершены или остановлены; immutable snapshot и его hash доступны; rollback owner и approver назначены; process/network monitors ещё активны.
- **Безопасный наблюдаемый сценарий:** по решению rollback owner восстановить только из immutable snapshot, сверить integrity, остановить собственные процессы, проверить отсутствие residual egress и убедиться, что пользовательские homes и архивы не удалялись.
- **Ожидаемое evidence:** rollback decision, actor/approver, source snapshot hash, restored artifact hashes, process/egress post-check, side-effect assessment и final status.
- **Fail/stop:** snapshot mismatch, residual process/egress, повреждение или изменение user data, неполный restore → не удалять ничего, сохранить состояние для владельца отката и эскалировать; статус `NOT PROVEN`.
- **Не является доказательством:** удаление каталога, «rollback completed» без hash, восстановление из mutable copy или отсутствие наблюдения после restore.

## 4. Проверяемая evidence schema

Schema применяется к каждой фазе и к каждому claim. Значения заполняются только после наблюдения; placeholders и вымышленные значения не считаются evidence.

| Поле | Обязательное содержание и ограничение |
|---|---|
| `phase` | Одно из шести имён фаз M11; не произвольная строка. |
| `evidenceId` | Уникальный монотонный идентификатор записи; не переиспользовать после stop/fail. |
| `utcTimeWindow` | Явные `start`/`end` в UTC и признак, что наблюдение попало в authorized window. |
| `actor` / `approver` | Идентификаторы ролей/учётных записей в redacted форме; должна быть видна ответственность и approval. |
| `authorizationRef` | Ссылка на A1, A2, A3 или A4 и integrity-проверяемую append-only запись. |
| `projectIdRedacted` / `routeIdRedacted` | Безопасно редактированные project и route identifiers; raw URL, account, endpoint и user path не записывать. |
| `ompBinaryVersion` / `ompBinarySha256` | Версия и полный SHA-256 утверждённого бинарника; для фаз без запуска явно указывать отсутствие применимости, а не придумывать значение. |
| `environmentAttestation` | Идентификатор среды, policy revision и проверка владельца; без absolute user paths или секретных переменных. |
| `osIsolationAttestation` | Attestation OS/network isolation, allowlist и deny-by-default decision; отсутствие attestation не равно PASS. |
| `credentialClass` | Только класс (`none`, `scoped/ephemeral` или утверждённый эквивалент); значение credential никогда не записывать. |
| `requestCount` / `costCounter` | Наблюдаемые counters до/после и cap из authorization; unknown или пропуск → `NOT PROVEN`. |
| `preflightId` / `runId` | Redacted linkage между preflight, launch, resume и provider observation; raw transcript не хранить. |
| `nativeResumeLinkage` | Исходный state/run linkage, attempt count и integrity relation; для неприменимой фазы явно отмечать `not-applicable`. |
| `networkEgressObservation` | Разрешённый/неожиданный destination class, direction, counters и policy decision; без raw headers, cookies, tokens или packet payloads. |
| `expectedResult` / `actualResult` | Нормализованные allowlisted outcomes и их сравнение; сырой response/transcript не копировать. |
| `sideEffectAssessment` | Явное `none`, `observed` или `unknown` с owner decision; `unknown` не считается PASS. |
| `rollbackDecision` | `not-needed`, `initiated`, `completed` или `blocked` с actor/approver и причиной; отсутствие решения не скрывать. |
| `artifactLocations` | Только redacted relative/object references и retention class; абсолютные пользовательские пути запрещены. |
| `redactionPolicy` | Версия правила, подтверждающая отсутствие secrets/raw headers/cookies/tokens/transcripts/absolute user paths. |
| `integrityHash` | Hash canonicalized evidence record и referenced artifacts; mismatch делает запись `NOT PROVEN`. |
| `status` | `PASS`, `FAIL`, `NOT PROVEN` или `BLOCKED`; `PASS` допустим только при полном наборе полей и gate. |

### Правила хранения и классификации

- Evidence **append-only**: новые наблюдения и corrections добавляются новой записью с новым `evidenceId`; старую запись не перезаписывать и не удалять.
- Не записывать секреты, raw headers, cookies, tokens, transcripts, payloads или пользовательские absolute paths. Артефакты должны ссылаться на redacted relative/object location.
- Отсутствие обязательного authorization field даёт `BLOCKED`. Отсутствие обязательного evidence field, противоречивый результат или непроверяемый hash даёт `NOT PROVEN`; процесс останавливается до разбора владельцем.
- Local synthetic evidence M10-R2 нельзя повышать до evidence реального пилота: в schema оно может быть только `context`, никогда не `claim evidence`.
- `PASS` не наследуется между фазами и не переносится от одного route, binary, credential class или UTC window к другому.
- При 503/5xx внешняя операция не повторяется; фиксируются нормализованный stop outcome и counters, без сырого ответа.

### Минимальный набор evidence для четырёх внешних claims

| Внешний claim | Точный минимальный набор | Отрицательный/stop outcome |
|---|---|---|
| actual `omp.exe` | A1 approval; Phase 1 preflight; pinned `ompBinaryVersion` + `ompBinarySha256`; Phase 2 launch/run linkage; process result; environment and OS-isolation attestations; egress observation; side-effect assessment; integrity hashes. | Нет hash/version match, lifecycle, attestation или side-effect/egress observation → `BLOCKED`/`NOT PROVEN`; повтор запуска не делать без новой A1. |
| native resume | A2 approval; принятый Phase 2 run; immutable source state hash; `nativeResumeLinkage`; ровно наблюдаемый resume attempt; before/after hashes; duplicate-side-effect check; final result. | Нет linkage, state изменился, resume не native или side effect дублирован → stop, `NOT PROVEN`, rollback observation. |
| external egress/isolation | A3 approval; Phase 1 policy reference; environment + OS-isolation attestation; allowlist/deny-by-default decision; positive allowed-path observation; negative unexpected-egress observation; counters; teardown evidence. | Любой unexpected egress, bypass или отсутствие telemetry/attestation → немедленный stop, `BLOCKED`; к A4 не переходить. |
| живая provider route | A4 approval; принятые Phase 1–4; redacted project/route IDs; credential class; request/cost caps and counters; preflight/run linkage; expected vs actual result; provider response class; side-effect and rollback decision; integrity hashes. | 401/403/429/5xx/503/timeout, cap breach, route drift, unknown side effect или missing field → `NOT PROVEN`/`BLOCKED`; 503/5xx не повторять. |

## 5. Минимальный rollback / runbook

1. **До внешнего действия:** rollback owner фиксирует immutable snapshot (manifest, metadata и canonical integrity hash) в redacted relative/object location. Snapshot read-only; mutable working copy и snapshot нельзя смешивать. Проверить, что пользовательские homes и архивы не являются целью удаления.
2. **Перед стартом каждой фазы:** сверить snapshot hash, authorization window, binary hash, isolation attestation и zero/current counters. При любом mismatch — `BLOCKED`, запуск не начинать.
3. **Stop rule:** немедленно остановить собственный процесс/запрос при side effect, unexpected egress, route drift, credential exposure, cap breach, timeout, 401/403/429/5xx или неразрешённом child. При 503/5xx не делать retry.
4. **Решение об откате:** rollback owner принимает решение совместно с указанным approver; оператор не удаляет данные и не меняет production default самостоятельно. Решение и причина попадают в append-only evidence.
5. **Путь возврата:** остановить только собственные процессы, сохранить stop evidence, восстановить approved artifacts из immutable snapshot, проверить SHA-256/manifest и повторно снять process/egress observation. Пользовательские homes, архивы, legacy runtime и исходные transcripts не удалять.
6. **После rollback:** если hash или отсутствие side effect не подтверждены, статус остаётся `NOT PROVEN`; дальнейший пилот заблокирован до нового authorization record и review.

## 6. Явно исключено из M11

M11 не включает и не разрешает **cutover**, удаление legacy, commit, push, PR или изменение production default. Эти действия относятся к отдельной [главе 6 — STEP 7: cutover и удаление legacy](REMAINING_PLAN.md#глава-6-step-7--cutover-и-удаление-legacy) и не могут следовать из локального M10-R2 или из наличия этого плана. Главы 6–7 не начаты.

Также вне scope M11-P остаются запуск внешнего пилота, native resume, external network egress, OS isolation/ACL, live credentials/sessions/homes, paid requests и live provider route: они описаны как будущие gates, но в этой doc-only работе не выполнялись.

## 7. Текущий результат M11-P

- План, authorization gates, шесть последовательных фаз, evidence schema, per-claim minimum evidence, stop outcomes и rollback/runbook подготовлены.
- M10-R2 остаётся локально принятым только для главы 5; local synthetic evidence не повышена до внешнего evidence.
- Четыре внешние границы — actual `omp.exe`, native resume, external egress/isolation и живая provider route — остаются `NOT PROVEN`/`BLOCKED`.
- Никаких внешних действий, live credentials, paid requests, network/OS changes, cutover, commit, push или PR в рамках M11-P не было.
