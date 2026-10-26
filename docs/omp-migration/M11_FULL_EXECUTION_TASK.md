# M11 — полное задание на исполнение (19–20 октября 2026)

Документ для владельца (gateway-owner MEGAJava505). Исполняется на его Windows-машине в elevated PowerShell. Координатор команд не выполняет: он проверяет опубликованный evidence и выносит вердикт.

## 0. Исходное состояние

| Фаза | Статус | Чем подтверждено |
|---|---|---|
| Phase 0 — подготовка | PASS | 228/228, build/typecheck, snapshot read-only, hashes |
| A1 — actual binary | **NOT PROVEN** | единственный launch: exit 1 через 6.924 с до ответа ACP; причина не установлена (диагностика аварийного пути не сохранена) |
| A2 — native resume | PASS ограниченного наблюдения | idle resume, linkage, before/after hash; inference не проверялся |
| A3 — egress/isolation | PASS ограниченного наблюдения | AppContainer, deny-by-default, control probe; direct OMP TCP не доказан |
| A4 — provider route | **BLOCKED** | нет scoped credential, pinned модели, caps |
| Phase 6 — rollback | NOT PROVEN итоговой записи | нужен финальный rollback после A4 |

Правило: каждая фаза принимается отдельно; следующая не открывается без приёмки предыдущей. Бюджет — **один actual launch на фазу**, `retries=0`.

## 1. Общие правила

1. Evidence только append-only. Старые 197 файлов не изменяются.
2. Каждый новый JSON содержит внутренний `integrityHash`: удаляется только верхний `integrityHash`, recursive key sort `localeCompare('en')`, arrays preserved, pretty2 UTF-8 + LF, SHA-256.
3. Каждая фаза заканчивается манифестом `integrity-hashes-*.txt` с SHA-256 всех файлов фазы (манифест исключает себя; его SHA-256 передаётся отдельно).
4. Запрещено в evidence: секреты, токены, raw headers, cookies, транскрипты, абсолютные пользовательские пути, email, account/route IDs в сыром виде.
5. Любой stop → `BLOCKED`/`NOT PROVEN` в summary, без повторов без нового разрешения владельца.
6. Новые evidence ID начинаются с **000159** и выделяются последовательно; перед записью проверить отсутствие коллизии.

## 2. Фаза A1-D — диагностический launch

Цель: установить причину exit 1 и собрать полную диагностику. A1 PASS этой фазой не выдаётся.

### 2.1 Предусловия

- elevated PowerShell, `IsAdmin=true`, integrity High/System, `SeSystemProfilePrivilege` Enabled;
- pinned `omp.exe` 18.0.4, SHA-256 `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`;
- owned inert fixture, чистые каталоги logs/dumps/etw;
- ETW provider metadata снята на этом build.

### 2.2 Команды

```powershell
# elevation proof
whoami /groups | Select-String 'S-1-5-32-544','Mandatory Label'
whoami /priv   | Select-String 'SeSystemProfilePrivilege','SeDebugPrivilege'

# provider metadata
logman query providers "Microsoft-Windows-Kernel-Process"
logman query providers "Microsoft-Windows-TCPIP"
logman query providers "Microsoft-Windows-WFP"
wevtutil gp "Microsoft-Windows-Kernel-Process" /ge:true /gm:true

# owned paths (подставить свой абсолютный путь вне рабочего дерева)
$owned = '<OWNED_DIR>'
$run='M11-A1D-20261020'
New-Item -ItemType Directory -Force "$owned\etw","$owned\logs","$owned\dumps","$owned\fixture" | Out-Null

# owned ETW sessions (до создания процессов)
logman create trace "PD-$run-Process"   -p "Microsoft-Windows-Kernel-Process" 0xffffffffffffffff 0x5 -o "$owned\etw\$run-process.etl" -ets
logman create trace "PD-$run-Transport" -p "Microsoft-Windows-TCPIP"           0xffffffffffffffff 0x5 -o "$owned\etw\$run-transport.etl" -ets
logman create trace "PD-$run-WFP"       -p "Microsoft-Windows-WFP"             0xffffffffffffffff 0x5 -o "$owned\etw\$run-wfp.etl" -ets
logman query -ets

# WER LocalDumps (восстановить после прогона)
$k='HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting\LocalDumps\omp.exe'
New-Item $k -Force | Out-Null
New-ItemProperty $k -Name DumpFolder -Value "$owned\dumps" -PropertyType ExpandString -Force
New-ItemProperty $k -Name DumpType -Value 1 -PropertyType DWord -Force

# self-test (обязателен, без него launch запрещён)
$h=Start-Process "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c','exit','7' -PassThru -Wait
$h.ExitCode   # 7
# loopback: 64 байта, 1 запрос
# negative: direct TCP вне allowlist -> AccessDenied/10013

# launch (единственный)
$omp='<PINNED_OMP_PATH>'
$ompArgs = @('<ALLOWLISTED_ARGS>')   # заменить на утверждённый allowlist; каждый аргумент — отдельный элемент массива
(Get-FileHash -Algorithm SHA256 $omp).Hash
$p=Start-Process $omp -ArgumentList $ompArgs -WorkingDirectory "$owned\fixture" `
   -RedirectStandardOutput "$owned\logs\omp-stdout.log" `
   -RedirectStandardError  "$owned\logs\omp-stderr.log" -PassThru
$null=$p.WaitForExit(45000)
$p.ExitCode
```

Плейсхолдеры `$owned` и `$omp` в одинарных кавычках заменяются реальными путями до запуска: символы `<`/`>` в PowerShell зарезервированы под перенаправление, поэтому пути не подставляются как `<...>` прямо в команду. Интерполяция `$owned`/`$run` работает только в двойных кавычках — одиночные кавычки оставлены лишь там, где значение подставляется владельцем целиком.

Дополнительно зафиксировать `Get-Item $omp | Select-Object -ExpandProperty VersionInfo` (FileVersion/ProductVersion) — без запуска процесса.

### 2.3 Evidence A1-D (000159–000171)

| ID | Файл | Содержимое |
|---|---|---|
| 000159 | `authorization-diagnostic-000159.json` | окно UTC, scope, роли, лимиты, stopCriterion, integrityHash |
| 000160 | `diagnostic-config-000160.json` | ETW sessions, WER, redirects, handshake logging, declared helpers (`conhost.exe`), restore plan |
| 000161 | `preflight-diagnostic-000161.json` | hash, VersionInfo, environment attestation, policy, свободные пути |
| 000162 | `process-tree-diagnostic-000162.json` | parent→omp.exe→children, PID+creation, path+SHA-256, exit codes, orphan check |
| 000163 | `network-counters-diagnostic-000163.json` | attempted/allowed/denied, bytes, requests, source/unit/baseline/final/delta |
| 000164 | `stdout-diagnostic-000164.log` | сырой stdout |
| 000165 | `stderr-diagnostic-000165.log` | сырой stderr |
| 000166 | `wer-dump-metadata-000166.json` | dump yes/no, путь/размер/hash, restore HKLM |
| 000167 | `acp-handshake-000167.json` | CreateProcess/ResumeThread, write/flush initialize, границы frame/parse, EOF/таймаут |
| 000168 | `run-log-diagnostic-000168.txt` | хронология UTC, команды, exit codes, teardown |
| 000169 | `side-effects-diagnostic-000169.json` | только owned fixture, внешние эффекты отсутствуют |
| 000170 | `summary-diagnostic-000170.json` | причина (или честно «не установлена»), ссылки |
| 000171 | `integrity-hashes-diagnostic-000171.txt` | SHA-256 всех файлов фазы |

**Приёмка A1-D:** все 13 файлов; stdout/stderr захвачены на аварийном пути; WER metadata; handshake-границы; exit-code mapping; `conhost.exe` declared; `EventsLost=0`; orphan=0; integrity/redaction чисты. A1 claim остаётся `NOT PROVEN`, если `initialize` не ответил.

## 3. Фаза A1-F — финальный A1 launch (только после приёмки A1-D и отдельного разрешения)

Цель: доказать A1. Требуется, если диагностика показала устранимую причину.

- Один bounded launch с теми же ограничениями, исправленной конфигурацией и полной телеметрией.
- PASS только при получении ответа `initialize` и завершении минимального протокола (`session/new`, без inference).
- Evidence: `authorization-a1-final-000172.json`, `preflight-a1-final-000173.json`, `process-tree-a1-final-000174.json`, `network-counters-a1-final-000175.json`, `acp-session-000176.json`, `run-log-a1-final-000177.txt`, `side-effects-a1-final-000178.json`, `summary-a1-final-000179.json`, `integrity-hashes-a1-final-000180.txt`.
- Если причина неустранима в текущей среде — A1 остаётся `NOT PROVEN`, A4 не открывается; зафиксировать это в summary.

## 4. Фаза A2 — native resume

Цель: подтвердить продолжение реального run с доказуемой связью.

1. Взять сохранённое native state от принятого A1 run (immutable source hash).
2. Один `--resume`, idle (без inference), в новом окне.
3. Зафиксировать: source/run/session/model linkage, before/after SHA-256, messageCount/duplicateMessages, exit code, отсутствие повторных side effects.
4. Evidence: `authorization-resume-000181.json`, `preflight-resume-000182.json`, `resume-observation-000183.json`, `side-effects-resume-000184.json`, `summary-resume-000185.json`, `integrity-hashes-resume-000186.txt`.

**Приёмка:** linkage подтверждён, before/after совпали, дублей 0, side effects 0. PASS — как наблюдение; inference не входит.

## 5. Фаза A3 — egress и изоляция

Цель: доказать, что среда изолирована и egress ограничен allowlist.

1. Fresh AppContainer/profile, deny-by-default, allowlist ровно для одного loopback/inert fixture.
2. Attestation среды: token/capabilities, Job binding, HOME/TEMP/cwd isolation, отсутствие унаследованных credentials.
3. Наблюдения: direct TCP → `EACCES`/`WSAEACCES 10013`; unlisted broker route → reject-before-network; один allowlisted TLS HEAD → ожидаемый код; счётчики bytes/requests.
4. Evidence: `authorization-egress-000187.json`, `isolation-attestation-000188.json`, `preflight-egress-000189.json`, `egress-observations-000190.json`, `negative-probes-000191.json`, `summary-egress-000192.json`, `integrity-hashes-egress-000193.txt`.

**Приёмка:** изоляция подтверждена, 0 unexpected egress, счётчики измерены монитором (не аттестацией). A3 не открывает A4 автоматически.

## 6. Фаза A4 — живая provider route

Цель: один минимальный запрос к утверждённому маршруту с scoped credential.

### 6.1 Решения владельца до старта

Заполнить и утвердить в authorization:

- `routeIdRedacted` — alias, не сырой ID; mapping хранится локально;
- `credentialClass` — scoped/ephemeral, TTL не позже конца окна;
- `selectedModel` — точный model ID/revision, без `auto`/fallback;
- `costLimit` — число + валюта; `requestLimit` — конечное число; `maxInputTokens`/`maxOutputTokens`; `timeout`; `retries=0`;
- `utcTimeWindow` — короткое будущее окно;
- `stopCriterion` — 401/403/429, 5xx, timeout, route/model drift, unexpected egress/child/side effect, cap breach;
- `revocationPlan` — кто и как отзывает credential у issuer, подтверждение с UTC.

### 6.2 Credential

```powershell
$ref = '<LOCAL_SECRET_REFERENCE>'   # подставить redacted-ссылку до запуска
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
```

Символы `<`/`>` в PowerShell зарезервированы, поэтому ссылка подставляется через переменную, а не как `<...>` в аргументе.

Хранение — штатный DPAPI vault вне репозитория. Запрещено: `setx`, user/machine env, plaintext-файлы, ключ в аргументах команды, transcript/debug dump.

### 6.3 Прогон

- Активировать профиль m11-pilot, привязать protected reference только к нему.
- Один запрос через штатный CLI/API, pinned route+model.
- Снять: before/after request/cost counters, response class, side effects, allow/deny observations.
- После: остановить процессы, выключить pilot, **отозвать credential у issuer**, зафиксировать подтверждение с UTC; удалить local vault entry только после проверки bindings.
- Проверить логи приложения/контроллера, shell history, temp/crash artifacts, staged diff; у issuer — usage/revocation audit.

### 6.4 Evidence A4 (000194–000202)

`authorization-provider-route-000194.json`, `credential-binding-000195.json` (redacted), `preflight-provider-route-000196.json`, `provider-request-observation-000197.json`, `counters-cost-000198.json`, `side-effects-provider-route-000199.json`, `summary-provider-route-000200.json`, `revocation-confirmation-000201.json`, `integrity-hashes-provider-route-000202.txt`.

**Приёмка:** ответ получен в пределах caps; counters в лимитах; side effects только ожидаемые; credential отозван; утечек нет. Иначе `NOT PROVEN`.

## 7. Фаза 6 — rollback и закрытие

1. Immutable snapshot до внешних действий (git bundle + state + binary hashes).
2. Восстановление в отдельный owned каталог, сверка дерева и hashes, `git fsck`.
3. Проверка: 0 собственных процессов, 0 orphan, 0 residual egress, user homes/archives не удалены.
4. Аудит логов и redaction-скан новых файлов.
5. Evidence: `authorization-rollback-000203.json`, `snapshot-manifest-000204.json`, `restore-verification-000205.json`, `residual-check-000206.json`, `log-audit-000207.json`, `summary-rollback-000208.json`, `integrity-hashes-rollback-000209.txt`, `m11-final-status-000210.json`.

**Приёмка:** восстановление подтверждено, residual 0, логи проверены, финальный статус честно отражает PASS/BLOCKED по каждой фазе.

## 8. Финальная публикация

```powershell
git add evidence/m11-pilot
git commit -m "evidence(m11): complete external pilot phases"
git push origin omp-integration
```

Прислать координатору: hash коммита, SHA-256 последнего манифеста, краткую таблицу фаз PASS/BLOCKED.

## 9. Критерий завершения M11

M11 считается завершённым, когда:

- A1 PASS (реальный `initialize`/`session/new` без inference) или честно зафиксирован `NOT PROVEN` с установленной причиной;
- A2 PASS как наблюдение;
- A3 PASS с измеренным egress;
- A4 PASS в пределах caps с подтверждённым отзывом credential;
- Phase 6 PASS с восстановлением и residual=0;
- итоговый `m11-final-status-000210.json` не содержит необъяснённых `BLOCKED`.

Cutover, удаление legacy и production default остаются вне M11 и требуют отдельного решения (глава 6 REMAINING_PLAN).

## 10. Быстрый чек-лист

- [ ] Elevated proof и provider metadata
- [ ] ETW sessions + WER LocalDumps
- [ ] Self-test PASS
- [ ] Авторизация и окно
- [ ] Один launch, stdout/stderr в файлы
- [ ] Process tree, network counters, exit-code mapping
- [ ] Teardown, orphan=0, EventsLost=0
- [ ] A2 resume с linkage
- [ ] A3 изоляция и negative probes
- [ ] A4 credential, один запрос, caps, отзыв
- [ ] Phase 6 rollback, residual=0
- [ ] Манифесты и push
