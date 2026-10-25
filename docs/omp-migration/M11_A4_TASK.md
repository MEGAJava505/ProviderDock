# M11 — задание A4: живая provider route (25 октября 2026)

Исполнитель — владелец на Windows, elevated PowerShell. Координатор команд не выполняет.

Состояние: **A1 PASS** (пакет 000242–000255, manifest 168/168, `b3ebf80`). **A4 BLOCKED.** M11 не завершён.
Задание покрывает только A4; Phase 6 (rollback) и финальный статус — отдельным шагом после приёмки A4.

## 1. Решения владельца (заполнить до запуска)

| Поле | Что указать | Пример формата |
|---|---|---|
| `routeIdRedacted` | alias маршрута, не сырой ID | `route:<provider>/<alias>` |
| `credentialClass` | scoped/ephemeral, TTL | `ephemeral-scoped`, TTL ≤ окна |
| `selectedModel` | точный model ID/revision, без `auto` | `<model-id>@<revision>` |
| `costLimit` | число + валюта | `2.00 USD` |
| `requestLimit` | конечное число | `3` |
| `maxInputTokens` / `maxOutputTokens` | числа | `512` / `128` |
| `timeoutSeconds` | ≤ окна | `60` |
| `utcTimeWindow` | будущее короткое окно | `2026-10-26T10:00Z–10:15Z` |
| `responsible` / `approver` | кто выполняет / кто утверждает | — |
| `revocationOwner` | кто отзывает credential у issuer | — |
| `stopCriterion` | список из §6 | — |

Значения не выдумываются. Если хотя бы одно поле пустое — A4 `BLOCKED`.

## 2. Предусловие: DPAPI

A4 использует штатный `DpapiFileSecretVault`/`WindowsDpapiProtector`, поэтому сначала:

```powershell
npx vitest run tests/dpapi-secret-vault.test.ts
```

- **PASS** → продолжать.
- **FAIL** → A4 не запускать. Зафиксировать `dpapi-test-result-000259.json` с выводом, причиной и решением: либо фикс, либо явное признание известным дефектом **и** подтверждение, что vault работает на этом хосте (например, round-trip put/get/delete с тестовым нечувствительным значением вне репозитория).

Без подтверждённого DPAPI credential нельзя хранить — A4 остаётся `BLOCKED`.

## 3. Credential: выпуск и хранение

1. Выпустить у провайдера **отдельный** краткоживущий ключ: только нужный scope, только выбранная модель/route, TTL не позже конца окна, без admin-прав.
2. Ввести скрыто и передать только через process-scoped env:

```powershell
$sec = Read-Host -AsSecureString "Pilot credential"
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:PD_PILOT_SECRET = ***
  providerdock secrets set <LOCAL_SECRET_REFERENCE> --from-env PD_PILOT_SECRET
} finally {
  Remove-Item Env:PD_PILOT_SECRET -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable sec, ptr -ErrorAction SilentlyContinue
}
```

Запрещено: `setx`, user/machine env, plaintext-файл, ключ в аргументах команды, transcript/debug dump, вывод значения на экран.

3. Проверить наличие записи без печати значения (список/маска).
4. Привязать `<LOCAL_SECRET_REFERENCE>` только к профилю `m11-pilot`.

## 4. Fresh environment и policy

- Новый AppContainer/profile, deny-by-default.
- Allowlist ровно для одного route/model и одного loopback/inert контрольного пути.
- Attestation: token/capabilities, Job binding, HOME/TEMP/cwd isolation, отсутствие унаследованных credentials.
- Никаких production defaults и чужих профилей.

## 5. Preflight

- `Get-FileHash -Algorithm SHA256` для pinned `omp.exe` (18.0.4, `1944c6e2…`) — без исполнения.
- Проверить, что `selectedModel` совпадает в authorization, route binding и runtime selection.
- Проверить, что caps применяются **до** dispatch (лимит запросов/стоимости), а не постфактум.
- Зафиксировать UTC-окно и готовность монитора/логов.

## 6. Один живой запрос

- Один запрос, `retries=0`, минимальный prompt, `maxOutputTokens` в пределах cap.
- Снять: request class/status, latency, model/route, usage tokens, cost delta, side effects, allow/deny наблюдения.
- Никакого fallback на другую модель/route.

### Stop-правила

`401/403/429`, любой `5xx`, timeout, превышение cost/request cap, drift model/route, unexpected egress, child вне declared, side effect вне ожидаемого, ошибка DPAPI/vault → **STOP**: `BLOCKED`/`NOT PROVEN`, без повторов, credential отозвать.

## 7. Teardown и отзыв

1. Остановить свои процессы, выключить pilot/autohealth.
2. **Отозвать credential у issuer** и сохранить подтверждение с UTC и redacted reference.
3. Удалить локальную запись vault **после** проверки bindings; локальное удаление ≠ отзыв.
4. Проверить orphan=0, residual egress=0, профиль удалён.

## 8. Аудит логов и redaction

Проверить: application/controller/gateway logs, shell history, temp/config/crash artifacts, staged diff; у issuer — usage/revocation audit за окно и после.

- Сопоставить route/model/request/cost counters, исключить лишних потребителей.
- Поиск по полному значению credential — только локально, без значения в аргументах и без печати совпадений.
- В evidence: источники, UTC-границы, число совпадений, недоступные источники, revocation confirmation, residual checks.
- Повторить redaction-скан всех новых файлов.

## 9. Evidence-контракт (append-only, старт с 000256)

| ID | Файл | Содержимое |
|---|---|---|
| 000256 | `authorization-a4-000256.json` | все поля §1, окно, роли, caps, stop rules, integrityHash |
| 000257 | `credential-binding-000257.json` | credential class, redacted ref, expiry, vault mechanism, факт привязки к профилю |
| 000258 | `model-route-binding-000258.json` | selectedModel, route alias, источник каталога/тарифа, дата проверки |
| 000259 | `dpapi-test-result-000259.json` | результат теста, round-trip vault, решение |
| 000260 | `preflight-a4-000260.json` | binary hash, VersionInfo, attestation, policy, caps readiness |
| 000261 | `provider-request-000261.json` | один запрос: класс ответа, latency, model/route, usage |
| 000262 | `counters-cost-000262.json` | before/after requests/cost, delta, лимиты |
| 000263 | `side-effects-000263.json` | ожидаемые/фактические эффекты, границы |
| 000264 | `teardown-a4-000264.json` | процессы, профиль, orphan, residual egress |
| 000265 | `revocation-confirmation-000265.json` | UTC, redacted ref, issuer confirmation |
| 000266 | `log-audit-000266.json` | источники, границы, совпадения, недоступное |
| 000267 | `summary-a4-000267.json` | PASS/BLOCKED, причина, ссылки |
| 000268 | `integrity-hashes-a4-000268.txt` | SHA-256 всех файлов A4 |

Каждый JSON — с внутренним `integrityHash` (canonicalization как в принятых пакетах).

## 10. Критерии приёмки A4

1. DPAPI подтверждён (тест PASS или явное решение + round-trip).
2. Credential scoped/ephemeral, TTL в окне, хранится в vault вне репозитория, не светится в argv/logs.
3. Fresh isolation attestation и deny-by-default; allowlist ровно один route.
4. Preflight: pin совпал, модель/route совпадают во всех трёх местах, caps применяются до dispatch.
5. Один запрос выполнен, response получен, counters в пределах caps.
6. Нет unexpected egress/children/side effects.
7. Credential отозван у issuer, подтверждение с UTC; локальная запись удалена после проверки.
8. Логи и redaction проверены; манифест покрывает все файлы.

## 11. После A4

- Приёмка A4 → Phase 6: immutable snapshot, восстановление, residual=0, финальный `m11-final-status`.
- Cutover и удаление legacy — вне M11 (глава 6 REMAINING_PLAN), отдельное решение.

## 12. Чек-лист

- [ ] Все поля §1 заполнены
- [ ] DPAPI-тест PASS или решение + round-trip
- [ ] Credential выпущен, введён скрыто, в vault вне repo
- [ ] Fresh AppContainer/profile, deny-by-default, allowlist один route
- [ ] Preflight: pin, модель, route, caps
- [ ] Один запрос, retries=0
- [ ] Counters и side effects сняты
- [ ] Teardown, orphan=0, residual egress=0
- [ ] Credential отозван у issuer
- [ ] Логи и redaction проверены
- [ ] Evidence 000256–000268 + манифест
- [ ] Push + hash коммита и SHA-256 манифеста
