# Текущий статус M11

**A1 NOT PROVEN; A4 BLOCKED на шаге 1.** Пакет `df53911..2e8f92b` принят как честная фиксация неудачного elevated A1-rerun (вердикт `717785c`): self-test PASS для мониторинга, actual OMP exit 1 через 6.924 с до ответа ACP `initialize`, причина не установлена из-за отсутствия диагностики на аварийном пути, бюджет запуска израсходован, повторов не было.

Владелец (gateway-owner MEGAJava505) 19 октября 2026 разрешил: **второй диагностический запуск** и **закрытие P2-S1 (internal integrity) в одном пакете**. Координатор команд на машине пользователя не выполняет: исполняет пользователь в elevated PowerShell, координатор проверяет evidence.

Прежний вердикт перенесён в [архив](archive/2026-10-19-a1-diagnostic-handoff-archive.md). [Задание elevated](archive/2026-10-19-a1-failed-handoff-archive.md), [вердикт prelaunch BLOCKED](archive/2026-10-19-a1-elevated-handoff-archive.md), [приёмка P2](archive/2026-10-19-a1-rerun-handoff-archive.md) остаются в силе.

## Задание A1-diagnostic — 19 октября 2026

### 1. Границы и бюджет

- Один диагностический launch pinned `omp.exe` **18.0.4**, SHA-256 **`1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`**.
- inert fixture, deadline ≤45 с, `actualLaunches=1`, `retries=0`, live requests/cost=0.
- Без provider route, без credentials, без inference; A4 не открывается.
- Цель прогона — **установить причину exit 1** и собрать полную диагностику на всех путях, а не доказать успех протокола.
- Старые evidence не изменяются; всё новое — append-only.

### 2. P2-S1 — integrity backfill (в этом же пакете)

Создать `integrity-correction-backfill-000145.json`:

- для каждого из новых JSON пакета `df53911..2e8f92b`, у которых нет внутреннего `integrityHash` (18 из 19; `authorization-000132` уже имеет), записать вычисленный хеш и путь;
- зафиксировать параметры canonicalization: удаляется только верхний `integrityHash`, recursive key sort `localeCompare('en')`, arrays preserved, pretty2 UTF-8 + LF, SHA-256;
- append-only: старые файлы не переписывать.

Критерий: все 19 JSON покрыты, хеши воспроизводимы той же процедурой.

### 3. Обязательная диагностика на всех путях

До запуска настроить и проверить:

1. **stdout/stderr в файлы** для OMP и контроллера, на всех ветках (успех, ошибка, таймаут, kill):
   ```powershell
   $p = Start-Process -FilePath $omp -ArgumentList @('<ARGS>') `
        -WorkingDirectory '<OWNED_FIXTURE_CWD>' `
        -RedirectStandardOutput '<OWNED>\logs\omp-stdout.log' `
        -RedirectStandardError  '<OWNED>\logs\omp-stderr.log' -PassThru
   ```
   Файлы создаются всегда; ротация/усечение запрещены.
2. **WER LocalDumps** для `omp.exe` (на время прогона, затем восстановить прежние значения):
   ```powershell
   $k = 'HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\omp.exe'
   New-Item -Path $k -Force | Out-Null
   New-ItemProperty $k -Name DumpFolder -Value '<OWNED>\dumps' -PropertyType ExpandString -Force
   New-ItemProperty $k -Name DumpType   -Value 1 -PropertyType DWord -Force
   ```
   Зафиксировать, был ли создан дамп; если да — путь/размер/SHA-256 в metadata (сам дамп не публиковать).
3. **ACP handshake log**: CreateProcess/ResumeThread, UTC и монотонные тайминги, write/flush `initialize`, каждая граница frame/parse, ожидание ответа, EOF/таймаут, размеры сообщений. Без содержимого секретов.
4. **Exit-code mapping**: `GetExitCodeProcess`/ETW ProcessStop PID+CreateTime, decimal и hex, применимые Win32/NTSTATUS/WER значения.
5. **Runtime version/header до ACP** — без нового запуска: `Get-Item $omp | Select-Object -ExpandProperty VersionInfo` (FileVersion/ProductVersion) и, если применимо, версия из header, прочитанного файловым API.
6. **Expected helpers**: `conhost.exe` предобъявить как ожидаемый system helper (путь, SHA-256, подпись, parent identity). Любой другой child вне списка — stop.
7. **Job peak accounting** читать после завершения, на всех путях.
8. ETW-сессии и self-test — как в предыдущем задании; self-test обязателен перед launch, PASS фиксируется в новом файле.

### 4. Evidence-контракт (новые ID)

| ID | Файл | Обязательное содержимое |
|---|---|---|
| 000145 | `integrity-correction-backfill-000145.json` | пути, вычисленные hashes, canonicalization, покрытие 19 JSON |
| 000146 | `authorization-diagnostic-000146.json` | phase/evidenceId, authorizationRef (это разрешение владельца), supersedes (`000132`), scope/project, responsible/approver, UTC window, monitoringPlan, stopCriterion, limits, integrityHash |
| 000147 | `diagnostic-config-000147.json` | ETW sessions, WER config, redirect paths, handshake logging, expected helpers, restore plan |
| 000148 | `preflight-diagnostic-000148.json` | binary hash без исполнения, VersionInfo, environment attestation, policy, free paths |
| 000149 | `process-tree-diagnostic-000149.json` | parent→omp.exe→children, PID+creation time, path+SHA-256, exit codes, conhost declared, orphan check |
| 000150 | `network-counters-diagnostic-000150.json` | attempted/allowed/denied, connections, bytes, requests, source/unit/baseline/final/delta, scope |
| 000151 | `stdout-diagnostic-000151.log` | сырой stdout OMP, UTC-метки, без редакции секретов (их не должно быть) |
| 000152 | `stderr-diagnostic-000152.log` | сырой stderr OMP |
| 000153 | `wer-dump-metadata-diagnostic-000153.json` | dump yes/no, путь/размер/SHA-256, restore HKLM подтверждён |
| 000154 | `acp-handshake-diagnostic-000154.json` | события handshake с таймингами и границами |
| 000155 | `run-log-diagnostic-000155.txt` | хронология UTC, команды, exit codes, teardown |
| 000156 | `side-effects-diagnostic-000156.json` | только owned fixture, перечень изменений, отсутствие внешних эффектов |
| 000157 | `summary-diagnostic-000157.json` | итог, причина (или честно «не установлена»), ссылки на артефакты |
| 000158 | `integrity-hashes-diagnostic-000158.txt` | SHA-256 всех новых файлов, манифест |

Каждый новый JSON обязан содержать внутренний `integrityHash` по той же canonicalization (P2-S1 закрывается и для этого пакета).

### 5. Критерии приёмки

**Пакет как диагностика — PASS**, если: все 14 файлов присутствуют; манифест `000158` и внутренние хеши сходятся; stdout/stderr захвачены на аварийном пути; WER metadata документирует dump или обоснованное его отсутствие; handshake log показывает границы и точку отказа; exit code замаплен; `conhost.exe` предобъявлен; `EventsLost=0`; orphan=0; side effects только fixture; redaction чист.

**A1 claim — PASS** только если получен ответ `initialize` и минимальный протокол завершился. Иначе A1 остаётся `NOT PROVEN` даже при полной диагностике.

### 6. Stop-правила

Self-test fail, `EventsLost>0`, child вне declared helpers, unexpected egress, cap breach, timeout, hash mismatch, side effect вне fixture, невозможность захвата диагностики на всех путях → **STOP**, `BLOCKED`/`NOT PROVEN`, без повторов без нового разрешения.

### 7. После выполнения

```powershell
git add evidence/m11-pilot
git commit -m "evidence(m11): record A1 diagnostic launch and integrity backfill"
git push origin omp-integration
```

Прислать координатору hash коммита и SHA-256 манифеста `integrity-hashes-diagnostic-000158.txt`. Далее — независимое ревью Astra; при приёмке диагностики A1-вопрос закрывается по факту (PASS или NOT PROVEN с установленной причиной), и только затем обсуждается шаг 1 для A4.

### 8. Сводная таблица

| Шаг | Что сделать | Evidence |
|---|---|---|
| Backfill | пересчитать 18 хешей | 000145 |
| Authorization | заполнить окно/роли/лимиты | 000146 |
| Config | ETW, WER, redirects, helpers | 000147 |
| Preflight | hash + VersionInfo + среда | 000148 |
| Self-test | повторить перед launch | в 000147/000155 |
| Launch | один, с redirect stdout/stderr | 000149–000156 |
| WER | проверить dump и restore | 000153 |
| Teardown | сессии, процессы, orphan | 000155 |
| Публикация | manifest + push | 000158 |
