# Полный переход с Codex CLI / Claude Code на OMP — Implementation Plan

> **Историческая заметка:** план первоначально исполнялся по этапам с тестами и контрольными точками; теперь он хранится как история проектных решений, а не как задание агенту.

> **Исторический план:** флажки и строка «следующий шаг» ниже не являются текущей очередью. Актуальные этапы и условия остановки — в [подробном плане оставшейся работы](../../omp-migration/REMAINING_PLAN.md); перед действием сверь код и доказательства.

**Goal:** Сделать OMP единственным рабочим coding-agent, устранить непрозрачные ошибки интерфейса и убрать зависимости ProviderDock от Codex CLI / Claude Code, не потеряв провайдеров, секретов и историю.

**Architecture:** OMP выполняет агентный цикл и напрямую обращается к провайдерам. ProviderDock становится небольшой управляющей оболочкой: кабинеты, баланс, DPAPI, настройка моделей, запуск OMP и диагностика. Старые CLI и конвертирующие мосты не остаются в конечном рабочем маршруте.

**Tech Stack:** Существующий TypeScript / Node.js / Vitest / локальный web dashboard / Windows DPAPI; отдельно установленный и зафиксированный OMP. Способ поставки OMP и его зависимости проверяются до интеграции.

**Spec:** Раздел [«Целевая архитектура»](#architecture) этого документа; первоисточники OMP — [исследование возможностей и ограничений](../../research/omp-migration-capabilities-2026-09-14.md).

**Статус на 15 сентября 2026:** пользователь утвердил выполнение после ошибки Responses `namespace`; миграция выполняется в `feat/omp-migration`, но ещё не завершена. Уже реализованы безопасные recovery helpers, compiler/child credentials, часть UI-диагностики и preflight; OMP проверяется в изолированной установке. Dashboard пока не переключён на OMP. Текущие факты и ограничения — [runtime runbook](../../omp-runtime-runbook-ru.md); checkpoints — `.superpowers/sdd/2026-09-14-omp-migration-ru/progress.md`. Токены, исходные transcripts и активный повреждённый файл не заменялись.

**Обновление 15 сентября 2026:** пользователь отдельно запросил временно вернуть рабочий Codex через ProviderDock для передачи миграции другому агенту. Применён и собран ограниченный hotfix общего `protocolResolver`: ожидаемая portal corruption больше не блокирует независимый inference. Читать первым [актуальный статус, проверки и ограничения](../../instant-cli-failure-diagnosis-ru.md#читать-первым-текущее-состояние-исправления). 16 новых regression-тестов и весь набор `tests/` (536 тестов) проходят. Это **не выполнение миграции**, не восстановление аккаунтов и не проверка платных провайдеров.

## Глобальные ограничения

- «Отказ от Codex / Claude Code» означает отказ от их **приложений, launcher-ов, runtime-конфигов и bridge-зависимостей**, а не от моделей OpenAI / Anthropic или оплаченных аккаунтов.
- Нельзя исправлять повреждённое хранилище автоматической записью пустого списка.
- Не удалять оригинальные секреты, `~/.codex`, `~/.claude`, provider-scoped homes и исходные transcripts в ходе импорта.
- API-ключи и cookies не попадают в Markdown, `models.yml`, Git, аргументы процесса, browser storage и диагностические выгрузки.
- Не создавать общую базу, в которой ProviderDock напрямую меняет внутренние таблицы `agent.db` OMP.
- Один владелец обновления каждого OAuth refresh token. Не запускать независимые refresh-процессы над одной копией credentials.
- Не считать `ask / auto / full-auto` переносимыми настройками без проверки семантики и реальной изоляции Windows.
- Не менять production-код до отдельного утверждения реализации. Имеющиеся незакоммиченные изменения пользователя сохраняются.
- Платные inference-проверки — отдельный согласованный этап с ограничением числа запросов и стоимости; открытие dashboard не запускает их.
- Не обещать, что смена агента устранит ограничения аккаунта, отказ upstream, 401/403/429 или несовместимость конкретного API.

---

## 1. Решение в одном абзаце

**Рекомендован полный переход на OMP, но не выбрасывание всего ProviderDock.** Нужно удалить специфичный для двух старых CLI слой, а полезные функции управления сохранить. Конечная схема: **наш dashboard → OMP → API провайдера**, а не **наш dashboard → OMP → старый bridge → API**. Временный параллельный контур допустим только во время проверки; у него есть критерии окончания. В финале Codex CLI и Claude Code не нужны ни для запуска, ни для новых сессий, ни для авторизации API-key провайдеров.

### Сравнение вариантов

| Вариант | Что получаем | Почему выбран / отклонён |
| --- | --- | --- |
| Только OMP, полностью удалить ProviderDock | Минимум собственного кода | Потеряем текущие portal adapters, привычный баланс/витрину и DPAPI-контур. Возможен только при явном отказе от этих функций |
| **OMP + облегчённый ProviderDock** | Один агент; сохраняем управление аккаунтами и безопасность существующих ключей | **Рекомендован**. Убирает именно источник сложности: два клиента, два runtime и протокольные переходы |
| OMP поверх старых bridges как постоянная схема | Меньше первой работы | Оставляет прежние ошибки маршрутизации/трансляции. Не отвечает цели полного отказа |

## 2. Фактическая исходная точка

### Что перепроверено сейчас

- `C:\Users\megaj\.provider-switcher\portals\accounts.json`: **280 047 байт, ненулевых байтов 0**, JSON невалиден.
- `providers/providers.json`: валидный массив, **16 включённых профилей**.
- Среди них: 10 профилей с явным Chat Completions, 1 с явным Anthropic Messages, **5 с `apiType: auto`**.
- В этих 16 профилях нет `secretHeaders` и дополнительных `queryParameters`. Это упрощает первую миграцию, но их поддержку нельзя молча потерять для будущих профилей.
- Проверка типов и сборка проходят. Выбранные 6 файлов тестов: **87 тестов проходят**.
- Более широкий запуск только наших `tests/`: **519 passed / 1 failed**. Сбой — `ENOTEMPTY` при cleanup в `claude-launcher.test.ts`; повторный запуск этого одного теста прошёл. Это признак нестабильной проверки, а не доказательство устранения ошибки.
- Воспроизведены дефекты отображения ошибок на изолированных fixtures, без обращения к реальным провайдерам.

### Что принимается из предыдущей диагностики, но не повторялось

- 34 файла секретов существуют и успешно расшифровываются DPAPI.
- Найдено 53 agent-сессии.
- `.corrupt-*.bak` также заполнены нулями.

Не выдаём эти три пункта за новый полный аудит. Перед реальной миграцией повторно считаем данные и создаём проверяемый manifest.

### Важное исправление предыдущей заметки

В [старой оценке OMP](../../omp-assessment.md) раздел 1 и заключение предполагают mismatch путей и отсутствие повреждения. Это **не соответствует текущей проверке `accounts.json`**. При реализации эту заметку надо пометить устаревшей либо исправить отдельным изменением; в настоящем плане она не является источником вывода о сохранности portal-метаданных.

Нулевой файл нельзя восстановить обычным JSON-parser. Наличие DPAPI-секретов не восстанавливает автоматически связи `providerId → siteUrl → adapterId → secretRef → userId`.

**Не установлено:** кто и когда занулил файл. В текущем `FilePortalRepository` запись идёт через временный файл и rename; это не доказательство устойчивости к любому сбою и не доказательство виновности этого кода. Нужны отдельные проверки долговечности записи, нескольких процессов и внешних вмешательств.

### Что реально умеет OMP и где ограничения

Проверенный `main` совпал с `0c6c981ee5838d97700180383077eb0a3790637c`. Ниже — результаты чтения исходников, не испытание установленного OMP. Точные pinned-ссылки и schema находятся в [исследовании](../../research/omp-migration-capabilities-2026-09-14.md).

| Возможность | Подтверждение и значение для нас |
| --- | --- |
| Полноценный агент | TUI, print/headless, инструменты работы с файлами и shell, LSP, MCP, extensions, собственные subagents. Старые CLI ему для этого не нужны |
| Программная интеграция | SDK, собственный NDJSON RPC/RPC-UI, ACP. **SDK требует Bun ≥ 1.3.14**, не просто наш существующий Node-host. Поэтому первый adapter — отдельный процесс |
| Провайдеры | OpenAI/Anthropic/Gemini и другие; custom providers. Chat Completions называется в OMP **`openai-completions`**, не нашим `openai-chat-completions` |
| Fallback / accounts | Есть model fallback, auth rotation, stickiness; у разных слоёв свои retries. Это не готовая гарантия безопасных повторов и соблюдения нашего бюджета |
| Сессии | Собственные JSONL, импорт Claude/Codex transcripts. **Default Codex importer игнорирует `CODEX_HOME`**: нужен explicit-root путь для наших isolated homes |
| Статистика | Есть **собственный web dashboard `omp stats`** и provider usage. Но они не заменяют наши произвольные portal logins, wallet balances и recovery |
| Windows | Есть target standalone Windows x64 executable со встроенным Bun runtime; отдельный Bun для такого binary не обязателен. Native addons и CPU/shell всё равно требуют проверки |
| Поставка указанного fork | У `unsigned-gg/omp` на момент проверки нет releases, а installer указывает на **`can1357/oh-my-pi`**. Нельзя установить этот binary и назвать его сборкой выбранного SHA без проверки |
| Хранение credentials | `agent.db` хранит credential JSON в обычном SQLite **без шифрования payload**. Это не замена DPAPI |
| Разрешения | Schema-default — **`yolo`**; subagents получают `yolo` с сохранением per-tool policies. `always-ask` автоматически разрешает чтения. Extensions работают без sandbox в процессе |
| Повторы MCP | После некоторых connection failures tool wrapper reconnect-ится и повторяет вызов с теми же аргументами, не доказывая отсутствие первого побочного эффекта |

**Следствие:** OMP подходит по набору возможностей, но утверждать «переход уже безопасен» нельзя. Главные контрольные точки — права/изоляция, источник Windows-артефакта, защита credentials и повторы tools.

## 3. Найденные проблемы интерфейса и ошибок

Ссылки на строки относятся к рабочему дереву на дату аудита, включающему существующие изменения пользователя.

| Приоритет | Подтверждённый дефект | Доказательство | Требуемое поведение |
| --- | --- | --- | --- |
| **P0** | **Оба CLI получают локальный 500 после отправки сообщения из-за повреждённых portals** | Общий `protocolResolver` в `src/application/create-default-application.ts:257–260` читает `accounts.json` через `Promise.all` перед upstream. На NUL fixture оба моста в режиме `auto` возвращают 500 за 9–47 мс, upstream calls = 0 | Независимый от portal corruption inference routing; понятный local diagnostic при unresolved протоколе, без обвинения upstream |
| **P0** | Ранние ошибки protocol resolution не попадают в runtime health | При отказе `openUpstream()` переменная `selectedForHealth` ещё не задана; catch обоих bridges пропускает запись | Отдельная pre-dispatch диагностика с `origin=local`, этапом и `upstreamAttempted=false` |
| **P0** | Повреждение кабинетов выглядит как отсутствие аккаунтов | `src/ui/provider-dashboard-server.ts:834–840` возвращает пустые portals при corruption; `portalStatus` передаётся на строках 824–828, но browser script его не читает. В браузере показано «Вход: Не настроен», «Нет подключения» | Отдельный постоянный баннер «Метаданные кабинетов повреждены». Ключи, провайдеры и история не объявляются исчезнувшими |
| **P0** | Причина моментального отказа модели теряется | `ModelDisabledError` и `ModelUnavailableError` меняют `name` в `src/core/providers/model-access.ts:7–38`; whitelist в `provider-dashboard-server.ts:1311–1357` знает `ProviderRequestError`, но не эти имена | Понятные коды `MODEL_DISABLED` / `MODEL_NOT_AVAILABLE`, название модели, этап проверки и действие пользователя |
| **P0** | Обычные ошибки запуска превращаются в безликую фразу | `publicErrorMessage()` возвращает `The requested operation failed unexpectedly.`; ошибка не содержит диагностического ID | Безопасное сообщение + код + этап + ID записи. Полные credentials и сырые upstream payload не раскрывать |
| **P1** | Ошибка одного раздела блокирует обновление всего UI | `src/ui/provider-dashboard-script.ts:56`: `Promise.all(snapshot, launches, agent-sessions)`. Fixture: snapshot 200 с провайдером, sessions 500, карточек в браузере 0 | Независимые результаты разделов, сохранение последнего успешного состояния, локальная ошибка истории вместо «нет подключения» ко всему |
| **P1** | Exit code 1 выглядит как штатное завершение | `provider-dashboard-server.ts:894–902` всегда пишет `EXITED` при fulfilled promise. `provider-dashboard-script.ts:153` считает только `FAILED` ошибкой | `SUCCEEDED` только при успешном результате; ненулевой exit → `FAILED`, сигнал/отмена → отдельное состояние |
| **P1** | Видимое окно принимается за готовность агента | Windows wrapper сообщает `PROVIDERDOCK_READY` после появления shell/window; приложение может ещё не пройти инициализацию | Разделить «процесс создан», «окно открыто», «агент готов», «первый ответ». Не обещать готовность модели по факту окна |
| **P1** | Часть причин terminal failure недоступна dashboard | В `src/clients/agent-terminal-process.ts` у Windows wrapper stderr стоит `ignore`; ошибка до startup acknowledgement сводится к коду выхода | Отдельный структурированный канал startup/exit и ограниченный редактированный diagnostic tail |
| **P1** | Ключ кабинета может выглядеть неиспользуемым | `providersUsingSecret()` в `provider-dashboard-script.ts:148` проверяет только API auth/secretHeaders, не portal connections | Учёт всех потребителей секрета. При повреждённых метаданных статус «использование неизвестно», а не «не используется» |
| **P2** | Испорчена подпись настройки безопасности | `src/ui/provider-dashboard-html.ts:177` содержит буквальное `???????????? ???????????`; подтверждено screenshot | Читаемое «Использовать сохранённую настройку», тест видимого текста и UTF-8 |
| **P2** | Слишком много понятий старых клиентов в основном сценарии | Автовыбор по `claude/gpt/...` в `src/core/providers/automatic-client.ts`, вкладки маршрута и client-specific flags | Один OMP; пользователь выбирает проект, провайдера, аккаунт и модель. Протокол — свойство модели, не выбор CLI |

### Что именно доказано о «моментальной ошибке»

**Дополнение после уточнения пользователя:** ошибка возникает не при открытии CLI, а при отправке сообщения. Для этого сценария найден и воспроизведён **общий локальный дефект**: `accounts.json` → `protocolResolver` → `PortalRepositoryCorruptionError` → HTTP 500 обоих bridges, **до любого upstream-вызова**.

Контроль **до hotfix**: тот же production-код с валидным тестовым metadata-файлом даёт 200 и один mock upstream-вызов; с NUL — 500 и ноль. После hotfix оба варианта дают 200 и один вызов. Проверены streaming/non-streaming запросы. [Подробная диагностика, команды и ограничения вывода](../../instant-cli-failure-diagnosis-ru.md).

Этот путь вызывается для незакэшированного `apiType: auto` — сейчас таких профилей 5 из 16. Явный Chat Completions в контрольных тестах проходит. Поэтому нельзя объявлять объяснённым каждый исторический отказ любого профиля. Точное сообщение установленного Codex о «перегрузке серверов» отдельно не воспроизводилось: подтверждён ответ 500 его локального endpoint.

**Отдельный, ранее выявленный дефект запуска:**

На реальном методе `ProviderDockApplication.launchCodex()` с выключенным fixture-провайдером:

```text
providerCalls: 0
launch.status: FAILED
launch.errorMessage: The requested operation failed unexpectedly.
```

Причина **есть** — локальная проверка запрещает запуск, — но слой представления её скрывает. Такой же дефект mapping распространяется на `ModelUnavailableError`. Это другой класс отказов и не объяснение уточнённого сбоя после отправки сообщения.

В сохранённой runtime health-истории есть `PROVIDER_UNAVAILABLE`, `INVALID_REQUEST` и `PERMISSION_ERROR`. Для связывания конкретного отказа с нажатием кнопки не хватает единого `runId`/этапов запуска; старые записи нельзя выдавать за диагноз сегодняшнего случая.

Дополнительный риск для отдельного теста: `modelCatalogFor()` использует `latest` discovery как авторитетный источник без явной проверки свежести в этом методе (`provider-dock-application.ts:943–997`). Проверить устаревший каталог и изменение конфигурации, прежде чем использовать его как блокирующий preflight.

### Результат browser smoke

Команда `node scripts/dashboard-ui-smoke.mjs` **не проходит**:

1. Fixture не настраивает session history, `/api/agent-sessions` возвращает 500, общий `refresh()` не показывает успешно загруженные провайдеры.
2. После добавления только в временную fixture `listAgentSessions: async () => []` обнаружилось устаревшее ожидание числа header-кнопок: ожидается 3, фактически 2.

Это одновременно выявило UI-coupling и отставание smoke от текущего интерфейса. Это **не** доказательство, что default application забывает настроить session history.

Отдельный укороченный browser harness прошёл нужные экраны на mock-данных: подтверждены отсутствие corruption-баннера и испорченная подпись approvals; browser exceptions — 0. Полный smoke от этого не стал проходящим.

Обнаружена также проблема границ тестового запуска: простой `npm test` захватывает чужие Bun-тесты из уже существующего `.scratch/omp`; этот запуск остановлен. Нельзя считать такие import/collection failures дефектами runtime ProviderDock или результатом проверки OMP. До настройки Vitest использовать явное исключение `.scratch/**`.

---

<a id="architecture"></a>

## 4. Целевая архитектура

```text
ProviderDock UI
  ├── Providers / Models / Accounts / Balance
  ├── Recovery / Diagnostics / Sessions
  └── OmpRuntime
       ├── preflight и supervised launch
       ├── компиляция НЕсекретного models.yml
       ├── ограниченная выдача API credentials из DPAPI
       └── omp → выбранный API провайдера напрямую

DPAPI vault ── API keys / portal credentials
PortalRepository ── связи аккаунтов и наблюдения кабинета
OMP own storage ── свои сессии, настройки и, при отдельном выборе, OAuth
Legacy transcripts ── read-only input однократного importer-а
```

### 4.1. Разделение ответственности

**Оставляем у ProviderDock:**

- каталог наших провайдеров, явные model IDs и правила доступности;
- portal adapters New API / nofx / helyx, связь с кабинетом, баланс, цены, cache observations;
- существующий DPAPI-vault и безопасный импорт credentials;
- профили проектов/инструкций, но без flags двух старых CLI;
- понятный запуск, статус, recovery и отчёт миграции.

**Передаём OMP:**

- агентный цикл, вызовы моделей, инструменты и агентную историю;
- TUI и программные режимы;
- работу с custom providers через его собственную конфигурацию;
- собственные механизмы авторизации, аккаунтов и fallback — только после проверки их нужной семантики.

**Не строим второй coding-agent или собственный web-chat в рамках перехода.** Первая интеграция запускает OMP TUI. RPC/ACP использовать для задач, которым действительно нужен machine-readable interface; не заставлять пользователя ждать полной реализации chat UI.

### 4.2. Конфигурация и секреты

1. `providers.json` остаётся источником настроек нашей оболочки на время перехода.
2. Компилятор создаёт отдельный, версионированный `models.yml` для управляемого OMP home. Не правит вручную пользовательский `~/.omp`.
3. Для каждого профиля — устойчивый уникальный OMP provider ID. Одинаковая строка model ID на разных gateways не означает один аккаунт.
4. Пять `apiType: auto` сначала классифицировать на fixture/pilot. Не назначать протокол по словам `claude` или `gpt`.
5. Для API keys — ссылка на переменную среды в конфигурации; значение подставляется только в окружение дочернего OMP из DPAPI. Перед spawn проверять наличие значения, чтобы отсутствующая переменная не стала буквальным ключом.
6. В окружение попадают только credentials выбранного маршрута или согласованной fallback-цепочки, не все 34 секрета. Portal cookies OMP не нужны.
7. Не использовать `--api-key <секрет>`, глобальные environment variables, plaintext `.env` или копирование всех ключей в `agent.db`.
8. Shell-resolver `!command` рассматривать только после проверки Windows shell/quoting и allowlist команд; это не более безопасная альтернатива автоматически.
9. Провести аудит приоритета OMP config: project config, extensions, env и auto-discovery не должны незаметно заменить выбранный endpoint/account.

Пример формы конфигурации, **только фиктивные данные**, не готовый экспорт реального аккаунта:

```yaml
providers:
  dock-example:
    baseUrl: https://gateway.invalid/v1
    api: openai-completions
    apiKey: PROVIDERDOCK_OMP_EXAMPLE_KEY
    models:
      - id: example-model
```

Имя env указывается буквально, не `${ENV}`. Цепочки `retry.fallbackChains` принадлежат settings `config.yml`, а не root `models.yml`. Compiler обязан разделять эти файлы.

DPAPI защищает ключи **на диске**, но не от процесса, которому их уже передали. Инструменты OMP и дочерние shell-процессы могут иметь доступ к окружению. Это надо отразить в модели угроз и проверке разрешений, а не называть полной изоляцией.

### 4.3. OAuth и провайдеры OpenAI / Anthropic

- Использование моделей OpenAI/Anthropic через OMP не требует сохранения старых CLI в архитектуре.
- Доступность конкретного OAuth flow, подписки и модели проверяется отдельно. Наличие исходника OAuth не гарантирует доступ к любому тарифу.
- Первую миграцию существующих API-key профилей не блокировать необязательным переносом OAuth.
- При включении OAuth предпочтителен отдельный вход средствами OMP, а не копирование refresh tokens из native homes.
- В проверенном OMP credential payload в SQLite не зашифрован. До включения OAuth принять защищённое at-rest решение, проверить Windows ACL, DB/WAL/backup и владельца refresh; при неприемлемом риске этот путь не включать.
- Не добавлять auth-broker/gateway только потому, что он есть в OMP. Для одного Windows-пользователя это дополнительный процесс и контур защиты; вводить при доказанной необходимости.
- Broker snapshot не является «безопасным публичным списком»: из него удаляется refresh token, но остаются access tokens / API keys. Не отправлять snapshot в dashboard.

### 4.4. Fallback и безопасность действий

Нельзя одновременно оставить автоматический retry/fallback в старом bridge и включить его в OMP: получится два независимых владельца повторов.

В конечном контуре владелец inference fallback — OMP. До включения проверить:

- 401/403 и неправильную модель не лечим бесконечными повторными запросами;
- 429/5xx до полезного вывода допускают ограниченный retry с видимой причиной;
- после выданного tool call/возможного побочного эффекта нет слепого повторного исполнения;
- отмена действительно останавливает запрос и дочерние процессы;
- переключение аккаунта не меняет выбранного провайдера/проект скрытно.

Если эти свойства не подтверждены, первая версия работает **без автоматического fallback**, а не маскирует риск старым мостом. Старые anti-replay тесты превращаются в требования к OMP-интеграции.

Отдельно проверить **внутренние** повторы provider SDK/auth и MCP: отключение AgentSession fallback не отключает их автоматически. Для consequential MCP tools без идемпотентности — deny до решения о дедупликации/отключении такого retry. Внешний wrapper не повторяет весь RPC prompt при потере ACK.

## 5. Что именно убрать, оставить и переделать

| Действие | Точные области | Условие |
| --- | --- | --- |
| **Удалить** | `src/clients/codex/`, `src/clients/claude/` | OMP launch/resume прошли acceptance |
| **Удалить** | Codex runtime config/session/shim/model catalog; `justworker-codex-bridge/` | Нет пользователей старого bridge, включая отдельные scripts |
| **Удалить** | `src/core/providers/automatic-client.ts`; ветки `launchCodex*`, `launchClaude*`, `launch*Automatic` | Новый единый OMP launch и миграция профилей готовы |
| **Вывести из рабочего контура, затем удалить** | `src/bridge/anthropic/`, `src/bridge/responses/` и их exports | Все активные маршруты ходят напрямую через OMP; ни диагностика, ни другой потребитель не требуют их |
| **Удалить после dependency audit** | Трансляторы из `src/protocols/`, bridge-only `src/core/state-machine/`, `src/bridge/sse/` | Общие типы/парсеры, ещё нужные диагностикам, предварительно отделены. Не удалять дерево вслепую |
| **Переделать** | `src/core/fallback/` | Сохранить пользовательское описание цепочек/миграцию; убрать дублирующий runtime routing после проверки OMP |
| **Переделать** | `provider-profile.ts`, `prompt-profile.ts`, profile-bundle import/export | Вместо `preferredClient`, `clientFlags.codex`, `clientFlags.claudeCode` — настройки OMP. Старую схему читать через явную миграцию |
| **Переделать** | `src/clients/agent-session-history.ts`, `agent-session-home.ts`, `agent-session-presentation.ts` | OMP sessions + отдельный read-only legacy importer; не подменять native resume импортом |
| **Переделать** | `agent-approval.ts`, `agent-approval-preference.ts`, `agent-skills-runtime.ts` | Проверенные права OMP, отдельная миграция skills/instructions, без старых symlink-домов CLI |
| **Сохранить и усилить** | `src/core/security/`, `src/core/portals/`, provider repositories | DPAPI, redaction, recovery, связи кабинетов |
| **Сохранить, сузить** | Provider adapters / `src/diagnostics/` | Metadata и проверки API; не использовать как второй inference runtime |
| **Переделать** | `src/core/health/`, `src/core/usage/`, UI activity | Новые записи `client: omp`, сохранение исторических `codex/claude-code` в legacy data |
| **Переделать** | `src/application/`, `src/cli/provider-dock-cli.ts`, `src/index.ts`, `ProviderDock.bat` | Единый OMP lifecycle, диагностика startup, отсутствие обязательных старых binaries |
| **Удалить устаревшие UI-поля** | Client selector Auto/Codex/Claude; обе группы flags; badges совместимости со старыми CLI | Вместо них протокол, readiness OMP, права, account identity |
| **Обновить** | `README.md`, техническую спецификацию, `docs/PROJECT-MAP.md`, client/bridge docs, тесты и scripts | Архивное описание отделено от действующих инструкций |

Не удалять слова `codex` и `claude` глобальным replace: это также имена моделей/провайдеров, source formats старых сессий и историческая телеметрия.

---

## 6. Порядок реализации

Это один roadmap с независимыми принимаемыми этапами. Каждый этап — отдельное изменение, свой red → green тест и review. Не объединять восстановление данных, установку OMP и удаление старого runtime в один большой commit.

### Этап 0. Зафиксировать данные и подготовить безопасное восстановление

**Файлы:** создать `src/migration/migration-manifest.ts`, `src/migration/portal-recovery.ts`, `tests/portal-recovery.test.ts`; использовать `src/core/portals/portal-repository.ts`, `portal-types.ts`, `src/core/security/dpapi-secret-vault.ts`.

**Interface:** `MigrationManifest` содержит version, время, относительный путь, byteLength, SHA-256, тип данных и результат валидации — без credential values. Recovery принимает manifest и явное сопоставление portal connections; выдаёт dry-run отчёт и отдельный staged-файл.

- [ ] Добавить fixture нулевого файла на 280 047 байт, валидного backup и backup из нулей.
- [ ] Тест: recovery не подменяет повреждение пустым массивом; исходные байты не изменяются; NUL-backup не считается рабочим.
- [ ] После остановки фоновых writers создать snapshot пользовательского data root и native/provider-scoped session homes. Проверить manifest и чтение копий.
- [ ] Секреты копировать только в исходном защищённом виде. Учесть привязку DPAPI к Windows-пользователю: одна копия ciphertext не гарантирует восстановление на другом ПК.
- [ ] Искать **валидную** версию portal-метаданных. При отсутствии — построить список связей для явного подтверждения; неизвестные `userId`, origin и secretRef не выдумывать.
- [ ] Не отправлять найденный токен на guessed URL «для проверки». Origin каждой связи должен быть подтверждён.
- [ ] Сформировать staged connection records с пустым/unknown observation cache, проверить схему и связность.
- [ ] Только после принятия отчёта — атомарная замена активных metadata; оригинал оставить в архиве. Portal refresh после восстановления — отдельная операция.

**Приёмка:** актуальное число провайдеров/секретов/сессий совпадает с manifest; неизвестные связи перечислены; recoverable data не удаляется. Восстановление кабинетов не блокирует изолированное исследование OMP, но обязательно до удаления старого контура.

### Этап 1. Устранить непрозрачность UI и укрепить запись данных

**Файлы:** `src/ui/provider-dashboard-server.ts`, `provider-dashboard-script.ts`, `provider-dashboard-html.ts`; `src/clients/agent-terminal-process.ts`; `src/core/portals/portal-repository.ts`; `src/application/create-default-application.ts`, `src/core/providers/model-protocol.ts`, оба bridge server; создать `src/core/errors/operation-diagnostic.ts`, `tests/dashboard-failure-isolation.test.ts`, `tests/operation-diagnostic.test.ts`, `tests/bridge-portal-corruption.test.ts`, `vitest.config.ts`; расширить `tests/provider-portals.test.ts`.

**Interface:** единая редактированная диагностика:

```ts
type OperationStage =
  | "storage" | "validation" | "credentials" | "process-spawn"
  | "agent-init" | "upstream" | "stream" | "tool" | "shutdown";

interface OperationDiagnostic {
  operationId: string;
  stage: OperationStage;
  code: string;
  message: string;
  retryable: boolean;
  suggestedAction: string;
  occurredAt: string;
  httpStatus?: number;
  exitCode?: number;
}
```

- [ ] Сначала failing API/UI tests: disabled model, unavailable model, missing executable, corrupt portals, sessions endpoint 500, exit 1.
- [x] Hotfix 2026-09-15: **настоящая default application composition** с NUL portals и обоими публичными launcher-ами. Независимые health hints и явные протоколы работают; без подсказок сохранена существующая negotiation. Выбор новой политики `PROTOCOL_UNRESOLVED` остаётся будущей задачей, не частью этой отметки.
- [x] Hotfix 2026-09-15: убрать обязательную зависимость protocol resolution от исправности portal observations, обработав только `PortalRepositoryCorruptionError` внутри независимого чтения portals. Сохранять corruption status; не сбрасывать файл и не скрывать произвольные ошибки. Явные протоколы и валидная health-информация не зависят от исправности кабинетов.
- [ ] До `openUpstream()`/выбора route записывать operation context; pre-dispatch failure получает `origin=local`, `stage=protocol-resolution`, `upstreamAttempted=false`, а не теряется из-за отсутствия `selectedForHealth`.
- [ ] Проверять тип/нормализованный code ошибок, а не только точное имя базового класса. Не заменять whitelist безусловным возвратом `error.stack`.
- [ ] Отображать локализованные причины, код и ID; хранить безопасную диагностическую запись вне памяти HTTP-server.
- [ ] При `portalStatus=corrupt` показывать recovery-banner; блокировать действия, зависящие от неизвестных связей, но оставить доступ к списку провайдеров и запуску независимых API-маршрутов.
- [ ] Разделить refresh по секциям, не затирать успешные данные при ошибке другой секции; обработать stale responses и сохранить выбранные поля/фокус.
- [ ] Исправить exit-state mapping и подпись approvals. Развести отсутствие аккаунта, истекшую авторизацию, corruption и временный network error.
- [ ] При подсчёте использования ключей включить portals. В corruption-режиме запретить «чистку неиспользуемых» по неполной информации.
- [ ] Для JSON-записи добавить проверяемую долговечность: эксклюзивный межпроцессный writer, временный файл в том же каталоге, flush перед replace, валидацию, ограниченную ротацию **валидных** backup. Cache observations отделить от критичных connection metadata.
- [ ] Проверить две одновременно пишущие копии приложения, прерывание записи и восстановление; не обещать абсолютную защиту от аппаратного сбоя.
- [ ] Исправить smoke fixture и ожидания после согласованного изменения UI, а не просто удалить assertions.
- [ ] В `vitest.config.ts` ограничить discovery нашими `tests/**/*.test.ts`. Разобрать `ENOTEMPTY` cleanup на Windows через ожидание завершения реальных фоновых операций; не маскировать его удалением теста или случайной задержкой.

**Приёмка:** те же fault fixtures дают конкретную причину и сохраняют рабочие секции. Ни один журнал не содержит ключей/cookies. Полный dashboard smoke проходит.

### Этап 2. Проверить OMP на этой Windows-машине

**Файлы:** создать `docs/omp-runtime-runbook-ru.md`, `tests/fixtures/omp/`; зависимости production пока не менять.

- [ ] Зафиксировать upstream version/commit, источник артефакта и checksum. Не запускать непроверенный remote installer.
- [ ] Для выбранного `unsigned-gg/omp` решить источник поставки: воспроизводимая сборка pinned fork или отдельно утверждённый переход к `can1357/oh-my-pi`. Последнее — смена исследуемого исходника и требует повторной проверки, не молчаливая замена.
- [ ] Проверить Windows binary/package: архитектура CPU, native bindings, Bun/runtime requirements, clean-machine запуск. Изученный source commit не считать готовым release-артефактом.
- [ ] Установку выполнять только на этапе реализации; отдельный управляемый agent home и отдельная копия тестового проекта.
- [ ] Проверить version/help, TUI, one-shot, RPC/ACP handshake там, где они нужны. Зафиксировать фактические команды выбранной версии.
- [ ] Проверить путь с пробелами и кириллицей, запуск без Bun при выбранном standalone artifact, поведение отсутствующего binary и обновление/rollback.
- [ ] Проверить модель разрешений: file read/write вне проекта, shell, network, MCP и subagents. Отсутствующую песочницу нельзя «покрыть» старой подписью в UI.
- [ ] Явно выставить и валидировать `always-ask` для пилота; отдельно задать per-tool deny/allowlist. До security acceptance не включать task/eval/MCP с побочными эффектами и сторонние extensions. Один `always-ask` не ограничивает чтение вне проекта и не является OS sandbox.

**Приёмка:** документирован воспроизводимый способ установки/запуска, версия закреплена, ограничения безопасности известны. Если нужная изоляция отсутствует — отдельное решение пользователя или внешняя изоляция до cutover.

### Этап 3. Подключить существующие providers и DPAPI без bridges

**Файлы:** создать `src/clients/omp/omp-config-compiler.ts`, `omp-credentials.ts`, `omp-runtime-paths.ts`; `tests/omp-config-compiler.test.ts`, `tests/omp-credentials.test.ts`; изменить `src/application/create-default-application.ts`.

**Interface:** компилятор принимает provider/model metadata и выбранные маршруты; возвращает non-secret config, карту provider IDs и список требуемых secret references. Credential module получает этот список и выдаёт только child environment; UI такого метода не имеет.

- [ ] Добавить snapshot-tests конфигурации для Chat Completions, Responses и Messages; модельные имена сохранять буквально.
- [ ] Для `auto` без подтверждённого mapping возвращать `PROTOCOL_UNRESOLVED`, а не случайный протокол.
- [ ] Проверить URL join без двойного `/v1`, custom header auth, disabled models, reasoning/tool capabilities и дубликаты model IDs у разных providers.
- [ ] Добавить negative tests: отсутствующий secret, неподходящий origin, вредоносное значение config/resolver, ambient credential другого аккаунта.
- [ ] Скомпилировать isolated `models.yml` согласно schema зафиксированной OMP-версии. В Git — только фиктивные profiles и имена переменных, не реальные credentials.
- [ ] Проверить compiler на всех 16 профилях; пять `auto` довести до явного protocol mapping.
- [ ] Провести ограниченный pilot: один Chat gateway, один Messages gateway и Responses там, где подтверждён этот endpoint; text, stream, tool call/result, cancel.

**Приёмка:** OMP работает напрямую с пилотными upstream без старых loopback bridges. В config, аргументах, логах и `agent.db` нет неожиданно сохранённых API-ключей из DPAPI.

### Этап 4. Сделать единый supervised OMP launch

**Файлы:** создать `src/clients/omp/omp-runtime.ts`, `omp-process-supervisor.ts`, `omp-run-repository.ts`; `tests/omp-runtime.test.ts`, `tests/omp-process-supervisor.test.ts`; изменить application, dashboard server и CLI.

**Interface:** `preflight(selection)` возвращает проверенный маршрут либо `OperationDiagnostic`; `start(selection)` возвращает `runId`; `getRun(runId)` возвращает состояние и диагностику; `cancel(runId)` останавливает только связанный процесс/дерево.

- [ ] Fake child-process tests: spawn error, ранний exit, timeout, успешная инициализация, поздний fail, cancel, повторное открытие dashboard.
- [ ] Ввести состояния `VALIDATING → STARTING → READY → RUNNING → SUCCEEDED / FAILED / CANCELLED`, с отдельным временем каждого этапа.
- [ ] Не выставлять `READY` только по появлению терминала. Если TUI не даёт надёжного agent-ready event, честно показывать только «терминал открыт».
- [ ] Для TUI сохранить полноценный терминал; structured startup/exit передавать отдельным каналом. Не сломать TTY простым перенаправлением всей TUI-выдачи в pipe.
- [ ] Для RPC-режима stdout резервировать под protocol frames, stderr ограничить и редактировать. Не смешивать debug logs с RPC.
- [ ] Preflight проверяет executable, cwd, config, model mapping, доступность credentials и права **без платного запроса**.
- [ ] Сохранить run metadata/диагностику между перезапусками dashboard; сопоставлять run, OMP session и provider/account.
- [ ] Интегрировать request/usage events OMP; если информация недоступна, показывать unknown, а не нулевые затраты.

**Приёмка:** при каждом искусственном раннем отказе UI показывает этап, причину и действие. Dashboard restart не стирает причину ошибки. Не запущен ни один Codex/Claude subprocess.

### Этап 5. Перенести историю, инструкции и права

**Файлы:** создать `src/migration/legacy-session-import.ts`, `src/clients/omp/omp-session-history.ts`, `tests/omp-session-import.test.ts`; изменить profile schemas, `agent-skills-runtime.ts`, `agent-session-presentation.ts`, profile-bundle tests.

- [ ] Сначала fixture transcripts обоих клиентов из native и provider-scoped homes, включая пустые/повреждённые файлы и одинаковые IDs.
- [ ] Сделать dry-run inventory; OMP importer не обязан автоматически найти наши изолированные homes.
- [ ] Реализовать импорт Codex через explicit `rootDirectory`/поддержанный adapter выбранной версии. Не рассчитывать на `CODEX_HOME` и не подменять глобальный `HOME`, меняя остальные пути OMP.
- [ ] Импортировать несколько копий; проверить сообщения, tool results, cwd, model metadata и продолжение **новой OMP-сессии**.
- [ ] Вести manifest `source path + content hash → imported OMP session`; повторный импорт не дублирует историю.
- [ ] Отчёт по каждому файлу: imported / already imported / unsupported / corrupt / skipped by user. Не обещать «53/53 без потерь» до проверки.
- [ ] Сохранить оригиналы read-only. Импорт transcript — не перенос внутренних checkpoints, sandbox permissions и точного runtime-состояния старого клиента.
- [ ] Перенести инструкции, skills, MCP/extensions и project bindings по allowlist; не активировать всё автоматически.
- [ ] Старые flags сохранить в migration report как несовместимые, а не прокинуть OMP.
- [ ] Настройки permissions подтвердить заново на первой сессии. Не превращать прежний `full-auto` в новый небезопасный режим автоматически.

**Приёмка:** полный отчёт о судьбе всех найденных сессий; повторный импорт идемпотентен; несколько реальных проектов продолжаются в OMP. Старые CLI для чтения/import не исполняются.

### Этап 6. Упростить интерфейс и включить проверенный routing

**Файлы:** `src/ui/provider-dashboard-{html,script,css,server}.ts`, `provider-dashboard-catalog.ts`, `model-storefront.ts`; `src/core/fallback/`; `tests/omp-routing.test.ts`, `tests/omp-dashboard.test.ts`, `scripts/dashboard-ui-smoke.mjs`.

- [ ] Основной launch: проект → provider/account → model → права → «Открыть OMP».
- [ ] Убрать выбор старого клиента. Advanced-настройки не скрывают обязательный выбор аккаунта и протокола.
- [ ] Разделить в UI API key, portal session и OAuth login. Наличие одного не означает здоровье остальных.
- [ ] Показывать источник баланса/цены, время обновления и unknown/stale. Usage OMP не считать балансом стороннего кабинета.
- [ ] Перед показом «Запуск доступен» использовать результаты preflight, а не brand heuristic.
- [ ] Проверить fallback fault matrix из раздела 4.4; только после неё включить OMP fallback. При провале оставить explicit retry без повторного tool execution.
- [ ] Отдельный MCP fixture: server выполнил запись, ответ потерян, reconnect состоялся. Приёмка — не возникает второго побочного эффекта; без доказательства соответствующий tool остаётся отключённым.
- [ ] Desktop/mobile/keyboard smoke: нет `????`, нет скрытой причины, нет сброса выбора при polling, corruption banner доступен без поиска по вкладкам.

**Приёмка:** пользователь может выбрать маршрут и понять отказ без терминологии старых CLI; проверки безопасности/retry проходят.

### Этап 7. Cutover и удаление старого контура

**Файлы:** удаление по таблице раздела 5; изменить `src/index.ts`, `package.json`, CLI help, startup scripts и действующие docs. Добавить `tests/omp-only-runtime.test.ts`.

- [ ] Провести pilot минимум в нескольких рабочих проектах, включая restart/resume, большой context и tool execution.
- [ ] Проверить каждый профиль актуального manifest (15 сентября: **17**, ранее 16): migrated-and-tested либо явно принятый пользователем отказ от этого профиля. Недоступный upstream не считать успешно мигрированным.
- [ ] Выполнить acceptance с `codex` и `claude` недоступными в PATH, без доступа нового runtime к legacy homes и с выключенными старыми bridges.
- [ ] OMP сделать единственным production launch; временный legacy fallback выключить.
- [ ] Удалить старые launchers, runtime generation, CLI-команды и bridge-only implementation. Перенести оставшиеся общие типы из legacy namespaces до удаления.
- [ ] Перенести полезные protocol/replay тестовые сценарии в OMP contract tests. Удалять тест только вместе с действительно удалённым поведением, не чтобы скрыть failure.
- [ ] Проверить репозиторий на активные зависимости от старых executables, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, native config generation и bridge ports.
- [ ] После принятия новой версии предложить удалить **установки** старых CLI отдельно от архивов данных. Не удалять пользовательские homes «заодно».

**Приёмка:** новый рабочий контур не требует Codex CLI / Claude Code. Архивные transcripts и rollback snapshot не являются runtime-зависимостью.

---

## 7. Обязательная тестовая матрица

| Группа | Сценарии | Условие успеха |
| --- | --- | --- |
| Recovery | NUL JSON, неверная схема, NUL backup, валидный backup, прерванная запись, 2 writers | Нет тихой потери connections; известен источник восстановления |
| Shared request path | NUL portals + default composition + оба CLI-facing bridges; auto/explicit; known/unknown protocol; stream on/off | Нет generic-only 500; независимый routing не падает из-за кабинета; local failure не теряется в телеметрии |
| UI isolation | Portals corrupt, sessions 500, недоступный vault, поздний ответ refresh | Независимые рабочие секции не исчезают |
| Errors | MODEL_DISABLED, MODEL_NOT_AVAILABLE, missing binary/cwd/secret, timeout, exit 1 | Код + этап + понятное действие; нет generic-only сообщения |
| Config | 3 протокола, 5 auto profiles, endpoint URL, custom headers, model ID collisions | Выбран именно ожидаемый endpoint/provider/account |
| Credentials | Missing env, config precedence, subprocess inheritance, logs, SQLite | Нет leakage и незаявленного сохранения ключей |
| Streaming/tools | Text, thinking, tool call/result, stream interruption, cancel | Корректное завершение; побочные эффекты не повторяются |
| Retry/fallback | 401/403/429/5xx; before-output / after-output / after-tool | Один владелец retry; ограниченные попытки; видимая смена маршрута |
| History | Native и isolated homes, repeated import, corrupt transcript, resume | Пофайловый отчёт, идемпотентность, оригиналы сохранены |
| Permissions | Outside-workspace write, shell, network, MCP, subagent | Поведение соответствует UI и явно принятой модели угроз |
| Windows | Spaces/Cyrillic, native module loading, absent Bun, close terminal, restart | Проверенная поставка и диагностируемый отказ |
| OMP-only | Старых binaries/homes/bridges нет в доступном контуре | Новый launch, работа и resume продолжаются |

Команды существующего проекта:

```powershell
npm run typecheck
node node_modules/vitest/vitest.mjs run --exclude '.scratch/**' tests
npm run build
node scripts/dashboard-ui-smoke.mjs
```

После добавления явного `include` в Vitest обычный `npm test` должен запускать только наши tests. Новые tests из этапов входят в этот набор. Для OMP нужны также отдельные проверки установленного зафиксированного runtime: прохождение одних Node/Vitest fixtures не заменяет Windows acceptance.

## 8. Rollback и критерии остановки

- До удаления legacy-кода rollback — возврат к проверенной версии приложения и её **отдельному** snapshot данных; не смешивать несовместимые схемы.
- После удаления — установка архивного release вручную, если пользователь решит откатиться. Это аварийная возможность, не скрытый auto-fallback в новый runtime.
- Credential source меняется только после проверки нового владельца. Запрещена одновременная refresh-работа двух контуров над одним OAuth identity.
- При несовпадении manifest counts, неоднозначном secret origin, неподтверждённых правах, повторном tool execution или неизолированной записи metadata — остановить соответствующий этап.
- При проблеме OMP Windows artifact не обходить gate незаметным переходом на другой agent/версию.

## 9. Что считается полным завершением

- [ ] OMP — единственный агент в UI и CLI ProviderDock.
- [ ] Нет runtime-зависимости от Codex CLI / Claude Code, их config homes и мостов.
- [ ] Каждый исходный provider имеет проверенный результат миграции.
- [ ] Все секреты сохранены; credentials используются только в выбранном контуре.
- [ ] Все исходные сессии учтены, оригиналы сохранены, ограничения импорта видны.
- [ ] Кабинеты восстановлены либо явно отмечены как требующие восстановления, а не «аккаунтов нет».
- [ ] Любая ошибка имеет код/этап/ID; ранний отказ не выглядит беспричинным.
- [ ] Security/fallback/Windows acceptance пройдены.
- [ ] Основные docs и runbook описывают только новый рабочий сценарий.

**Следующий шаг после утверждения:** этапы 0–1. Сначала защитить данные и сделать отказы объяснимыми; затем подключать OMP напрямую. Немедленная деинсталляция старых CLI или переписывание секретов не является первым шагом.
