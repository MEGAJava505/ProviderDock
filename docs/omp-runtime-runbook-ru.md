# Управляемый OMP: сборка и проверка на Windows

Текущие незавершённые этапы и границы разрешений — в [REMAINING_PLAN.md](omp-migration/REMAINING_PLAN.md); порядок действий следующего агента — в [AGENT_HANDOFF.md](omp-migration/AGENT_HANDOFF.md). Датированные результаты ниже являются историческими checkpoint, а не действующим разрешением на запуск.

> Актуально на 23 сентября 2026: прежнее разрешение VSLLM на пилот
> приостановлено после независимого ревью. Live evidence/decision версии 1
> сохранены, но новый preflight отклоняет их кодом
> `OMP_MIGRATION_EVIDENCE_V2_REQUIRED`. Повторный локальный smoke на закреплённом
> OMP прошёл 18/18; свежий Doctor L3 не прошёл из-за квоты `glm-5.2-free`.
> Запасные модели тоже не подтвердили Responses-маршрут. Не запускать реальный
> OMP-пилот и не публиковать v2 decision до нового успешного Doctor L3.
> Подробности и SHA-256: [Step 4 mapping](omp-provider-mapping-2026-09-16.md).

Состояние: **16 сентября 2026, миграция выполняется, cutover не принят**. Прямой OMP-путь dashboard/CLI реализован, но реальные провайдерные пилоты не выполнялись. [Step 4: текущая офлайн-матрица профилей](omp-provider-mapping-2026-09-16.md) охватывает 18 профилей; все остаются `pending`.
Это продолжение [плана](superpowers/plans/2026-09-14-omp-migration-ru.md). Прямая интеграция dashboard/CLI реализована за явным выбором OMP, но это ещё не приёмка реальных провайдеров и не cutover.

## Что уже проверено

- Исходник: `unsigned-gg/omp`, commit `0c6c981ee5838d97700180383077eb0a3790637c`, package `18.0.4`.
- Portable Bun `1.4.0`; глобальный PATH не изменён.
- Настоящий OMP, не mock агента, обработал шесть локальных сценариев: Chat Completions / Responses / Messages, каждый без инструментов и с `read` → результат чтения → второй запрос → окончательный ответ.
- Для каждого сценария использованы только loopback HTTP, фиктивный ключ и тестовый проект с кириллицей/пробелами. Старые CLI и bridges не участвовали; платных inference-вызовов не было.
- Сначала эта матрица прошла на Bun/source и на **предварительном standalone**, имеющем ограничение native-зависимости ниже. Это не полная приёмка окончательной сборки.
- Компилятор выбранного маршрута, выдача только необходимых child-env credentials и вычисление provider/account-scoped путей: **121 regression-тест**, независимый review после исправлений принят.
- Runtime preflight/preparation: **26 regression-тестов** (включая RED до реализации и дополнительных safety fixes). Проверяет pin/checksum, cwd, mapping, storage layout, отсутствие непроверенных project settings, доступность ключа и подтверждение прав без запуска агента и без сети.
- **Дополнение:** точная native-сборка и повторная standalone-сборка завершены. Обновлённая матрица через **наш compiler + managed runtime** прошла все 6 сценариев на новом артефакте; проверяется фактическое наличие/отсутствие tools в запросе и отсутствие ключа во всех файлах run home.
- Run repository: 40 тестов, включая конкурирующие экземпляры, ошибки записи/fsync/rename, повреждённые записи и lifecycle. Независимое review принято.
- Настоящий RPC: ready → get_state → idle abort → stdin EOF, exit 0, **0 запросов к fixture upstream**, публичная проекция без ключа; raw private frames содержат authorization (см. ниже).
- Настоящий Windows ConPTY TUI: отрисован выбранный model ID и проект с кириллицей, Ctrl+D → exit 0, без timeout/cancel, onboarding и запросов к fixture upstream. Видимое тестовое окно не открывалось; это проверка TUI, не готового dashboard launcher.

## Важное ограничение предварительной сборки

NPM `@oh-my-pi/pi-natives-win32-x64@18.0.4` **не соответствует этому fork**, несмотря на одинаковый номер версии. В нём отсутствуют `DiffStream`, `rasterizeSvg`, `warmHighlighter`, объявленные нашим закреплённым исходником.

Предварительный executable сохранён как `.provider-dock/tools/omp-0c6c981ee583/omp-provisional.exe`; его нельзя использовать как совместимый production-артефакт.

Текущий `omp.exe` в том же каталоге пересобран с native из **точного исходника**:

- standalone SHA-256: `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`;
- native SHA-256: `76c41471f546f7d4818164e0d0c61aedc14a3bf6aa89ced2e38ab3a537ed1a90`;
- все 76 bindings, на которые ссылается JS, присутствуют; generated module имеет 87 exports, включая enums;
- tracked generated files после native/binary build совпадают с pinned Git source;
- одна source-built baseline-совместимая native-библиотека установлена под обоими именами variants, чтобы исключить загрузку старой;
- provenance — `artifact.json` рядом с executable; статус всё ещё `isolated-validation-not-production`.

Native build завершился с предупреждениями dead-code/linker/future compatibility, exit 0; они не заменяют чистую установку/полную security acceptance.

## Проверенные источники инструментов

| Артефакт | Источник | SHA-256 |
| --- | --- | --- |
| Bun archive | `https://github.com/oven-sh/bun/releases/download/bun-v1.4.0/bun-windows-x64-baseline.zip` | `b929c54a9badb104a16dedd23aab6152c86793ae653d4e6b13983ffd0c882a66` |
| Bun executable | распакован из указанного архива | `627d2e4775c24bdedee2cd7ccc18dcadae061e5345274ab6e3c4c797927bfb8f` |
| rustup-init.exe | `https://static.rust-lang.org/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe` | `6f4bef66261261fcb43131be8720bab817d403a09edec7455c371974b90bdb7e` |

Rust toolchain: `nightly-2026-08-08-x86_64-pc-windows-msvc`; rustc `1.99.0-nightly (1a98b1e13 2026-08-07)`.
Имеющийся Visual Studio 2022 BuildTools содержит C++/CMake/Ninja.

Большие caches/target/temp размещены на локальном фиксированном F:, поскольку на C: оставалось около 1,6 GB. Ничего не удалялось для освобождения места.

## Воспроизведение сборки

Рабочий checkout — `.scratch/omp`; сначала проверить `git rev-parse HEAD` и `git status --short`.
Не переключать автоматически на release другого репозитория.

1. Проверить SHA-256 portable Bun до запуска, добавить его каталог **только в environment команды**.
2. В checkout:

   ```text
   bun install --frozen-lockfile --ignore-scripts --filter @oh-my-pi/pi-coding-agent --filter @oh-my-pi/collab-web --filter @oh-my-pi/pi-natives
   ```

   Cache `BUN_INSTALL_CACHE_DIR` направить на достаточно вместительный локальный диск.
   Install scripts намеренно не выполняются автоматически; необходимые assets генерируются build-командами ниже.

3. Для native-build установить environment только процесса:

   ```text
   CARGO_HOME=F:\ProviderDockBuild\omp-0c6c981ee583\cargo
   RUSTUP_HOME=F:\ProviderDockBuild\omp-0c6c981ee583\rustup
   RUSTUP_TOOLCHAIN=nightly-2026-08-08-x86_64-pc-windows-msvc
   CARGO_TARGET_DIR=F:\ProviderDockBuild\omp-0c6c981ee583\target
   TEMP=F:\ProviderDockBuild\omp-0c6c981ee583\temp
   TMP=<тот же каталог>
   OMP_NATIVE_CARGO_PROFILE=ci
   RUSTFLAGS=-C target-cpu=x86-64-v2 -C target-feature=+crt-static
   ```

   На child PATH добавить portable Bun и `<CARGO_HOME>\bin`. Выполнить:

   ```text
   bun packages/natives/scripts/build-bindings.ts
   ```

   Скрипт выбирает имя `modern` по CPU хоста даже при baseline RUSTFLAGS. До упаковки проверить фактически полученный файл и не смешивать старую предварительную baseline-библиотеку с новой. Сравнить exports с закреплённым `native/index.js`; записать checksum и diff generated bindings.

   Windows PowerShell 5 + `$ErrorActionPreference='Stop'` + `*>` может превратить обычный cargo stderr в `NativeCommandError`. Для длинной сборки использовать Node child_process с перенаправлением stdout/stderr в файл, проверять реальный exit code; не перезапускать живую сборку из-за отсутствия вывода.

4. `BUN_COMPILE_EXECUTABLE_PATH` должен указывать на проверенный portable Bun. Выполнить:

   ```text
   bun packages/coding-agent/scripts/build-binary.ts
   ```

   Скрипт генерирует stats/tool-view/native assets, собирает standalone и возвращает временные tracked placeholders. После завершения проверить status, размер, checksum и `--version`.

5. Повторить проверку настоящего runtime **через наш compiler/preparation**:

   ```powershell
   npm run build
   node scripts/omp-runtime-smoke.mjs --executable "<полный путь к проверяемому omp.exe>"
   node scripts/omp-rpc-smoke.mjs --executable "<полный путь к проверяемому omp.exe>"
   node scripts/omp-tui-smoke.mjs --executable "<полный путь к проверяемому omp.exe>" --native "<полный путь к source-built native .node>"
   ```

   Эта обновлённая версия smoke сама хеширует **явно переданный тестовый** executable; production-регистрация обязана сравнивать с заранее записанной доверенной checksum. Отчёты — `.provider-dock/omp-validation/smoke-*`. Поиск утечек охватывает DB/WAL/SHM/config/logs, а не только `agent.db`.

## Контракт управляемого запуска

`src/clients/omp/omp-runtime.ts`:

- `preflight(selection)` возвращает безопасный результат/`OperationDiagnostic`, не раскрывает environment и не создаёт файлов.
- `prepare(runId, selection)` повторно проверяет артефакт и выдаёт **внутреннюю** process specification с ephemeral secrets. Объект нельзя сериализовать/возвращать browser API.
- Изменяемые конфиги находятся в свежем `<scope>/runs/<runId>/agent`; история — в provider/account-scoped sessions. Подмена конфигурации уже запущенного агента исключена новым каталогом.
- `HOME`/`USERPROFILE`, `PI_CODING_AGENT_DIR`, XDG и AppData направлены в managed run home. `PI_CONFIG_DIR` — относительное `config`: абсолютное значение неверно обрабатывается upstream через `path.join(os.homedir(), ...)`.
- Native loader использует отдельный XDG location; `<XDG_DATA_HOME>/omp` создаётся заранее.
- Из ambient environment исключены чужие API-ключи, legacy homes, proxy и NODE/Bun injection settings.
- `auto` без подтверждённого provider/account/model/origin mapping завершается `PROTOCOL_UNRESOLVED`, а не угадывает протокол.
- Выставлены `always-ask`, только `read`, выключены discovery/skills/extensions/LSP/MCP project config и retry. `startup.setupWizard`, `startup.checkUpdate`, `startup.showSplash` явно false. Это **не OS-песочница**: чтение вне проекта и сетевые возможности read не гарантированно ограничены. Поэтому требуется новое явное подтверждение `read-only-pilot-no-sandbox`; старые permissions не переносятся.
- Pinned OMP загружает project settings раньше выключения discovery. Поэтому пилот **отказывается запускаться при наличии непроверенных project settings** OMP/Claude/Codex/Cursor/Gemini/OpenCode: `OMP_PROJECT_SETTINGS_UNREVIEWED`. Даже безобидный конфиг пока требует отдельного явного импорта. Ни содержание, ни имя файла не изменяются; удалять оригиналы ради запуска не следует.

Проверка ссылок/junctions и свежие каталоги — защита от ошибочной конфигурации, не от злонамеренного локального процесса того же пользователя.

### Обнаруженные дополнительные риски

- Независимое review compiler выявило повторную интерпретацию raw-header secret upstream resolver-ом (command/env substitution), Azure URL rewrite и неверную обработку forward-slash UNC. Исправления приняты повторным review: небезопасный raw-header путь запрещён (официальный Anthropic native `x-api-key` остаётся), неподдержанный Azure Chat rewrite запрещён, UNC исправлен. Это сужает набор пока поддерживаемых маршрутов; такие реальные профили нельзя объявлять мигрированными.
- Настоящий RPC probe показал, что `get_state` возвращает resolved `Authorization` в `data.model.headers`. **Сырые RPC frames нельзя сохранять в диагностике или пересылать браузеру.** Они допустимы только в приватном канале дочернего процесса. Добавлен отдельный `omp-rpc-projection.ts`: только проверенные lifecycle-поля, совпадение request/provider/model, без model headers, prompts, tools descriptions и произвольного error text. Четыре regression-теста прошли RED → GREEN; проверка реального RPC дополнительно контролирует публичную проекцию и отдельно сообщает факт наличия секретов в private frames.
- В pinned CLI явный `--tools read` имеет приоритет над `--no-tools`. В smoke это обнаружено по настоящему запросу и исправлено удалением явного списка в zero-tool cases; assertions проверяют переданный upstream набор.
- Первый ConPTY probe застрял на setup wizard. Причина: новый home и отсутствующий флаг `startup.setupWizard=false`. Одновременно исправлен неверный `update.checkOnStartup`: такого setting в pin нет. Повторный probe прошёл после использования действительных `startup.*` настроек.
- Project `.omp/config.yml` может включить write-tier TTS и `tts: allow` поверх read-only флагов; malformed YAML может быть автоматически переименован upstream в `.broken-*` до tool approval. Preflight presence gate предотвращает оба пути до старта процесса, не пытаясь «починить» чужой конфиг.

### Интеграция dashboard, CLI и default composition

`src/application/omp-launch-service.ts` — это прямой seam поверх runtime и supervisора. Он не вызывает legacy Codex/Claude launchers и не маршрутизирует OMP через старые bridges.

Контракт запуска:

- Требуются явные `providerId`, `modelId`, `accountId` (OMP account), `projectDirectory` и отдельное подтверждение `read-only-pilot-no-sandbox`.
- `preflight()` обязателен перед `launch()`; неподтверждённый `auto`, auth, endpoint, protocol или artifact pin приводит к fail-closed результату.
- Публичные результаты содержат только sanitized `OperationDiagnostic`; `prepare()`, child environment, argv, raw RPC frames, stderr и секреты не покидают сервер.
- Default composition: `createDefaultProviderDock()` / `createDefaultProviderDockAsync()` возвращают `.application` и `.ompLauncher`; прежние `createDefaultApplication()` APIs остаются source-compatible и возвращают только application.
- OMP runtime использует `<data-root>/runtime/omp`, run repository — `<data-root>/runtime/omp-runs`.
- Composition регистрирует только pinned артефакт `.provider-dock/tools/omp-0c6c981ee583/omp.exe` с SHA-256 `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba` и source commit `0c6c981ee5838d97700180383077eb0a3790637c`. `omp-provisional.exe` не используется.

CLI:

```powershell
providerdock launch omp `
  --provider PROVIDER_ID `
  --model MODEL_ID `
  --omp-account ACCOUNT_ID `
  --project DIRECTORY `
  --omp-read-only-pilot-no-sandbox
```

Успешный вывод — только `OMP run started: <runId>`. Неуспешный preflight/launch — только `OMP <phase> failed: <CODE>: <safe message> [<operationId>]`. Флаг `--approval` не заменяет отдельное OMP-подтверждение.

Dashboard API:

```text
POST /api/omp/preflight
POST /api/omp/launch
GET  /api/omp/runs
POST /api/omp/runs/<runId>/cancel
```

API использует Zod-валидацию, перезапускает reconciliation и возвращает копии записей с sanitized diagnostics. UI показывает OMP-аккаунт и отдельное подтверждение; preflight включается только после заполнения маршрута, submit — после успешного preflight и подтверждения, изменение модели сбрасывает preflight. OMP использует только `api/omp/launch` и `api/omp/runs`, без legacy `POST api/launches`.

Финальная локальная матрица 15 сентября прошла: `omp-launch-service` — **1 файл / 6 тестов**, `provider-dashboard-omp` — **1 файл / 7 тестов**, `provider-dock-cli` — **1 файл / 16 тестов**, `default-omp-composition` — **1 файл / 1 тест**, `npm test` — **86 файлов / 841 тест**, `npm run typecheck`, `npm run build`, `node scripts/dashboard-ui-smoke.mjs` и `git diff --check`. Step 3 закрыт по локальной реализации/верификации; миграция остаётся открытой до mapping реальных профилей, согласованных пилотов, импорта истории, portal recovery и cutover.

### Контракт supervisора процесса

`src/clients/omp/omp-process-supervisor.ts`:

- Повторно выполняет `preflight()`, создаёт запись через `OmpRunRepository` и только сервер-side вызывает `prepare()`.
- TUI запускается с `stdio: "inherit"` и доходит максимум до `TERMINAL_OPEN`; READY без RPC-evidence не заявляется.
- RPC использует закрытые pipe, ограничение строки 2 MiB, безопасную проекцию control-frames и записывает только sanitized diagnostics.
- READY означает полученный `ready` frame (protocolVersion 1); затем отправляется `get_state`, а валидный `state` переводит запуск в `RUNNING` с безопасным sessionId.
- Отмена RPC отправляет `abort` и stdin EOF, ждёт grace и останавливает только собственный child; TUI отменяется немедленно. Итог — `CANCELLED`.
- Перезапуск дашборда через `reconcileAfterRestart()` помечает непристроенные активные записи как `INTERRUPTED` / `OMP_SUPERVISOR_OWNERSHIP_LOST`; поздние события старого supervisor не перезаписывают terminal state.
- Фейковые child-процессы покрывают spawn error, early exit, timeout, успешную инициализацию, поздний отказ, отмену и рестарт. Реальный TUI smoke перепроверен после добавления `rpcModel`: exit 0, zero upstream requests, secret-free output, no onboarding. Runtime и RPC smokes также перепроверены.

## Что остаётся до рабочего перехода

- Clean-machine/полная compatibility/security acceptance source-matched сборки (основная шестисценарная матрица уже прошла).
- Реальные TUI и RPC lifecycle acceptance в интегрированном dashboard/CLI пути; отдельные RPC/TUI smokes уже прошли, но не заменяют приёмку.
- Полная security/retry/tool acceptance; пока не включать shell/write/task/eval/MCP/extensions.
- Перенос истории по явным source roots с отчётом и provenance; оригиналы сохранить.
- Quiescent verified backup после остановки writers и staged recovery порталов. Текущий core manifest — **inventory, не такой backup**.
- Проверка всех фактически настроенных профилей и отдельно согласованные реальные пилоты.
- Только после этих gates — OMP-only cutover и удаление активного legacy-кода. Установки/пользовательские homes не удалять «заодно».

Актуальный read-only inventory на **16 сентября**: **18 providers / 36 файлов protected secrets** (10 Chat / 7 auto / 1 Messages). Значения 17/35 из handoff 15 сентября больше не актуальны; дополнительный профиль не отброшен. `accounts.json` по-прежнему 280047 NUL bytes, SHA-256 `88894e28ee6b8da1255d95b5cd2ada7e2729eae5d6fa90a6a3179f4d0f686e43`; не заменялся. Число сессий заново не подтверждалось.

### Step 4: офлайн-матрица, не приёмка реальных провайдеров

Отчёт: `docs/omp-provider-mapping-2026-09-16.md`; source/manifest/fingerprints:
`.provider-dock/omp-mapping-2026-09-16-ExxykD/`.
Повторная проверка подтвердила неизменность 38 allowlisted source files и assessments после review-fixes.
Ни один ключ не расшифровывался; account IDs, approved origins и portal associations не назначались.

Новый actual-binary smoke прошёл **16/16 локальных сценариев** для восьми настроенных model IDs.
Только собственный loopback fake upstream, fixture keys и homes на F:; остальные 10 профилей явно skipped.
Это не remote compatibility, не подтверждение capabilities и не разрешение реального inference.
Текущие блокеры: 7 unresolved auto, 3 из них также unsupported static headers; сторонний Messages `x-api-key` у `justwoker-2`; 2 явных Chat-профиля без выбранной модели.
Для всех 18 нужны явные identity/origin/capability decisions перед отдельным разрешением пилота.

### VSLLM: разрешённый маршрут пилота на 23 сентября 2026

Первый точный маршрут прошёл все gates до запуска процесса:

```text
providerId: vsllm
accountId: 16568
baseUrl: https://vsllm.cc/v1
origin: https://vsllm.cc
modelId: glm-5.2-free
protocol: openai-responses
capabilities: text, streaming, tools
```

Doctor level 3 прошёл четыре согласованных inference-запроса; actual-binary
loopback smoke прошёл оба сценария для этой пары; production OMP preflight
вернул `api=openai-responses`. Evidence и decision находятся в
`<data-root>/migration` и читаются fail-closed.

Это разрешение **на pilot**, а не завершённая миграция. Следующая граница —
фактический одноразовый запуск OMP, который снова обращается к платному
провайдеру. До отдельного решения не выполнять его автоматически и не удалять
legacy runtime, историю или пользовательские homes.

### Обновление после ревью: evidence версии 2

Прежние live-файлы evidence и route-decision версии 1 сохранены, но новый
preflight их не принимает и возвращает `OMP_MIGRATION_EVIDENCE_V2_REQUIRED`.
Для нового решения требуется отдельный сохранённый результат Doctor level 3
с отпечатком конфигурации и ссылки на выбранный ключ. Проверяются точные
провайдер, модель, протокол, время, PASS и возможности text/streaming/tools.
Повторный локальный smoke на закреплённом OMP прошёл 18/18 сценариев; v2
evidence подготовлено в assessment-каталоге. Следующая операция с VSLLM —
новый Doctor level 3 для получения отпечатка; его четыре inference-запроса
требуют отдельного разрешения. После него можно собрать v2 route-decision,
опубликовать оба live-файла и повторить preflight.

## Восстановление после crash-lock (ручная процедура оператора)

Оба on-disk замка **fail-closed**: удерживаемый замок никогда не забирается
автоматически. Писатель ждёт до busy-timeout, затем бросает ошибку с **точным**
путём замка и секрет-независимой инструкцией. Данные при этом не меняются.

- **Реестр ключей** — `FileCredentialMetadataRepository`: замок это каталог
  `<registry>.json.lock` с маркером `owner.json` (`{ownerId, pid, acquiredAt}`).
  Ошибка: `CredentialRegistryLockError` — «…the lock at '<path>' was held for the
  whole wait and is never reclaimed automatically. No changes were made. Retry;
  if no ProviderDock process is running, the owner crashed — remove that lock
  directory manually to recover. It holds no account data or secret.»
- **Порталы** — `FilePortalRepository`: замок это файл `<accounts>.json.lock`.
  Ошибка: `PortalRepositoryLockError` — «Portal account store is locked by
  another writer ('<path>'). No changes were made. Retry; if no ProviderDock
  process is running, delete that lock file to recover — it holds no account
  data or secret.»

Процедура (не автоматизировать; не удалять живой или неизвестный замок):

1. **Повторить операцию.** При кратковременной конкуренции второй писатель
   пройдёт после освобождения замка; повтор — первое и обычно достаточное
   действие.
2. **Проверить писателей.** Убедиться, что не выполняется ни один процесс
   ProviderDock (CLI, dashboard, supervisor). Если есть сомнение — считать замок
   живым и НЕ трогать: crashed-owner неотличим от живого преемника, занявшего
   замок в промежутке.
3. **Сохранить при сомнении.** Не изменять данные и сам замок, пока живой
   писатель не исключён доказательно.
4. **Удалить только названный замок.** Только при доказанно остановленных
   процессах удалить именно тот путь из сообщения (каталог `…lock` для реестра,
   файл `…lock` для порталов). Замок не содержит ключей или данных аккаунта.
5. **Повторить и проверить хранилище.** Повторить операцию и убедиться, что
   `list()` реестра/порталов читается штатно.

Замечание об атомарности: managed-import порталов и vault не разделяют общую
транзакцию. Частичный сбой не «чинится» молча — сервис возвращает явный
`PORTAL_IMPORT_RECOVERY_REQUIRED`, и восстановление выполняется по шагам выше,
без предположения об атомарности между portal-файлом и секрет-хранилищем.
