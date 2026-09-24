# Step 4: офлайн-сопоставление реальных профилей OMP

Дата: **16 сентября 2026**. Ветка: `feat/omp-migration`.
**Это отчёт о конфигурации и локальных проверках, не разрешение запуска и не приёмка миграции.**

Повторная read-only проверка **17 сентября 2026** подтвердила: все 38
allowlisted source-файлов и все 18 profile fingerprints неизменны. Исторический
inventory сохранил момент обнаружения дрейфа `expected=17 / actual=18`; текущий
baseline для следующих проверок — **18**.

## Источники и расхождение с исходной оценкой

Изменения Step 1–3 сохранены; дальнейшие открытые задачи сведены в [единый план](omp-migration/REMAINING_PLAN.md).
В текущем `C:\Users\megaj\.provider-switcher\providers\providers.json` уже **18 включённых профилей**, а не 17:

- 10 `openai-chat-completions`;
- 7 `auto`;
- 1 `anthropic-messages`.

Текущее количество физических protected-secret JSON: **36**, а не 35.
Все профили включены в отчёт; дополнительный профиль не отброшен.
Предыдущий manifest содержит хеши, но не прежний список provider IDs: одного изменения количества недостаточно, чтобы утверждать, какой именно профиль добавлен.

Источник настроек: файл profiles, а не имя модели, бренд, адаптер, старый CLI home или предполагаемый кабинет.
SHA-256 текущего `providers.json`:

```text
81e0848877f2a2cf4af59b3a7f37c1e88e1c3d51cdc70013794c5256866fa09b
```

Локальные артефакты, исключённые из Git:

```text
.provider-dock/omp-mapping-2026-09-16-ExxykD/
  source-policy.json
  inventory.json
  verification.json
  health-summary.json
```

`source-policy.json` явно перечисляет **38 файлов**: profiles, повреждённые portals и 36 ciphertext-файлов.
`inventory.json` содержит manifest, SHA-256 каждого профиля, точные reportable base URLs, формы auth, только имена headers/query parameters, модельную provenance, результаты compiler trials и нерешённые вопросы.
Значения headers/query, secret references, ciphertext и plaintext ключей в assessment не включены.
Необычный непроверенный URL path скрывается (`baseUrl: null`, `ENDPOINT_REVIEW_REQUIRED`), а не переписывается; исходные bytes остаются в оригинале, профиль связан с SHA-256.

`verification.json` подтверждает повторной проверкой:
все 38 исходных файлов побайтно соответствуют inventory; allowlist ciphertext-файлов остаётся полным;
assessment после review-fixes не изменился на этих реальных данных.
Это **не quiescent backup** и не гарантия, что другие процессы не изменят файлы после проверки.

## Матрица всех профилей

Общие условия для каждой строки:

- статус **`pending`**;
- `accountId: null`, `approvedOrigins: []`, portal association **неизвестна, не выведена автоматически**;
- файл, соответствующий API secret reference, присутствует; ключ **не расшифровывался**, его работоспособность и принадлежность аккаунту не подтверждены;
- capabilities, соответствие реальному API endpoint, identity и реальные пилоты не приняты.

«2/2 local» означает два сценария с **поддельным upstream**: без tools и с настоящим локальным `read` → второй запрос.
Это не проверка удалённой модели, не подтверждение, что она поддерживает coding/tools, и не основание отключать неподдерживаемые возможности.

| Provider ID | Объявленный protocol / auth | Настроенный model ID | Локальный результат / отдельный блокер |
| --- | --- | --- | --- |
| `aeramc` | Chat / bearer | `claude-opus-5` | Compiler passed; 2/2 local |
| `agentrouter` | auto / bearer | Не задан | `PROTOCOL_UNRESOLVED`; `UNSUPPORTED_HEADERS` (`Originator`, `User-Agent`) |
| `agentrouter-2` | auto / bearer | Не задан | Те же два блокера; отдельный профиль, не объединён с первым |
| `agentrouter-3` | auto / bearer | Не задан | Те же два блокера; отдельный профиль, не объединён с первым |
| `b45b95fa18bf` | auto / bearer | Не задан | `PROTOCOL_UNRESOLVED`; root path не дополнен автоматически `/v1` |
| `beizhi` | Chat / bearer | `claude-opus-4-8` | Compiler passed; 2/2 local |
| `bluesminds` | Chat / bearer | Не задан | Transport shape passed; требуется явный model ID |
| `gorouter` | Chat / bearer | `claude-opus-5-thinking` | Compiler passed; 2/2 local |
| `hcnsec` | Chat / bearer | `auto` | Compiler passed; 2/2 local; literal model `auto` сохранён |
| `helyxai` | Chat / bearer | Не задан | Transport shape passed; требуется явный model ID |
| `justwoker` | Chat / bearer | `claude-opus-5-thinking` | Compiler passed; 2/2 local |
| `justwoker-2` | Messages / header `x-api-key` | Не задан | `UNSUPPORTED_AUTH` для этого стороннего origin |
| `orvapi` | auto / bearer | `gpt-6-astra` | `PROTOCOL_UNRESOLVED`; path `/api/chat` не заменён `/v1` |
| `seekai` | Chat / bearer | `gemini-3-6-flash` | Compiler passed; 2/2 local |
| `tabitoken` | Chat / bearer | `claude-opus-5-thinking` | Compiler passed; 2/2 local |
| `vsllm` | auto / bearer | Не задан | `PROTOCOL_UNRESOLVED` |
| `vyceai` | auto / bearer | Не задан | `PROTOCOL_UNRESOLVED` |
| `yjs` | Chat / bearer | `gpt-image-2` | Compiler passed; 2/2 local; пригодность реальной модели для coding не доказана |

У `auto` compiler trials по трём протоколам — **контрфактическая проверка представимости транспорта**, не выбор протокола. Эти trials не возвращают launch config и не сохраняют `protocolMappings`.
Доступность provider/model проверяется отдельно: отключённые исходные маршруты не становятся разрешёнными от успеха транспортного trial.
Профили с одним origin или одинаковой моделью не объединяются. Auth не менялся: `x-api-key` не заменялся bearer, static headers не удалялись ради «совместимости».
Azure Chat, query auth и произвольные raw-header routes остаются отклонёнными текущим compiler; Responses `namespace` не переводится в Chat.

## Что дают остальные локальные данные

`accounts.json` по-прежнему содержит **280047 NUL bytes**, SHA-256:

```text
88894e28ee6b8da1255d95b5cd2ada7e2729eae5d6fa90a6a3179f4d0f686e43
```

Он читался через inventory helper, **не через side-effecting portal repository**. Новые corruption backups не создавались, recovery не выполнялся.
Наличие API-key файла не доказывает portal origin/account association. Другие ciphertext-файлы не объявляются неиспользуемыми.

В read-only `health/history.json` есть cache-наблюдения по 18 профилям, но **нет ни одной surface check с configuration fingerprint**.
`latest.models` и legacy runtime signals не заменяют подтверждение текущей связки endpoint/auth/account/protocol. Их данные не использованы для автоматического mapping, выбора модели или разрешения пилота.
Инвентаризация старых сессий не обновлялась.

## Реальная локальная проверка OMP

Harness: `scripts/omp-provider-local-smoke.mjs`.
Проверены **16/16 сценариев для восьми явно настроенных моделей** на точном `omp.exe` из handoff.
Остальные **10 профилей явно перечислены как skipped**, а не прошедшие:
7 unresolved auto, 1 unsupported auth, 2 без выбранной модели.

Артефакт:

```text
F:\ProviderDockBuild\omp-0c6c981ee583\provider-local-smoke-rdZIeN\report.json
```

Проверки: точный literal model ID, `/v1/chat/completions`, bearer только с fixture key, отсутствие `x-api-key`, tools строго отсутствуют либо только `read`, фактическое содержимое прочитанного файла во втором запросе, exit 0.
Во всех 16 случаях `keyInOutput: false`, `keyOnDisk: false`.
Raw stdout/stderr, env и RPC frames не сохранялись и не выводились.
Все managed homes/native assets этой проверки находятся на **F:**.
Реальные provider origins и настоящие secret references не передавались дочернему процессу.

Повторить только локальную проверку:

```powershell
npm run build
node scripts/omp-provider-local-smoke.mjs `
  --inventory "$PWD\.provider-dock\omp-mapping-2026-09-16-ExxykD\inventory.json" `
  --executable "$PWD\.provider-dock\tools\omp-0c6c981ee583\omp.exe" `
  --output-root "F:\ProviderDockBuild\omp-0c6c981ee583"
```

Перед использованием сохранённого inventory для дальнейших решений повторно вызвать
`inventoryOmpProviderMappings(sourcePolicy, { expectedProviderCount: 18 })` и сравнить manifest/profile fingerprints.
Изменившиеся bytes требуют нового assessment; старый успешный smoke не подтверждает новую конфигурацию.

## Реализация и проверки

- `src/migration/omp-provider-mapping.ts`: pure offline assessment, без vault/network/launch; отсутствующие или нормализуемые critical fields отклоняются.
- `src/migration/omp-provider-inventory.ts`: allowlist inventory → verified metadata read → assessment → повторная проверка bytes; секреты не разбираются.
- `tests/omp-provider-mapping.test.ts`: 22 теста, включая пять red→green review-regressions.
- `tests/omp-provider-inventory.test.ts`: 5 тестов, включая read-only NUL metadata/ciphertext и отсутствие auth defaults.
- Полный `npm test`: **88 файлов / 868 тестов passed**.
- `npm run typecheck`, `npm run build`: passed.
- `node scripts/dashboard-ui-smoke.mjs`, `git diff --check`: passed (Git предупреждает о CRLF normalization в ранее изменённых файлах).

## Решения, без которых нельзя принимать реальные маршруты

Для каждого принимаемого маршрута нужны:

1. Точный `providerId` и fingerprint текущего профиля.
2. Явно выбранный **несекретный account ID**. Не использовать API key, секретную ссылку или предполагаемый portal login как identity.
3. Подтверждённые **точные origin и base path** из исходного профиля, а не автоматический allowlist из его URL.
4. Точный model ID и protocol; для семи `auto` — явное сопоставление на уровне модели с подтверждающим источником. Модель/бренд сами по себе не источник.
5. Подтверждение нужных model capabilities. Особенно отдельно подтвердить назначение `gpt-image-2` и семантику literal `auto`, не угадывая по названиям.
6. Для четырёх transport-blocked профилей — решение: сохранять pending до отдельно спроектированного literal-safe транспорта либо **явно принять** неподдерживаемость. Сейчас такого принятия нет.
7. Отдельное разрешение на конкретный реальный пилот и возможную стоимость. Принятие inventory/identity не разрешает inference.

Portal associations можно оставить неизвестными до provenance-aware recovery; они не выдумываются для запуска OMP.
**Ни одного `migrated-and-tested` или `explicitly-unsupported-user-accepted` пока нет.**
Step 4 не принят для реальных маршрутов. Step 5–7, legacy deletion и cutover не выполнялись.

## Recovery re-review 17 сентября

Локальный re-review зафиксирован в:

```text
.superpowers/sdd/2026-09-14-omp-migration-ru/task-step4-provider-mapping-rereview1.md
```

Assessment/inventory fixes приняты в их офлайн-границах, но обнаружены два
обязательных следующих барьера:

1. Сохранённый smoke-report пока не имеет строгого consumer/verifier, поэтому
   восемь доказанных fixture-пар всё ещё формально содержат
   `LOCAL_PROFILE_SMOKE_REQUIRED`.
2. `OmpLaunchService` сейчас выводит `allowedOrigins` из `profile.baseUrl` и не
   проверяет fingerprint-bound решение Step 4. До исправления pending-профиль не
   считается принятым маршрутом даже если runtime preflight технически проходит.

Следующий безопасный срез — строгая сверка smoke evidence, явный несекретный
route-decision contract и fail-closed проверка этого решения до credential
resolution/launch. Это не разрешает реальный pilot и не меняет текущие статусы.


## September 18, 2026 implementation checkpoint

The assessment boundary is unchanged: this document is not launch authorization and does not accept a real provider route.

- The saved loopback report is now consumed by a strict reconciler in `src/migration/omp-provider-evidence.ts`. It verifies the inventory hash, pinned executable hash, source commit, profile fingerprints, exact configured model IDs, both smoke categories, complete profile accounting, and the absence of leak/failure flags. It can remove only `LOCAL_PROFILE_SMOKE_REQUIRED`; it cannot promote a row beyond `pending`.
- `src/migration/omp-route-decisions.ts` provides a separate, non-secret, fingerprint-bound decision contract. `OmpLaunchService` now requires an exact decision for provider/account/model and rejects missing, stale, or artifact-drifted decisions before runtime or credentials. No acceptance decision was created from the local report.
- The `inventorySha256` and `smokeReportSha256` values carried by a decision are provenance links, not independent authority. Before any future decision is authored, the referenced inventory and report must be re-read and verified against an authoritative snapshot; no guessed values are acceptable.
- The current status is still **18 pending / 0 migrated-and-tested / 0 explicitly-unsupported-user-accepted**. No real-provider request, paid inference, secret decryption, portal recovery, session import, user-home mutation, or cutover occurred.
- Fresh September 18 verification: `npm test` **91 files / 893 tests passed**, typecheck/build passed, dashboard UI smoke passed sequentially, and `git diff --check` exited 0.

## September 19, 2026 authoritative revalidation

- The explicit source allowlist was re-read with `expectedProviderCount: 18`: **18 enabled profiles / 36 protected-secret files / 38 allowlisted files**, `drift=false`. The saved manifest entries and all profile fingerprints are unchanged.
- A fresh sanitized inventory with `expected=18` was written at `.provider-dock/omp-mapping-2026-09-16-ExxykD/inventory-2026-09-19.json`; the pinned-binary loopback smoke was then rerun at `F:\ProviderDockBuild\omp-0c6c981ee583\provider-local-smoke-l1bsQB\report.json`: **16/16** cases passed for eight exact provider/model pairs; ten profiles were explicitly skipped; all profiles were accounted for; no fixture key appeared in output or managed homes.
- Verified current hashes are inventory `213c530644d2d67cb4def7039eb45ffff094529577f4958457108adfc39f7416`, report `eeff171d0178241d91768ee9d85b78c4ef60f7b60df674cb6a0ee9ee954a8e05`, executable `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`, and source commit `0c6c981ee5838d97700180383077eb0a3790637c`.
- A separately verified non-secret snapshot with `launchAuthorized: false` is retained only in the ignored evidence workspace at `.provider-dock/omp-mapping-2026-09-16-ExxykD/omp-provider-evidence-2026-09-19-current.json`; it is not the live ProviderDock evidence source. No route-decision file was created.
- This remains loopback wire-shape evidence, not remote compatibility, account/origin ownership, model capability proof, real-provider acceptance, or cutover. All 18 profiles remain `pending`.

## September 19, 2026 verification follow-up

- The complete local matrix was rerun from the current working tree:
  `npm test` **91 files / 898 tests passed**, typecheck, build, sequential
  dashboard UI smoke, and `git diff --check` all passed. Detailed logs are in
  `.scratch/verification-2026-09-19-current/`.
- A non-authoritative decision worksheet is available at
  `.provider-dock/omp-mapping-2026-09-16-ExxykD/route-decision-input-2026-09-19.md`.
  It is deliberately outside the live migration directory and contains no
  credentials or acceptance decisions.
- The worksheet is only a request for explicit user-supplied account,
  origin/base-path, model/protocol, capability, transport-disposition and
  pilot-approval values. It does not change the authoritative status:
  **18 pending / 0 migrated-and-tested / 0 explicitly-unsupported-user-accepted**.

## September 19, 2026 serialized-evidence hardening

- `src/migration/omp-provider-evidence.ts` now exposes
  `reconcileSerializedOmpProviderLocalSmokeEvidence()`. The helper computes
  the inventory SHA-256 from the exact serialized inventory bytes before
  reconciling the smoke report, rather than trusting a caller-supplied hash.
- The current retained snapshot was rebuilt through this seam and matched
  semantically: 18 providers, eight exact local-smoke model claims,
  `launchAuthorized: false`.
- Verification after the change: focused evidence tests **9/9**, full suite
  **91 files / 899 tests**, typecheck, build, and `git diff --check` passed.
  This is provenance hardening only; all real-route acceptance gates remain
  open.

## September 19, 2026 compiler transport gate

- `OmpLaunchService.selection()` now re-runs the pinned pure compiler against
  the exact fingerprint-bound decision before returning a runtime selection.
  A decision cannot override `UNSUPPORTED_HEADERS`, `UNSUPPORTED_AUTH`,
  `UNSUPPORTED_QUERY`, or another compiler rejection.
- The regression covers an `auto` profile with unsupported static-header
  transport and fails with `OMP_ROUTE_NOT_ACCEPTED` before runtime
  preflight/credential resolution.
- Verification: focused launch/evidence tests **22/22**, full suite
  **91 files / 900 tests**, typecheck, build, sequential dashboard smoke, and
  `git diff --check` passed. Profile statuses remain unchanged.

## September 23, 2026 — first protocol-bound pilot route

VSLLM is now the first separately accepted **pilot** route; this does not
promote the other profiles and is not OMP-only cutover.

- Explicit non-secret route: account `16568`, base URL
  `https://vsllm.cc/v1`, origin `https://vsllm.cc`, model
  `glm-5.2-free`, protocol `openai-responses`.
- The approved four-call Doctor level-3 run passed text, streaming, tool call,
  and tool-result continuation. Its safe timestamp is
  `2026-09-22T20:44:45.061Z`; untested capabilities remain unclaimed.
- Local evidence is now protocol-bound. The current pinned-binary smoke passed
  **18/18** loopback cases, including the exact VSLLM Responses pair with and
  without the read tool; fixture-key output/disk checks are false.
- A new verified inventory and smoke report are bound by hashes
  `eab00c96bacca04eb252568eddae22bac4f25c7495f69faa45f95952e583e9ca`
  and `d9477c91c111269fac28c19e5d2b2006beff138c15a8afe9e4563eb3454085a3`.
- The live read-only sources now contain one decision and its matching evidence.
  Production preflight passes for this route. No OMP child or further remote
  inference was started while publishing it.

The assessment rows intentionally remain `pending`: acceptance lives in the
separate fingerprint-bound decision document. Current operational count is one
route accepted for a bounded pilot and 17 providers without an accepted live
route. The next external-spend boundary is the actual OMP one-shot pilot.

Fresh verification for this slice: **89 test files / 937 tests**, typecheck,
build, sequential dashboard smoke, provider-smoke syntax check and
`git diff --check` all pass. The tests remain in the existing evidence,
route-decision, launch-service and smoke-policy domain suites.

## September 23, 2026 — post-review v2 safety gate

Independent review found that the first decision trusted its own Doctor and
capability claims and that the Responses fixture accepted a Chat-shaped first
request. The current implementation requires a separate persisted Doctor
snapshot whose configuration fingerprint includes the active credential
reference. The decision binds that snapshot's digest; launch checks its
provider, model, protocol, timestamp, level-3 PASS and supported
text/streaming/tools against the current profile. Account `16568` remains the
user's explicit OMP namespace choice; Doctor does not claim to discover it.

Evidence and decision schemas are now version 2. Live version-1 files have
not been replaced or deleted and fail closed with the safe upgrade diagnostic.
The Responses fixture now checks streaming input, flat function tools and the
structured tool result, and rejects cross-protocol request shapes. Reconciled
assessment rows reject duplicate model and protocol entries.

The pinned binary passed the stricter loopback matrix **18/18** in
`F:\ProviderDockBuild\omp-0c6c981ee583\provider-local-smoke-lBASzf\report.json`;
VSLLM's exact Responses no-tool/tool pair passed. Report SHA-256:
`b77c9cc0c7221282e22c4c1e006d319d333482935ffef432eb2434c2f4a27055`.
Version-2 evidence is staged only at
`.provider-dock/omp-mapping-2026-09-16-ExxykD/omp-provider-evidence-v2-2026-09-23.json`
with SHA-256
`fd15eaf42031c037e66cef4bcf09f819e1a35139925fdc326c4523b3ddbbb1f3`.
The old Doctor snapshot lacks the new configuration fingerprint, so a fresh
Doctor level-3 run is required before authoring/publishing a v2 decision.
No new real-provider request or OMP process launch occurred in this review fix.

## September 23, 2026 — stricter acceptance checks and renewed VSLLM result

Follow-up review found that Doctor could pass an empty terminal stream and the
Responses fixture could pass a tool result without its call context. Doctor now
requires a non-empty text delta, and the fixture requires the matching prior
function call or `previous_response_id`. Replacing or removing a referenced
secret through ProviderDock invalidates its stored model diagnostics before
the vault mutation. No new test files were added.

The pinned OMP binary passed the new local matrix **18/18** with nine profiles
skipped. Report: `F:\ProviderDockBuild\omp-0c6c981ee583\provider-local-smoke-OPNZ5d\report.json`,
SHA-256 `3825869a563f6fec46b21d1d920df7e0df8f4a0f8205d3f59961868475c90eb0`.
The corresponding version-2 evidence was created exclusively at
`.provider-dock/omp-mapping-2026-09-16-ExxykD/omp-provider-evidence-v2-strict-2026-09-23.json`,
SHA-256 `be0c760151baddab3df2f25a7df70df9bbd459a1a6e0bdf546b17954137670c7`.

The user-authorized live Doctor series did **not** establish a new L3 PASS:
`glm-5.2-free` returned `Throttling.AllocationQuota` on minimal inference;
`glm-5.3-flash` and `glm-4.7-flash` returned `convert_request_failed` on the
Responses route; `deepseek-flash` also failed its L1 text check. Those models
were tested only as diagnostics; the live VSLLM profile still selects
`glm-5.2-free`. No version-2 route decision was published, live version-1
evidence/decision files remain untouched, and no OMP process was launched.

### Final local safety verification after credential-generation binding

The route gate now requires a Doctor snapshot bound to the current generation
of every referenced encrypted secret. The runtime rechecks that generation
immediately before and after resolving the child credential, so an in-flight
replacement under the same reference cannot silently authorize a different
key. New vault writes receive a random generation ID; legacy encrypted entries
use a hash of their DPAPI-protected blob. No plaintext or raw key hash is
persisted. New revisions bind both generation and protected bytes. Stores
without a revision fail pilot acceptance closed. The runtime
also rechecks the current profile fingerprint so activating a different
credential reference after route selection rejects the stale selection. Both
explicit activation and add-and-activate clear the old Doctor display snapshot.

The final pinned-binary loopback matrix passed **18/18**, nine profiles
skipped, with VSLLM Responses no-tool/tool cases both passed and no fixture-key
leak. Report: `F:\ProviderDockBuild\omp-0c6c981ee583\provider-local-smoke-hS0Mf6\report.json`,
SHA-256 `280871b41686a54bd9cfcb53ae73b9ee9b02a6b9132f3b43c6184bf641c15193`.
The final exclusively staged v2 evidence is
`.provider-dock/omp-mapping-2026-09-16-ExxykD/omp-provider-evidence-v2-final-2026-09-23.json`,
SHA-256 `1718d8d9a23433b8ac4cb4a0173549affe9041f3b2ecf815f678bf2146265256`.
Current production preflight still returns `OMP_MIGRATION_EVIDENCE_V2_REQUIRED`;
the live version-1 files have not been overwritten. No real OMP process was
launched. New live Doctor evidence is still required after the upstream quota
or transport issue is resolved.

## September 23, 2026 — authorized VSLLM retry

A new `glm-5.2-free` Doctor L3 run on `openai-responses` passed discovery,
minimal text and streaming, but the synthetic tool round trip was `DEGRADED`.
The current GLM pilot route therefore remains unaccepted under the v2 gate. One authorized
fallback, `gpt-5.4-mini`, passed all four L3 checks on the same protocol.
This is model-specific evidence only: the live profile still selects
`glm-5.2-free`, and no route decision, v2 evidence publication, or OMP process
launch was performed. Switching the pilot model requires a separate explicit
route choice and model-bound local smoke/evidence plus preflight.
