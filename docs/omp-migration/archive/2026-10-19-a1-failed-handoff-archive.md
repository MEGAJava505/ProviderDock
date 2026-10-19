# Архив задания elevated A1-rerun после неудачного запуска — 19 октября 2026

Ниже побайтово сохранён прежний `AGENT_HANDOFF.md` из `df53911` / `2e8f92b`. Это историческое задание: единственный actual launch израсходован, прежнее разрешение не действует для следующего запуска. Текущий статус и условия диагностики — в [handoff](../AGENT_HANDOFF.md).

Относительные ссылки дословной записи сохранены в исходном контексте `docs/omp-migration/AGENT_HANDOFF.md`. Из архива evidence доступны в [A1](../../../evidence/m11-pilot/A1-actual-binary/) и [A4](../../../evidence/m11-pilot/A4-provider-route/); остальные архивы находятся в этой же папке.

---

# Текущий статус M11

**A1 NOT PROVEN; A4 BLOCKED на шаге 1.** Пакет `a901dd0` принят как честная фиксация prelaunch BLOCKED (вердикт `c8bdee6`); единственный разрешённый actual launch не израсходован (`actualLaunches=0`). Владелец (gateway-owner MEGAJava505) разрешил elevated Administrator на своей Windows-машине для одного A1-rerun. Координатор команд на машине пользователя не выполняет: исполняет пользователь, координатор проверяет опубликованный evidence.

Прежний вердикт BLOCKED перенесён в [архив](archive/2026-10-19-a1-elevated-handoff-archive.md). [Приёмка P2](archive/2026-10-19-a1-rerun-handoff-archive.md) и [исходное задание A1-rerun](archive/2026-10-19-a1-blocked-handoff-archive.md) остаются в силе.

## Задание A1-rerun elevated — 19 октября 2026

### 1. Кто исполняет и границы

Исполнитель — пользователь на своей Windows-машине в **elevated PowerShell** (Run as Administrator, UAC подтверждён). Агент/координатор не имеет доступа к этой машине и не выполняет ни одной команды; его роль — задание, проверка evidence и вердикт.

Разрешение покрывает ровно один повторный прогон A1:

- один bounded launch pinned `omp.exe` **18.0.4**, SHA-256 **`1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`**;
- inert fixture, deadline ≤45 с;
- `actualLaunches=1`, `retries=0`, live requests/cost=0;
- без provider route, без credentials, без inference и платных запросов;
- A4 этим заданием **не открывается**.

Старые 172 evidence-файла (`evidence/m11-pilot/**`) не изменяются; новые записи — только append-only.

### 2. Шаг 1 — elevation proof

Цель: доказать, что реально elevated именно тот процесс, который создаёт и читает ETW-сессии, а не только членство в группе.

```powershell
whoami /groups | Select-String -Pattern 'S-1-5-32-544','S-1-5-32-559','Mandatory Label'
whoami /priv   | Select-String -Pattern 'SeSystemProfilePrivilege','SeDebugPrivilege','SeProfileSingleProcessPrivilege'
[Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent() |
  Select-Object @{n='IsAdmin';e={$_.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}}
```

Зафиксировать: SID групп, состояние привилегий (`Enabled`/`Disabled`), integrity level (`High`/`System`), `IsAdmin`. Если процесса не elevated — **STOP**: дальнейшие шаги не выполнять.

### 3. Шаг 2 — provider metadata

```powershell
logman query providers "Microsoft-Windows-Kernel-Process"
logman query providers "Microsoft-Windows-TCPIP"
logman query providers "Microsoft-Windows-WFP"
logman query providers "Microsoft-Windows-DNS-Client"
wevtutil gp "Microsoft-Windows-Kernel-Process" /ge:true /gm:true
```

Зафиксировать GUID, доступные Event IDs, version, keywords/levels. Эти значения — источник истины для фильтров; не подставлять Event IDs из памяти.

### 4. Шаг 3 — owned ETW sessions

Создать уникальные сессии под run id (пример; флаги уточнить по metadata шага 2):

```powershell
$run = 'M11-A1-RERUN-ELEVATED-20261019-000108'
logman create trace "PD-A1-$run-Process"   -p "Microsoft-Windows-Kernel-Process" 0xffffffffffffffff 0x5 -o "C:\<OWNED>\etw\$run-process.etl" -ets
logman create trace "PD-A1-$run-Transport" -p "Microsoft-Windows-TCPIP"           0xffffffffffffffff 0x5 -o "C:\<OWNED>\etw\$run-transport.etl" -ets
logman create trace "PD-A1-$run-WFP"       -p "Microsoft-Windows-WFP"             0xffffffffffffffff 0x5 -o "C:\<OWNED>\etw\$run-wfp.etl" -ets
logman query -ets
```

Требования: сессии включены **до** создания helper/actual процессов; вывод `logman query -ets` подтверждает `Running`; consumer/decoder проверен до запуска; файлы ETL — в owned-каталоге, не в пользовательских данных.

### 5. Шаг 4 — self-test ДО actual launch

Без PASS этого шага actual launch запрещён.

```powershell
# 5.1 синтетический launcher -> child с известным exit code
$h = Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c','exit','7' -PassThru -Wait
$h.ExitCode   # ожидается 7

# 5.2 положительный локальный обмен известного размера (loopback, inert)
$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
$listener.Start()
$port = ([System.Net.IPEndPoint]$listener.LocalEndpoint).Port
# отдельным процессом: отправить 64 байта, получить эхо, закрыть
# зафиксировать: bytes sent/received, request count, длительность

# 5.3 отрицательный direct TCP (вне allowlist) -> отказ
try { (New-Object System.Net.Sockets.TcpClient).Connect('<NON_ALLOWLISTED_HOST>', <PORT>) }
catch { $_.Exception.InnerException.SocketErrorCode }   # ожидается AccessDenied / 10013
```

Проверить после остановки/слива сессий:

```powershell
logman stop "PD-A1-$run-Process" -ets
logman stop "PD-A1-$run-Transport" -ets
logman stop "PD-A1-$run-WFP" -ets
tracerpt "C:\<OWNED>\etw\$run-process.etl" -o "C:\<OWNED>\etw\$run-process.xml" -of XML -y
# в сводке tracerpt: Events Lost = 0; отдельно проверить LogBuffersLost/RealTimeBuffersLost
```

Self-test PASS только если: child exit code совпал; ProcessStart/ProcessStop с parent linkage реально записаны; локальный обмен измерен; negative TCP дал отказ; `EventsLost=0`; decoder读到 ожидаемые события. Иначе — **BLOCKED**, actual launch не выполнять, бюджет не расходовать.

### 6. Шаг 5 — authorization и preflight

Перед запуском создать:

- `authorization-rerun-elevated-000108.json` — phase/evidenceId, authorizationRef (это разрешение владельца с цитатой scope), supersedes (`authorization-rerun-000099.json`), scope/project, responsible/approver/observationOwner, `issuedAtUtc`, будущее короткое `utcTimeWindow`, monitoringPlan (инструменты/версии/config ref+hash/sessions/фильтры/потеря событий), stopCriterion, expectedResult, sideEffectPolicy, binary (version/path alias/SHA-256), launch (argv/cwd/env policy), limits, integrityHash, status.
- `token-readback-000109.json` — вывод шага 1: SID групп, привилегии, integrity, IsAdmin, время.
- `provider-metadata-000110.json` — GUID/Event IDs/versions по шагу 2.
- `monitoring-config-elevated-000111.json` — точные сессии, providers, флаги, пути ETL, consumer, self-test config.
- `preflight-elevated-000113.json` — `Get-FileHash -Algorithm SHA256` pinned binary без исполнения, environment attestation (fresh profile/Job), policy allow/deny, свободные порты/каталоги.

Значения `<...>` заполняет пользователь; выдуманные лимиты, route ID или credential class недопустимы.

### 7. Шаг 6 — один actual launch

В утверждённом UTC-окне, при живых сессиях:

```powershell
$omp = '<PINNED_OMP_PATH>'
(Get-FileHash -Algorithm SHA256 $omp).Hash   # должен совпасть с 1944c6e2...
$p = Start-Process -FilePath $omp -ArgumentList @('<ALLOWLISTED_ARGS>') `
      -WorkingDirectory '<OWNED_FIXTURE_CWD>' -PassThru
$p.WaitForExit(45000)
$p.ExitCode
```

Собрать:

- `process-tree-elevated-000114.json`: parent/controller PID → omp.exe PID → все child/descendant; для каждого PID + creation time, parent PID, spawn/exit UTC, path + SHA-256, exit code, orphan check после teardown, Job peak;
- `network-counters-elevated-000115.json`: attempted/allowed/denied, connections, sent/received bytes, requests; источник, единицы, baseline/final/delta, scope (actual/descendants/controller/helpers/probes), дедупликация;
- `run-log-elevated-000116.txt`: хронология UTC, команды, exit codes, stop/teardown;
- `side-effects-elevated-000117.json`: только owned fixture, перечень созданных/изменённых путей, отсутствие внешних эффектов;
- `summary-elevated-000118.json`: итог, PASS/BLOCKED, ссылки на все артефакты;
- `integrity-hashes-elevated-000119.txt`: SHA-256 всех новых файлов + манифест.

Teardown: остановить сессии, проверить отсутствие процессов `omp.exe`/helpers, закрыть сокеты/broker, подтвердить orphan=0, сохранить ETL/XML вне пользовательских данных.

### 8. Критерии приёмки

1. Elevation proof: процесс elevated, нужные привилегии Enabled, integrity High/System.
2. Provider metadata зафиксирована; сессии `Running` до запуска; decoder проверен.
3. Self-test PASS: child exit code, parent linkage, локальный обмен, negative TCP, `EventsLost=0`.
4. Launch exit 0 ≤45 с в утверждённом окне; hash бинаря совпал.
5. Process tree полный: parent → omp.exe → все children с PID/creation time/path/SHA-256/exit; orphan=0.
6. Network counters измерены, 0 unexpected egress; allowlist соблюдён.
7. Side effects только owned fixture; пользовательские данные не изменены.
8. Integrity: все SHA-256 совпадают; redaction чист (нет секретов, токенов, raw headers, cookies, абсолютных путей, email).

### 9. Stop-правила

Self-test fail, `EventsLost>0`, unexpected child/egress, cap breach, timeout, hash mismatch, side effect вне owned fixture, потеря сессии/consumer — **STOP**: зафиксировать `BLOCKED`/`NOT PROVEN`, не повторять без нового разрешения. Actual launch не выполнять, если preflight/self-test неполон.

### 10. После выполнения

```powershell
git add evidence/m11-pilot
git commit -m "evidence(m11): record elevated A1 rerun"
git push origin omp-integration
```

Прислать координатору: hash коммита и SHA-256 манифеста `integrity-hashes-elevated-000119.txt`. Дальше — независимое ревью Astra; при приёмке A1 цепочка закрывается и открывается шаг 1 для A4 (fresh environment, scoped credential, pinned модель, caps) по [readiness checklist 000096](../../evidence/m11-pilot/A4-provider-route/readiness-checklist-p2-000096.json).

### 11. Сводная таблица команд

| Шаг | Команда (пример) | Что зафиксировать |
|---|---|---|
| Elevation | `whoami /groups`, `whoami /priv` | SID, привилегии, integrity, IsAdmin |
| Providers | `logman query providers "<name>"`, `wevtutil gp` | GUID, Event IDs, versions |
| Sessions | `logman create trace ... -ets`, `logman query -ets` | имена, Running, пути ETL |
| Self-test | `Start-Process cmd /c exit 7`, loopback exchange, negative TCP | exit code, bytes/requests, SocketErrorCode 10013, EventsLost=0 |
| Preflight | `Get-FileHash -Algorithm SHA256` | hash pinned binary |
| Launch | `Start-Process ... -PassThru`, `WaitForExit(45000)` | exit code, UTC окно |
| Tree | `Get-CimInstance Win32_Process` + ETL events | PID/creation/parent/path/SHA-256 |
| Network | `tracerpt` + consumer counters | attempted/allowed/denied, bytes, requests |
| Teardown | `logman stop ... -ets`, orphan check | orphan=0, сессии остановлены |
| Публикация | `git add/commit/push` | hash коммита, SHA-256 манифеста |
