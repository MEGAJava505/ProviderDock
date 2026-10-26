# M11 — финальное задание владельцу (26 октября 2026)

> **ЧЕРНОВИК КООРДИНАТОРА.** Документ собран координатором, потому что Astra и Claude были недоступны. По требованию владельца финальную версию должен выдать оркестратор (Astra или Claude); до этого документ не считается согласованным. Статус финализации — в `OWNER_QUEUE.md`.

Единый документ: всё, что осталось сделать на Windows. Серверная часть закрыта.
Исполнитель — владелец в elevated PowerShell. Координатор команд не выполняет.

## 1. Статус и границы

| Фаза | Статус | Доказательство |
|---|---|---|
| Phase 0 | PASS | локальные gates, snapshot |
| A1 | PASS | `initialize` + `session/new`, 17/17 checks, manifest 168/168 |
| A2 | PASS (наблюдение) | idle resume, linkage, before/after hashes |
| A3 | PASS (наблюдение) | изоляция, allow/deny, egress counters |
| A4 | **BLOCKED — этот документ** | нужен один живой запрос и отзыв ключа |
| Phase 6 | pending-A4 | этот документ, часть 3 |
| Cutover | вне scope | отдельное решение, глава 6 REMAINING_PLAN |

Правило бюджета: **один живой запрос** на A4, `retries=0`. Evidence только append-only: следующие свободные ID — `000256` (A4) и `000269` (Phase 6); существующие файлы не перезаписывать.

## 2. Предусловие: DPAPI

```powershell
cd $repo
npx vitest run tests/dpapi-secret-vault.test.ts
```

- PASS → продолжать.
- FAIL → A4 не запускать. Записать в `dpapi-test-result-000259.json` вывод и решение: либо фикс, либо явное признание дефекта плюс round-trip vault:

```powershell
providerdock secrets set m11-dpapi-selftest --from-env PD_SELFTEST_VALUE
providerdock secrets list --json
providerdock secrets remove m11-dpapi-selftest
```

Без подтверждённого vault A4 остаётся `BLOCKED`.

## 3. Решения владельца (заполнить до запуска)

| Поле | Значение |
|---|---|
| route alias (redacted) | вписать alias, не сырой ID |
| provider id для `doctor` | вписать id, который видит CLI |
| selectedModel | точный model ID без `auto` |
| credential class / TTL | scoped, ephemeral, TTL ≤ окна |
| costLimit | число и валюта |
| requestLimit | конечное число, не больше 3 |
| maxInputTokens / maxOutputTokens | числа |
| timeoutSeconds | не больше окна |
| UTC-окно start / end | будущее короткое окно |
| responsible / approver | кто выполняет / кто утверждает |
| revocationOwner | кто отзывает ключ у провайдера |
| stopCriterion | см. §6 |

Пустое поле → A4 `BLOCKED`.

## 4. Переменные сессии

```powershell
$repo  = "C:\path\to\ProviderDock"
$owned = Join-Path $env:USERPROFILE "m11-pilot"
$logs  = Join-Path $owned "logs"
$dumps = Join-Path $owned "dumps"
$etw   = Join-Path $owned "etw"
$omp   = "C:\path\to\omp.exe"
$ref   = "m11-pilot-route"
$model = "MODEL_ID"
$route = "PROVIDER_ID"
$runId = "M11-A4-" + (Get-Date -Format "yyyyMMdd-HHmmss")

New-Item -ItemType Directory -Force -Path $owned, $logs, $dumps, $etw | Out-Null
```

Заменить значения на фактические. Пути и ID не должны попадать в публикуемый evidence в сыром виде — только alias.

## 5. A4 — живой запрос

### 5.1 Preflight

```powershell
(Get-FileHash -Algorithm SHA256 $omp).Hash
(Get-Item $omp).VersionInfo | Select-Object FileVersion, ProductVersion
providerdock health show $route --json
```

Ожидание: hash `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`, версия 18.0.4. Несовпадение → STOP.

### 5.2 Credential

Выпустить у провайдера отдельный краткоживущий ключ: только этот маршрут и модель, TTL не позже конца окна, без admin-прав. Ввести скрыто:

```powershell
$sec = Read-Host -AsSecureString "Pilot credential"
$ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
try {
  $env:PD_PILOT_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  providerdock secrets set $ref --from-env PD_PILOT_SECRET
} finally {
  Remove-Item Env:PD_PILOT_SECRET -ErrorAction SilentlyContinue
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  Remove-Variable sec, ptr -ErrorAction SilentlyContinue
}
providerdock secrets list --json
```

Запрещено: `setx`, user/machine env, plaintext-файл, ключ в аргументах, transcript или debug dump.

### 5.3 Живой запрос

```powershell
$cli = (Get-Command providerdock).Source
$outFile = Join-Path $logs "doctor-out-$runId.txt"
$errFile = Join-Path $logs "doctor-err-$runId.txt"
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$p = Start-Process -FilePath $cli -ArgumentList @("doctor", $route, "--model", $model, "--level", "3", "--json") -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru -Wait -NoNewWindow
$sw.Stop()
$p.ExitCode
$sw.Elapsed.TotalSeconds
```

Один запуск. `retries=0`. Никакого fallback на другую модель или маршрут. Считать `attempted`, `allowed`, `denied`, usage tokens и стоимость.

### 5.4 Teardown и отзыв

```powershell
Get-Process | Where-Object { $_.ProcessName -like "*omp*" } | Select-Object Id, ProcessName
providerdock secrets remove $ref
providerdock secrets list --json
```

Отозвать ключ у провайдера и сохранить подтверждение с UTC и redacted reference. Локальное удаление не заменяет отзыв.

### 5.5 Аудит

Проверить логи приложения, историю shell, temp/crash artifacts, staged diff; у провайдера — usage/revocation audit за окно. Поиск по значению ключа — только локально, без печати совпадений. Повторить redaction-скан новых файлов.

### 5.6 Evidence A4

| ID | Файл | Обязательные поля |
|---|---|---|
| 000256 | `authorization-a4-000256.json` | phase, окно, роли, caps, stopCriterion, integrityHash |
| 000257 | `credential-binding-000257.json` | class, redacted ref, expiry, vault mechanism |
| 000258 | `model-route-binding-000258.json` | selectedModel, route alias, источник тарифа |
| 000259 | `dpapi-test-result-000259.json` | результат теста, round-trip, решение |
| 000260 | `preflight-a4-000260.json` | hash, версия, health, policy |
| 000261 | `provider-request-000261.json` | класс ответа, latency, usage, model/route |
| 000262 | `counters-cost-000262.json` | before/after requests и cost, delta, лимиты |
| 000263 | `side-effects-000263.json` | ожидаемые и фактические эффекты |
| 000264 | `teardown-a4-000264.json` | процессы, профиль, orphan, residual egress |
| 000265 | `revocation-confirmation-000265.json` | UTC, redacted ref, подтверждение провайдера |
| 000266 | `log-audit-000266.json` | источники, границы, совпадения, недоступное |
| 000267 | `summary-a4-000267.json` | PASS или BLOCKED, причина, ссылки |
| 000268 | `integrity-hashes-a4-000268.txt` | SHA-256 всех файлов A4 |

## 6. Stop-правила A4

`401`, `403`, `429`, любой `5xx`, timeout, превышение cost или request cap, drift модели или маршрута, unexpected egress, дочерний процесс вне объявленных, side effect вне ожидаемого, ошибка DPAPI — STOP. Записать `BLOCKED` или `NOT PROVEN`, ключ отозвать, повторов не делать.

## 7. Phase 6 — rollback и закрытие

Начинать только после приёмки A4.

### 7.1 Snapshot

```powershell
$snap = Join-Path $owned "snapshots"
New-Item -ItemType Directory -Force -Path $snap | Out-Null
git bundle create (Join-Path $snap "m11-omp-integration.bundle") omp-integration
Get-FileHash -Algorithm SHA256 (Join-Path $snap "m11-omp-integration.bundle")
if (Test-Path ".provider-dock") { Copy-Item ".provider-dock" (Join-Path $snap "provider-dock") -Recurse -Force }
Get-FileHash -Algorithm SHA256 $omp
```

### 7.2 Восстановление и сверка

```powershell
$restore = Join-Path $owned "restore"
git clone (Join-Path $snap "m11-omp-integration.bundle") $restore
git -C $restore fsck
git -C $restore log --oneline -1
```

Ожидание: `fsck` без ошибок, HEAD совпадает с bundle, state и binary хеши равны snapshot.

### 7.3 Residual

```powershell
Get-Process | Where-Object { $_.ProcessName -like "*omp*" }
providerdock secrets list --json
```

Ожидание: 0 своих процессов, 0 orphan, 0 residual egress, ключ отсутствует, профиль выключен.

### 7.4 Evidence Phase 6

| ID | Файл |
|---|---|
| 000269 | `authorization-rollback-000269.json` |
| 000270 | `snapshot-manifest-000270.json` |
| 000271 | `restore-verification-000271.json` |
| 000272 | `residual-check-000272.json` |
| 000273 | `log-audit-rollback-000273.json` |
| 000274 | `summary-rollback-000274.json` |
| 000275 | `integrity-hashes-rollback-000275.txt` |
| 000276 | `m11-final-status-000276.json` |

`m11-final-status` содержит таблицу фаз с PASS или BLOCKED и ссылками; необъяснённых `BLOCKED` быть не должно.

## 8. Критерии приёмки

- A4: DPAPI подтверждён; ключ scoped и отозван; один запрос в пределах caps; нет unexpected egress и side effects; логи и redaction проверены; манифест покрывает все файлы.
- Phase 6: snapshot снят до действий; restore совпадает; `fsck` чист; residual 0; пользовательские данные целы; финальный статус честный.

## 9. Публикация

```powershell
git add evidence/m11-pilot
git commit -m "evidence(m11): record A4 provider route and rollback"
git push origin omp-integration
```

Прислать координатору: hash коммита, SHA-256 последнего манифеста, таблицу фаз.

## 10. Чек-лист

1. DPAPI-тест PASS или решение плюс round-trip
2. Заполнены все решения из §3
3. Переменные §4 заданы, каталоги созданы
4. Preflight: hash и версия совпали
5. Ключ выпущен, введён скрыто, лёг в vault
6. Один запрос выполнен, `retries=0`
7. Counters и side effects сняты
8. Ключ отозван у провайдера, подтверждение с UTC
9. Локальная запись удалена
10. Логи и redaction проверены
11. Evidence A4 000256–000268 и манифест
12. Snapshot и restore Phase 6
13. Residual 0, fsck чист
14. Evidence Phase 6 000269–000276
15. `m11-final-status` без необъяснённых BLOCKED
16. Push и хеши отправлены
