# Мгновенный отказ после сообщения в обоих CLI: подтверждённый общий путь

Первичная диагностика: 2026-09-14. Обновление: **2026-09-15, точечное исправление применено и собрано** по отдельному запросу пользователя вернуть работоспособность Codex через ProviderDock. В тот момент миграция на OMP не выполнялась.

**Последующее решение 15 сентября:** после ошибки несовместимого Responses `namespace` пользователь утвердил выполнение миграции. Работа начата отдельно от этого hotfix: [текущий runtime runbook](omp-runtime-runbook-ru.md). Нельзя считать устранение corruption → 500 исправлением `namespace` или полной работоспособностью старых CLI.

## Читать первым: текущее состояние исправления

- В `src/application/create-default-application.ts` общий resolver обрабатывает **только `PortalRepositoryCorruptionError`** как отсутствие необязательных portal-подсказок. Остальные ошибки по-прежнему передаются вызывающему коду.
- Валидная health-информация сохраняет приоритет. Когда подсказок нет, используется существующая автоматическая negotiation bridge; новая политика `PROTOCOL_UNRESOLVED` в этот hotfix **не включена**.
- Исходный `accounts.json`, ключи и пользовательские сессии не заменялись и не восстанавливались. Repository по-прежнему показывает corruption и сохраняет свой штатный backup при чтении; это не «пустой список аккаунтов».
- `tests/bridge-portal-corruption.test.ts`: **16 тестов проходят**. Используются реальная default composition, публичные `launchCodex`/`launchClaude`, временные runtime-файлы и loopback HTTP. Заменены только внешние CLI-процессы и upstream HTTP. Первые четыре regression-теста до исправления воспроизводили 500, после — 200.
- Полный ограниченный нашим каталогом `tests/` запуск: **73 файла, 536 тестов проходят**. `npm run typecheck`, `npm run build` и `git diff --check` успешно завершились (Git предупреждает о нормализации CRLF).
- Исходный диагностический harness после сборки: все 8 сценариев с NUL metadata и 8 с валидным файлом дают **HTTP 200, один тестовый upstream-вызов**, без ошибок resolver. NUL fixture побайтно сохранён.
- **Настоящий установленный Codex и платные inference-запросы не запускались.** Проверены launch/config/bridge-пути, не доступность всех реальных провайдеров и не точная формулировка ошибки конкретной версии CLI.
- Для применения нужен **новый процесс ProviderDock и новая managed CLI-сессия**. Запустить `ProviderDock.bat` из этого checkout и использовать вновь открывшийся dashboard; старая вкладка/bridge может обслуживаться прежним процессом. Простого обновления старой вкладки недостаточно.

Далее сохранены доказательства **состояния до исправления** и оставшиеся задачи диагностики.

## Уточнение симптома

Пользователь сообщил: оба CLI успешно открываются, но после отправки сообщения Claude Code показывает HTTP 500, а Codex — сообщение о перегрузке серверов. По наблюдению пользователя это происходит на любых моделях/провайдерах, почти мгновенно.

Это другой сценарий, чем ранее найденный `ModelDisabledError` при запуске. Его нельзя объяснять одним frontend error mapper.

## Подтверждённая причина для маршрутов `apiType: auto`

В общей сборке приложения **до исправления**:

```ts
// src/application/create-default-application.ts:257–260
const portalRecords = new FilePortalRepository(join(paths.dataDirectory, "portals", "accounts.json"));
const protocolResolver: ModelProtocolResolver = async (profile, modelId, client) => {
  const [health, portal] = await Promise.all([
    healthRecords.get(profile.id),
    portalRecords.get(profile.id),
  ]);
  return knownModelProtocol(health, portal, modelId, client);
};
```

Этот **один resolver передаётся обоим bridge factories**.

Последовательность:

1. CLI отправляет сообщение локальному loopback bridge.
2. Bridge принимает запрос и записывает admission в turn ledger.
3. Для `apiType: auto`, если протокол ещё не закэширован, вызывается общий `protocolResolver`.
4. `portalRecords.get()` читает весь `accounts.json`.
5. Файл из NUL вызывает `PortalRepositoryCorruptionError`, причина — `SyntaxError` JSON parser.
6. `Promise.all` отклоняется. Даже успешно прочитанная health-информация не попадает в `knownModelProtocol`.
7. До `ProviderHttpRequestBuilder.build()` и `fetchImpl()` выполнение не доходит.
8. Общие catch-ветки bridges превращают ошибку в локальный HTTP 500:
   - Responses: `ProviderDock bridge request failed.`
   - Anthropic: `ProviderDock Anthropic bridge request failed.`

**Итог:** повреждённые данные кабинетов стали обязательной зависимостью inference routing. Это не отсутствие API-ключа и не ответ удалённой модели.

### Участки кода

- Общая зависимость: `src/application/create-default-application.ts:257–260`.
- Responses resolver до upstream: `src/bridge/responses/responses-bridge-server.ts:850–854`; вызов fetch — строка 915.
- Anthropic resolver до upstream: `src/bridge/anthropic/anthropic-bridge-server.ts:797–801`; вызов fetch — строка 898.
- Чтение/валидация metadata: `src/core/portals/portal-repository.ts`, методы `get()`, `list()`, `parseDocument()`.
- Безликий локальный 500: Responses строка 1374, Anthropic строка 1507.

Строки относятся к рабочему дереву на дату диагностики.

## Воспроизведение и контроль

Диагностический harness: `.scratch/debug-instant-cli/repro.mjs` — локальный временный инструмент, не production implementation и не постоянный regression test.

Он:

- создаёт отдельный data root в системном temp;
- вызывает настоящий `createDefaultApplication()` и настоящие factories обоих bridges;
- получает уже установленный production resolver из композиции, **не копирует его реализацию**;
- использует фиктивный API-ключ и `fetchImpl` с mock-ответами;
- посылает HTTP-запрос только собственному loopback bridge;
- не запускает Codex/Claude executables, DPAPI, OAuth или настоящий inference;
- проверяет и streaming, и non-streaming запросы;
- сохраняет исходный тестовый файл: его не «чинит» приложение.

Команды:

```powershell
npm run build
node .scratch/debug-instant-cli/repro.mjs --expect-success
# Exit 1: положительное требование «запрос проходит» нарушено при NUL metadata.

node .scratch/debug-instant-cli/repro.mjs --valid --expect-success
# Exit 0: та же конфигурация и код, только тестовый accounts.json — валидный пустой документ.
```

Повторный NUL-запуск снова дал exit 1. В свежих запусках общий локальный отказ занимал **9–47 мс**; это измерения fixture, не реальных CLI/серверов.

| Тестовые metadata | Протокол | Codex-facing bridge | Claude-facing bridge | Upstream вызовов на запрос |
| --- | --- | --- | --- | --- |
| 280 047 NUL | `auto` | HTTP 500 | HTTP 500 | **0** |
| Валидный version-2 документ | `auto` | HTTP 200 | HTTP 200 | **1 mock-вызов** |
| 280 047 NUL | Явный Chat Completions | HTTP 200 | HTTP 200 | **1 mock-вызов** |

Результат одинаков для `stream: false` и `stream: true`.

Во всех четырёх отказах trace из неизменённого resolver:

```text
PortalRepositoryCorruptionError
  caused by SyntaxError
upstreamCalls = 0
```

Заменён только входной **тестовый** документ. Валидный пустой документ здесь — контрольный образец, **не рекомендация очистить настоящий accounts.json**.

## Почему диагностика раньше не показывала этот сбой

В Responses `handleResponses()` и Anthropic `handleMessages()` переменная `selectedForHealth` присваивается только после успешного `openUpstream()`. Ошибка resolver возникает внутри него, до возврата selected route.

В catch runtime health записывается лишь при `selectedForHealth !== undefined` и распознанном failure. В проверенном сценарии условие не выполняется.

Fixture из восьми запросов с повреждёнными metadata сохранила **4 runtime signals только для четырёх успешных явных Chat-запросов**. Четыре локальных 500 не появились в runtime signals. При валидных metadata сохранились 8 signals.

Поэтому отсутствие новой записи в истории провайдера не означает отсутствие ошибки: отказ случился в локальном control path, который не покрыт этой телеметрией.

## Границы вывода — что ещё не доказано

- **Общая локальная причина подтверждена для `auto` и незакэшированного protocol resolution.** В текущем inventory таких профилей 5 из 16.
- Явный Chat Completions в контроле проходит даже с повреждёнными portals. Поэтому эта причина **не доказывает отказ всех 16 текущих профилей**. Состояние профилей во время пользовательского эпизода могло отличаться; для остальных отказов нужен соответствующий trace.
- Не запускались настоящие CLI и не воспроизводилась точная формулировка Codex «перегрузка серверов». Доказан HTTP 500 на Codex-facing endpoint до upstream, а не правило локализации/ретрая установленной версии Codex.
- Это сильное совпадение с описанным симптомом и фактическим повреждённым файлом, но не ретроспективный network capture каждого пользовательского запроса.
- Кто занулил оригинальный файл — по-прежнему неизвестно.
- Это не доказывает отсутствие других проблем bridge, upstream или Windows.

## Расширенная программа исправления и оставшиеся задачи

1. **Выполнено в hotfix:** убрать обязательную зависимость inference от исправности portal observations. Повреждение кабинета не отменяет уже известный валидный протокол API.
2. **Выполнено в hotfix:** независимо обработать ожидаемую portal corruption, не проглатывая остальные исключения и не теряя health-подсказки.
3. **Отдельное решение для миграции:** для unresolved `auto` вернуть понятный локальный `PROTOCOL_UNRESOLVED` с действием «выберите/подтвердите протокол» либо утвердить политику discovery. Текущий hotfix сохраняет существующий алгоритм negotiation и проверяет переход после однозначного HTTP 404.
4. Сохранить corruption-banner и запрет тихого сброса metadata. Исправление resolver **не означает восстановление связей аккаунтов**.
5. Записывать отдельную диагностику до upstream selection: `stage=protocol-resolution`, `origin=local`, `upstreamAttempted=false`, error code и correlation ID. Локальная corruption не должна объявлять удалённого провайдера перегруженным/offline.
6. **Выполнено в hotfix:** regression tests на **default application composition + оба публичных launcher-а**, а не только на bridge с упрощённым mock resolver.
7. **Частично выполнено:** corrupt/healthy/missing portals; `auto` с known health protocol и без него; explicit protocol; stream on/off; unexpected read error; negotiation после 404. Две модели/два провайдера в одной сессии и полная pre-dispatch диагностика остаются отдельными задачами.

**Hotfix устраняет подтверждённую связь corruption → мгновенный 500 для `auto`.** Он не восстанавливает portal-метаданные, не закрывает все проблемы интерфейса/диагностики и не доказывает причину каждого исторического отказа.
