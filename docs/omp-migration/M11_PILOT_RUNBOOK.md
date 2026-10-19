# M11 external pilot — runbook для пользователя Windows

**Статус:** инструкция для пользовательского запуска. Внешний пилот этим файлом не запускался. Live credentials, paid requests, cutover и изменение production defaults запрещены.

## Введение

M11 — ограниченный, воспроизводимый и обратимый пилот ProviderDock. Локальная глава 5 уже проверена на Linux VPS и Windows пользователя: изменения и проверки зафиксированы в `a80ac49`, `9ce3f3b`, `30f95f7` и `5f636f5`. Эти результаты относятся к локальным fixture/loopback и fake-child сценариям. Они не являются доказательством внешних границ.

Пилот должен отдельно проверить четыре границы:

1. запуск именно утверждённого actual `omp.exe` с версией и SHA-256;
2. native resume фактического OMP run из сохранённого состояния;
3. разрешённый внешний egress и deny-by-default OS/network isolation;
4. один заранее ограниченный маршрут к живому provider с учётом request/cost caps и side effects.

Прочитайте также [M11_EXTERNAL_PILOT_PLAN.md](M11_EXTERNAL_PILOT_PLAN.md) и [Special_tests.md](../../Special_tests.md). Локальный PASS, отсутствие ошибки и synthetic evidence не открывают A1–A4.

## Правила безопасности и статусов

Фазы выполняются строго последовательно. Пофазный gate такой: Phase 1–2 → A1, Phase 3 → A2, Phase 4 → A3, Phase 5 → A4, Phase 6 не требует нового gate. Незаполненное поле соответствующего gate означает `BLOCKED`; неполное или противоречивое evidence означает `NOT PROVEN`. Не переходите дальше при `BLOCKED`, `FAIL`, `NOT PROVEN`, незакрытом stop outcome или отсутствии integrity hash.

Никогда не записывайте secrets, tokens, raw headers, cookies, payloads, transcripts, live credential values, raw URL/endpoint или абсолютные пути с именем пользователя. В evidence используйте redacted значения и пути вида `E:/<PROJECTS>/...`. Не делайте automatic retry после `503` или `5xx`. При 401/403/429, timeout, cap breach, unexpected egress, side effect, route drift, неразрешённом child или mismatch hash/version немедленно остановитесь.

### Фиксированный evidence-контракт

Создайте каталог `evidence/m11-pilot/` в корне репозитория. Имена и состав каталогов неизменны:

```text
evidence/m11-pilot/
  phase0-preparation/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
  A1-actual-binary/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
  A2-native-resume/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
  A3-egress-isolation/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
  A4-provider-route/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
  phase6-rollback-observation/
    authorization.json
    preflight.json
    run-log.txt
    side-effects.json
    summary.json
    integrity-hashes.txt
```

`phase0-preparation` фиксирует snapshot и локальную готовность; его `authorization.json` содержит `phase: "phase0-preparation"`, `authorizationRef: "none"` и отметку, что внешняя авторизация ещё не выдана. Для A1–A4 в `authorization.json` до начала соответствующей фазы должны быть заполнены и одобрены: `scope/project`, `responsible`, `approver`, `credentialClassAndAllowlistedRoute`, числовые `costLimit` и `requestLimit`, `utcTimeWindow.start/end`, `stopCriterion`, `status`. Не вписывайте значения, которых нет в выданной авторизации.

В каждом `preflight.json` укажите `phase`, уникальный монотонный `evidenceId`, UTC start/end и факт попадания в окно, actor/approver, `authorizationRef`, redacted project/route IDs, binary version/SHA-256 или `not-applicable`, environment и OS-isolation attestations, credential class, counters до/после, `preflightId`/`runId`, native-resume linkage или `not-applicable`, network-egress observation, expected/actual result, side-effect assessment, rollback decision, redacted relative `artifactLocations`, `redactionPolicy`, `integrityHash`, `status` (`PASS|FAIL|NOT PROVEN|BLOCKED`).

`run-log.txt` — хронология команд и наблюдений с UTC временем, exit code, нормализованными результатами и stop outcome; не копируйте stdout/stderr, headers, cookies, tokens или transcripts целиком. `side-effects.json` — явная оценка `none`, `observed` или `unknown`, затронутые redacted artifacts и решение владельца. `summary.json` — claim, phase(s), gate, expected-versus-actual, counters, status и причина stop/rollback. `integrity-hashes.txt` — SHA-256 canonicalized JSON/text evidence и всех ссылочных артефактов; перечисляйте только redacted relative paths. Каждый новый stop/correction добавляйте новой записью/evidenceId, не переписывайте и не удаляйте старую.

## Phase 0 — preparation and immutable snapshot

**Цель:** получить чистую рабочую копию, выполнить краткую локальную проверку и создать неизменяемый snapshot до любого внешнего действия. Новый A-gate не требуется; A1–A4 остаются `BLOCKED`, пока их записи не заполнены и не одобрены.

В PowerShell из корня checkout:

```powershell
git switch omp-integration
git pull --ff-only origin omp-integration
npm ci

# Краткие локальные gates из Special_tests.md
npm run typecheck
npm run build
node --check scripts/omp-browser-stack-smoke.mjs
node --check scripts/dashboard-ui-smoke.mjs
npx vitest run tests/omp-run-repository.test.ts tests/omp-runtime.test.ts tests/omp-launch-service.test.ts tests/omp-process-supervisor.test.ts tests/omp-integration-harness.test.ts tests/provider-dashboard-omp.test.ts tests/provider-dashboard-server.test.ts
git diff --check

New-Item -ItemType Directory -Force evidence/m11-pilot/phase0-preparation | Out-Null
New-Item -ItemType Directory -Force .m11-snapshot | Out-Null

git bundle create .m11-snapshot/omp-integration.bundle omp-integration
if (Test-Path .provider-dock) {
  New-Item -ItemType Directory -Force .m11-snapshot/provider-dock-state | Out-Null
  Copy-Item .provider-dock .m11-snapshot/provider-dock-state -Recurse -Force
  Get-ChildItem .m11-snapshot/provider-dock-state -Recurse -File |
    Get-FileHash -Algorithm SHA256 | Out-File .m11-snapshot/provider-dock-state-hashes.txt
} else {
  'not-present' | Set-Content .m11-snapshot/provider-dock-state-hashes.txt
}
Get-FileHash .m11-snapshot/provider-dock-state-hashes.txt -Algorithm SHA256 |
  Out-File .m11-snapshot/provider-dock-metadata-sha256.txt
Get-FileHash .m11-snapshot/omp-integration.bundle -Algorithm SHA256 |
  Out-File .m11-snapshot/bundle-sha256.txt
```

Если `.provider-dock` отсутствует, запишите в `preflight.json` `state: "not-present"`; не создавайте выдуманный state. Для полной копии каталога вместо bundle допустимо сделать копию checkout в отдельный read-only носитель, но не смешивайте snapshot с рабочей копией. Маскируйте пути до вида `E:/<PROJECTS>/provider__switcher`.

Наблюдайте: `git pull` должен быть fast-forward, `npm ci` и локальные проверки — с ожидаемым exit code 0, snapshot hash — доступен до внешних действий, live credential отсутствуют. При dirty tree, ошибке сборки/тестов, невозможности проверить bundle/hash или найденном секрете остановитесь, исправьте/заархивируйте состояние и установите `BLOCKED`.

Создайте шесть файлов `phase0-preparation/` по контракту. В `authorization.json` укажите `status: "BLOCKED"` для A1–A4 и отсутствие внешнего разрешения; в `summary.json` — только локальные результаты. Без успешного Phase 0 не начинайте Phase 1.

Безопасное состояние: не запускайте `omp.exe`, не подключайте provider, сохраните snapshot read-only и рабочую копию отдельно. При проблеме вернитесь к bundle/копии; ничего не удаляйте.

## Phase 1 — authorization / preflight (A1)

**Цель:** проверить только готовность к actual `omp.exe`, без запуска, resume и provider request. Перед фазой в `A1-actual-binary/authorization.json` зафиксируйте заполненные `scope/project`, `responsible`, `approver`, credential class и allowlisted route (`none` для binary-only), конечные числовые cost/request caps, UTC window и stop criterion; approver должен явно подтвердить запись. Если поле неизвестно — `BLOCKED`.

PowerShell-команды:

```powershell
$ActualOmp = 'E:/<APP>/omp.exe'
Get-Item $ActualOmp | Select-Object FullName, Length, LastWriteTimeUtc
Get-FileHash $ActualOmp -Algorithm SHA256
Get-Command $ActualOmp
Get-Process | Where-Object { $_.Path -eq $ActualOmp } | Select-Object Id, Path
```

Не запускайте `$ActualOmp`. Сверьте version/SHA-256 с A1 и snapshot, policy revision, isolation attestation, zero request/cost counters и отсутствие live credential в environment. В `preflight.json` зафиксируйте preflight ID, binary inventory, snapshot hash и `authorizationRef: "A1"`.

Stop/fail: missing A1 field/approval, expired window, hash/version mismatch, unsafe environment, non-zero counters или secret exposure → `BLOCKED`, не переходить к Phase 2. Безопасное состояние — остановить работу и сохранить только redacted preflight.

## Phase 2 — actual-binary launch (A1)

**Цель:** один bounded launch утверждённого actual `omp.exe` в изолированной среде с inert/fixture input и без live provider credential. A1 должен быть тем же, что в Phase 1; повторный запуск после stop требует новой авторизации.

Перед стартом проверьте A1, Phase 1 `PASS`, snapshot hash, pinned version/SHA-256, process ownership и zero/current counters. Используйте только путь и параметры, разрешённые A1; значения ниже — placeholders, их нельзя выполнять как есть:

```powershell
$ActualOmp = 'E:/<APP>/omp.exe'
$FixtureInput = 'E:/<PROJECTS>/<REDACTED_FIXTURE>'
$RunStarted = (Get-Date).ToUniversalTime().ToString('o')
$Process = Start-Process -FilePath $ActualOmp -ArgumentList @('<ALLOWLISTED_ARGS>') -WorkingDirectory 'E:/<PROJECTS>/<REDACTED_WORKDIR>' -PassThru -Wait
$ExitCode = $Process.ExitCode
$RunEnded = (Get-Date).ToUniversalTime().ToString('o')
"startedUtc=$RunStarted endedUtc=$RunEnded exitCode=$ExitCode pid=$($Process.Id)" |
  Add-Content evidence/m11-pilot/A1-actual-binary/run-log.txt
```

Перед выполнением замените `<ALLOWLISTED_ARGS>` и paths на реально утверждённые redacted/allowlisted значения; не добавляйте provider route или credential. Наблюдайте version/hash, process tree, start/exit, normalized result, egress counters и side effects. Raw stdout/stderr в репозиторий не копируйте.

Stop/fail: unexpected child, timeout, exit/result contradiction, side effect, unexpected egress или cap breach → остановить собственный процесс, записать `NOT PROVEN`/`BLOCKED`, не повторять. В `A1-actual-binary/` заполните `run-log.txt`, `side-effects.json`, `summary.json` и `integrity-hashes.txt`.

Безопасное состояние: завершите только свои процессы, сохраните snapshot и stop evidence; не удаляйте state и не меняйте production defaults.

## Phase 3 — native resume (A2)

**Цель:** один native resume ранее зафиксированного run без нового provider request. Перед фазой в `A2-native-resume/authorization.json` заполните и одобрите A2: scope/project, responsible, approver, credential class `none` и allowlisted route, числовые caps, UTC window и stop criterion. Требуется принятый Phase 2, immutable source-state hash и redacted linkage.

Команды PowerShell (подставьте только штатные allowlisted параметры):

```powershell
$State = 'E:/<PROJECTS>/<REDACTED_STATE>'
Get-FileHash $State -Algorithm SHA256
$Resume = Start-Process -FilePath 'E:/<APP>/omp.exe' -ArgumentList @('<NATIVE_RESUME_ARGS>') -WorkingDirectory 'E:/<PROJECTS>/<REDACTED_WORKDIR>' -PassThru -Wait
"observedUtc=$((Get-Date).ToUniversalTime().ToString('o')) exitCode=$($Resume.ExitCode)" |
  Add-Content evidence/m11-pilot/A2-native-resume/run-log.txt
Get-FileHash $State -Algorithm SHA256
```

Наблюдайте исходный `runId`/state hash, ровно одну resume attempt, before/after hashes, terminal result, отсутствие duplicate side effect и сети. Не копируйте state вручную и не подменяйте native resume transcript.

Stop/fail: отсутствует linkage, state изменён, создан новый несвязанный run, повторился side effect, появилась сеть или terminal state двусмысленен → stop, `NOT PROVEN`, при необходимости Phase 6. Безопасное состояние — остановить процесс, сохранить оба hash и не менять исходный state.

## Phase 4 — egress and OS-isolation proof (A3)

**Цель:** доказать deny-by-default isolation, разрешённый synthetic sink/control route и отсутствие unexpected egress. Перед фазой в `A3-egress-isolation/authorization.json` заполните A3 с security/OS owner и approver, credential class `none`, allowlisted route, числовыми attempt/byte/time caps, UTC window и stop criterion. Нельзя самостоятельно ослаблять ACL/policy.

Перед запуском получите environment и OS-isolation attestation (policy revision, namespace/ACL identity, allowlist). Запустите только bounded probe/fixture, разрешённый A3:

```powershell
Get-NetFirewallProfile | Select-Object Name, Enabled, DefaultOutboundAction
Get-NetTCPConnection -State Established,Listen | Select-Object LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess
# Далее — только утверждённая A3 команда control/synthetic probe:
& '<ALLOWLISTED_PROBE>' '<ALLOWLISTED_ARGS>'
$LASTEXITCODE
```

Наблюдайте destination class, direction, byte/request counters, policy decision, positive allowlisted path, negative unexpected-egress observation и teardown. Не сохраняйте packet payloads, headers, cookies или tokens.

Stop/fail: unexpected destination, DNS/proxy bypass, отсутствует attestation/telemetry, policy mismatch, side effect или превышен cap → немедленно остановите probe и не открывайте A4. В `A3-egress-isolation/` зафиксируйте normalized observations и `BLOCKED`/`NOT PROVEN`. Безопасное состояние — вернуть только собственную policy/process configuration по инструкции владельца, не удалять системные данные.

## Phase 5 — provider-route / pilot acceptance (A4)

**Цель:** минимальный заранее разрешённый live request по одному redacted route identifier после принятия Phase 1–4. Перед фазой в `A4-provider-route/authorization.json` заполните A4: scope/project, responsible, approver, cost approver, scoped/ephemeral credential class без значения, ровно один allowlisted route identifier, числовые cost/request caps, короткую UTC window и stop criterion. Credential value, raw URL, headers и cookies никогда не записывайте.

Проверьте принятые evidence и counters. Используйте только штатный CLI/API и параметры из A4; команды ниже являются формой записи, а не готовым endpoint/credential:

```powershell
$env:PROVIDERDOCK_ROUTE_ID = '<REDACTED_ALLOWLISTED_ROUTE_ID>'
# Credential должен быть введён штатным защищённым механизмом и не печататься:
& '<ALLOWLISTED_PROVIDER_COMMAND>' '<ALLOWLISTED_ARGS>'
$ExitCode = $LASTEXITCODE
"observedUtc=$((Get-Date).ToUniversalTime().ToString('o')) routeId=redacted exitCode=$ExitCode" |
  Add-Content evidence/m11-pilot/A4-provider-route/run-log.txt
Remove-Item Env:PROVIDERDOCK_ROUTE_ID -ErrorAction SilentlyContinue
```

До/после снимите request/cost counters; классифицируйте response без raw body; сравните expected/actual и оцените side effects. Не включайте retries, background refresh, tool expansion или production default changes.

Stop/fail: 401/403/429, 5xx/503, timeout, unexpected response shape, route drift, side effect, unexpected egress или cap breach → stop; `NOT PROVEN`/`BLOCKED`; после 503/5xx повтор запрещён. Безопасное состояние — завершить только собственные процессы, удалить только временное redacted значение из текущей сессии, сохранить snapshot и evidence; не отзывайте чужие credentials и не удаляйте пользовательские данные.

## Phase 6 — rollback observation

**Цель:** наблюдаемо вернуть утверждённые artifacts из immutable snapshot после завершения или остановки внешних действий. Новый A-gate не нужен. Перед фазой назначьте rollback owner/approver и убедитесь, что monitors ещё активны.

PowerShell:

```powershell
Get-FileHash .m11-snapshot/omp-integration.bundle -Algorithm SHA256
# Только после решения rollback owner: восстановление approved checkout в отдельный каталог
$RestoreRoot = 'E:/<PROJECTS>/<REDACTED_RESTORE>'
New-Item -ItemType Directory -Force $RestoreRoot | Out-Null
git clone .m11-snapshot/omp-integration.bundle $RestoreRoot
Get-Process | Where-Object { $_.Path -like 'E:/<APP>/*' } | Select-Object Id,Path
Get-NetTCPConnection -State Established | Select-Object RemoteAddress,RemotePort,OwningProcess
```

Сверьте source snapshot hash и restored artifact hashes, остановите только свои процессы, проверьте отсутствие residual egress и убедитесь, что user homes/archives не удалялись. В `phase6-rollback-observation/` укажите `rollbackDecision` (`not-needed|initiated|completed|blocked`), actor/approver, source/restored hashes, process/egress post-check и final status.

Stop/fail: snapshot mismatch, residual process/egress, повреждение user data или incomplete restore → ничего не удаляйте, сохраните состояние для rollback owner, status `NOT PROVEN`, эскалируйте. Восстановление из mutable copy или отсутствие post-restore observation не считается доказательством.

## Финал и публикация evidence

1. Во всех фазовых каталогах проверьте обязательные поля, redaction и SHA-256; `PASS` допустим только при полном schema и принятом gate. Добавьте только evidence и redacted snapshot metadata.
2. Убедитесь, что `git diff --check` не сообщает ошибок и в diff нет secrets, tokens, raw headers/cookies/transcripts, absolute user paths или live payloads.
3. Из корня checkout выполните:

```powershell
git status --short
git add evidence/m11-pilot
git diff --cached --check
git commit -m "docs(omp-migration): publish M11 pilot evidence"
git push origin omp-integration
```

4. Передайте hash нового commit, список фаз и итоговые `PASS`/`FAIL`/`NOT PROVEN`/`BLOCKED` Sunny. Sunny передаст evidence Astra на ревью. Не заявляйте внешний claim как принятый до этого ревью.

Если `git push` не проходит, сохраните точный exit code/ошибку в `phase6-rollback-observation/run-log.txt`, не переписывайте evidence и сообщите Sunny; он выполнит push сам. Этот runbook не разрешает commit/push вместо пользователя до окончания пилота, не разрешает cutover, удаление legacy или изменение production default.
