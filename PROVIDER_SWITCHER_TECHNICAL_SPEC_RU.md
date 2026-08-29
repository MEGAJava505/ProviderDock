# Техническое задание: Provider Switcher

**Статус:** Draft / базовое ТЗ для начала разработки  
**Рабочее название:** Provider Switcher  
**Тип продукта:** локальный менеджер AI-провайдеров, compatibility gateway, launcher и health-monitor  
**Основная платформа MVP:** Windows 10/11  
**Основные клиенты:** OpenAI Codex CLI и Claude Code  
**Референс существующей реализации:** `MEGAJava505/agentrouter_for_codex`

---

## 1. Краткое описание

Provider Switcher — локальное приложение, которое позволяет подключать несколько сторонних AI-провайдеров и безопасно использовать их модели через готовые coding-agent клиенты: Codex CLI и Claude Code.

Проект **не является собственным аналогом Codex CLI или Claude Code** и не должен заново реализовывать coding-agent, терминал, sandbox, файловые tools и полный цикл агентской работы. Provider Switcher выступает промежуточным слоем между клиентом и внешним AI API.

Главная идея:

```text
Codex CLI / Claude Code
        ↓
Provider Switcher
        ↓
Compatibility / Routing / Health / Safety
        ↓
AgentRouter / GoRouter / Custom Provider / другие API
```

Приложение должно решать проблемы несовместимости API, управлять временными конфигами, показывать состояние моделей и в будущем безопасно переключать запросы между провайдерами.

---

# 2. Причина создания

Практика прямого подключения кастомных провайдеров к Codex CLI показала, что заявление «OpenAI-compatible» не означает полную совместимость.

Уже встречавшиеся и потенциальные проблемы:

- `401 Unauthorized`, несмотря на корректный API key;
- обязательные provider-specific identity headers;
- API поддерживает Chat Completions, но не Responses API;
- API частично реализует Responses API;
- отсутствуют ожидаемые JSON-поля;
- отсутствует или неправильно передаётся `max_output_tokens`/эквивалент;
- нестандартный `usage`;
- некорректный SSE/streaming;
- stream закрывается без terminal event;
- дублируются stream events;
- теряется `tool_call_id`;
- `tool_result` неправильно привязывается к предыдущему tool call;
- модель снова получает старый незавершённый tool call;
- после завершения задачи выполняется повторный upstream request;
- клиент повторяет запрос после частично выполненной операции;
- инструмент, уже изменивший файлы, может выполниться второй раз;
- `/models` показывает модель, которая фактически не отвечает;
- provider работает, но конкретная модель временно недоступна;
- одна модель нормально работает в Claude Code, но плохо — в Codex CLI, или наоборот.

Provider Switcher должен централизованно диагностировать и по возможности исправлять такие несовместимости.

---

# 3. Цели проекта

## 3.1. Главная цель

Сделать локальную платформу, где пользователь может:

1. подключить несколько AI-провайдеров;
2. увидеть их модели;
3. увидеть, какие модели реально живы;
4. понять уровень совместимости каждой модели с Codex CLI и Claude Code;
5. запустить подходящий клиент без ручной правки постоянных конфигов;
6. автоматически применить необходимые compatibility fixes;
7. безопасно работать с tools и streaming;
8. использовать свои agent prompts / launch profiles;
9. при возможности переключиться на резервного провайдера;
10. получить понятную диагностику причины ошибки.

---

# 4. Что не входит в MVP

В первой версии не требуется:

- собственный полноценный AI coding CLI;
- собственный coding-agent;
- собственный sandbox;
- собственный редактор кода;
- IDE;
- облачный backend;
- пользовательские аккаунты;
- серверная синхронизация API keys;
- marketplace;
- биллинг;
- мобильное приложение.

Допускается внутренний launcher/helper, необходимый для запуска Codex/Claude и управления runtime-конфигами, но он не должен превращаться в отдельный agent CLI.

---

# 5. Поддерживаемые клиенты

## 5.1. Codex CLI

Provider Switcher должен уметь:

- выбрать модель;
- выбрать model provider;
- сформировать временный `config.toml`;
- настроить `base_url` и нужный wire protocol;
- передать credentials безопасным способом;
- запустить local compatibility bridge, если прямое подключение не работает;
- корректно поддерживать streaming;
- корректно поддерживать tools;
- поддерживать reasoning и images, если это умеет конкретный provider/model;
- запускать Codex в выбранной project directory;
- корректно завершать bridge после закрытия Codex;
- восстанавливать исходный пользовательский config.

## 5.2. Claude Code

Provider Switcher должен отдельно поддерживать Claude Code через его gateway-механизмы:

- `ANTHROPIC_BASE_URL`;
- `ANTHROPIC_AUTH_TOKEN` или `ANTHROPIC_API_KEY`;
- custom headers;
- выбор модели;
- Anthropic Messages-compatible endpoint;
- корректную передачу `anthropic-version` и `anthropic-beta`, когда это требуется;
- tools / tool results;
- streaming;
- thinking/reasoning blocks;
- model discovery, если gateway его поддерживает;
- local adapter для провайдера, который говорит только на OpenAI-compatible API.

## 5.3. Отдельная совместимость

Для каждой пары `provider + model` хранить статус отдельно:

```text
Model X @ Provider A
Codex CLI:    Compatible via adapter
Claude Code:  Native
```

Один общий флаг `supported=true` недостаточен.

---

# 6. Провайдеры

## 6.1. Первые реальные интеграции

### AgentRouter

Использовать как главный reference provider, потому что в существующем `agentrouter_for_codex` уже были выявлены реальные проблемы:

- `401 unauthorized client detected`;
- необходимость дополнительных client identity headers;
- streaming compatibility;
- tool compatibility;
- корректная цепочка `tool_call -> tool_result -> final answer`;
- старый recursive tool loop;
- automatic model discovery;
- безопасная временная замена Codex config;
- crash recovery.

### GoRouter

Использовать как второй независимый provider, чтобы архитектура не была жёстко привязана к AgentRouter.

Особенности GoRouter должны определяться реальными probes, а не предполагаться заранее.

## 6.2. Generic providers

Архитектура должна поддерживать:

1. OpenAI Responses-compatible providers;
2. OpenAI Chat Completions-compatible providers;
3. Anthropic Messages-compatible providers;
4. частично OpenAI-compatible providers;
5. частично Anthropic-compatible providers;
6. custom HTTP provider через отдельный adapter/plugin;
7. gateways, которые сами маршрутизируют несколько моделей.

## 6.3. Возможные будущие интеграции

- Amazon Bedrock;
- Google Vertex AI;
- Microsoft Foundry;
- LiteLLM;
- vLLM;
- локальные gateways;
- другие OpenAI/Anthropic-compatible API.

Core не должен требовать переписывания для добавления нового provider.

---

# 7. Добавление нового провайдера

Форма **Add Provider** должна позволять указать:

- Display Name;
- Provider ID;
- Base URL;
- API key/token;
- API type: Auto Detect / Responses / Chat Completions / Anthropic Messages / Custom;
- auth type;
- custom headers;
- query parameters;
- models endpoint;
- manual model IDs;
- preferred client;
- timeout;
- health-check policy.

Поддержать authentication schemes:

- `Authorization: Bearer <token>`;
- `x-api-key`;
- arbitrary custom header;
- несколько статических headers;
- query parameter;
- environment variable;
- позже — external token helper.

---

# 8. Provider Capability Detection

Новый provider необходимо проверять по уровням.

## Level 0 — Metadata

Без inference, если возможно:

- Base URL reachable;
- TLS;
- auth;
- `/models`;
- доступные endpoints;
- HTTP status;
- response headers.

## Level 1 — Minimal Inference

Очень дешёвый запрос, например:

```text
Reply exactly: OK
```

Проверить:

- модель существует;
- request принимается;
- JSON разбирается;
- text response приходит;
- finish reason;
- usage;
- latency.

## Level 2 — Streaming

Проверить:

- старт stream;
- корректность SSE;
- ordering;
- terminal event;
- stream close;
- duplicated/malformed chunks;
- usage events.

## Level 3 — Tool Compatibility

Использовать безопасный synthetic tool без filesystem/shell side effects:

```text
model
  -> tool_call
  -> fake tool_result
  -> continuation
  -> final answer
```

## Level 4 — Deep Diagnostics

Запускать только:

- вручную;
- при первом подключении;
- после изменения provider config;
- после обнаружения проблемы;
- перед release adapter fix.

Можно проверять:

- multi-turn;
- parallel tool calls;
- reasoning/thinking;
- images;
- cancellation;
- incomplete stream;
- long context;
- fallback compatibility.

---

# 9. Никаких бесполезных тестов

Это обязательный принцип проекта.

1. Сначала дешёвая metadata-проверка.
2. Затем один минимальный inference, только если нужен.
3. Tool test не запускать ради простого ONLINE/OFFLINE.
4. Deep diagnostics не запускать постоянно.
5. Кэшировать результаты.
6. Использовать TTL.
7. Недавний успешный реальный запрос пользователя считать сильным health signal.
8. Для offline provider использовать backoff.
9. Не отправлять платные long-context запросы без необходимости.
10. В разработке тестировать изменённую/рисковую область, а не гонять весь набор провайдеров после каждой мелочи.

---

# 10. Model Discovery

Provider Switcher должен:

- получать `/models`;
- сохранять raw model ID;
- сохранять display name;
- поддерживать manual models;
- объединять discovery + manual overrides;
- замечать новые и исчезнувшие модели;
- не удалять пользовательские настройки автоматически.

Внутренний ID:

```text
provider_id:model_id
```

Пример:

```text
agentrouter:gpt-x
gorouter:gpt-x
provider-c:claude-opus-x
```

---

# 11. Статусы моделей

Использовать понятные состояния:

- `UNKNOWN`;
- `CHECKING`;
- `ONLINE`;
- `DEGRADED`;
- `OFFLINE`;
- `AUTH_ERROR`;
- `RATE_LIMITED`;
- `INCOMPATIBLE`;
- `DISABLED`.

`DEGRADED` нужен, например, когда text работает, но tools/streaming работают плохо.

`AUTH_ERROR` должен отличаться от `OFFLINE`, поскольку 401 не означает, что provider физически недоступен.

---

# 12. Model Health Dashboard

Главный экран должен показывать примерно:

```text
Provider: AgentRouter

Model            Codex       Claude      Latency      Status
----------------------------------------------------------------
GPT-X            ✓ Native    ~ Adapter   1.2 s        ONLINE
GPT-Y            ✓ Adapter   —           2.8 s        DEGRADED
Claude-X         ~ Adapter   ✓ Native    1.5 s        ONLINE
Broken           ✕           ✕           —            OFFLINE
```

Для модели хранить:

- provider;
- model ID;
- last success;
- last check;
- latency;
- last error;
- Codex compatibility;
- Claude compatibility;
- streaming;
- tools;
- reasoning;
- images;
- health status.

---

# 13. Canonical Internal Protocol

Нельзя строить десятки прямых преобразований `Codex -> Provider X`, `Claude -> Provider Y`.

Нужен общий внутренний формат:

```text
Client request
    ↓
Client Adapter
    ↓
Canonical Request
    ↓
Provider Adapter
    ↓
Upstream
```

И обратный путь.

Canonical representation должен поддерживать:

- system/developer/user/assistant messages;
- text;
- images;
- tool calls;
- tool results;
- reasoning metadata;
- model parameters;
- stream events;
- provider extensions.

Неизвестные raw fields по возможности сохранять в extension namespace, чтобы translation layer не терял информацию.

---

# 14. Provider Adapter

Каждый provider adapter отвечает за:

- endpoint selection;
- auth;
- request mapping;
- response mapping;
- SSE mapping;
- tools;
- token-limit fields;
- usage fields;
- reasoning format;
- error normalization;
- provider-specific headers.

Provider-specific fixes не должны быть случайно разбросаны по всему core.

---

# 15. Compatibility Fix Pipeline

```text
Client request
    ↓
Client normalization
    ↓
Canonical model
    ↓
Provider compatibility fixes
    ↓
Upstream request
    ↓
Upstream response
    ↓
Schema normalization
    ↓
State validation
    ↓
Client response
```

Каждый fix должен иметь:

- ID;
- описание;
- provider/model scope;
- условие применения;
- risk level;
- возможность отключить;
- запись в diagnostics.

Примеры:

```text
fix.auth.client-identity
fix.responses.missing-terminal-event
fix.responses.missing-max-output-tokens
fix.tools.normalize-tool-call-id
fix.tools.history-normalization
fix.stream.normalize-sse
fix.usage.normalize-fields
fix.anthropic.thinking-normalization
```

---

# 16. Missing Fields / Schema Normalization

Если provider не возвращает поле, ожидаемое клиентом:

1. определить, обязательно ли оно;
2. безопасно вывести значение из request/model metadata, если возможно;
3. использовать provider metadata, если она надёжна;
4. не выдумывать семантически важное значение;
5. при неуверенности помечать модель/ответ как degraded;
6. записывать в debug, какое поле было синтезировано.

Это относится в том числе к token limits, usage и terminal metadata.

---

# 17. Streaming / SSE

SSE parser должен корректно обрабатывать:

- event/data framing;
- heartbeat;
- несколько SSE events в одном network chunk;
- один event, разбитый на несколько chunks;
- malformed event;
- duplicate event;
- terminal event;
- connection close;
- cancellation;
- timeout.

Запрещено считать один TCP chunk одним логическим event.

---

# 18. Terminal Event Handling

Если транспорт закрылся без ожидаемого terminal event:

1. проверить, завершён ли output;
2. проверить незавершённые tool calls;
3. проверить provider error signals;
4. определить, можно ли однозначно восстановить completion.

Только если это безопасно, можно синтезировать client-compatible completion event.

Иначе состояние:

```text
INCOMPLETE_RESPONSE
```

а не ложный success.

---

# 19. Anti-Recursion / Anti-Replay Engine

Одна из ключевых частей проекта.

Обязательная state machine:

```text
IDLE
  ↓
REQUEST_ACCEPTED
  ↓
UPSTREAM_STARTED
  ↓
STREAMING
  ├──> TOOL_CALL_PENDING
  │       ↓
  │   TOOL_RESULT_WAIT
  │       ↓
  │   CONTINUATION
  │
  ├──> COMPLETED
  ├──> FAILED
  ├──> CANCELLED
  └──> INCOMPLETE
```

`COMPLETED`, `FAILED`, `CANCELLED` — terminal states.

После `COMPLETED` тот же turn нельзя автоматически отправлять upstream снова.

---

# 20. Tool Call Integrity

Для каждого tool call хранить:

```text
toolCallId
requestId
sessionId
toolName
argumentsHash
status
createdAt
resolvedAt
resultHash
```

Статусы:

- CREATED;
- DELIVERED;
- EXECUTING;
- RESOLVED;
- FAILED;
- CANCELLED.

Правила:

1. `tool_result` ссылается на существующий tool call.
2. Уже RESOLVED call не должен считаться новым.
3. Дубликат ID распознаётся.
4. Blind replay tool call запрещён.
5. Неизвестный tool считать потенциально side-effecting.
6. При сомнении остановиться безопасно, а не повторять операцию.

---

# 21. Retry Policy

## Safe retry

Допустим, если:

- connection failed до начала обработки;
- request не был принят upstream;
- stream ещё не начался;
- tool calls отсутствуют;
- side effects невозможны.

## Unsafe retry

Не выполнять автоматически, если:

- stream уже начался;
- tool call уже передан клиенту;
- tool result уже отправлен;
- могли измениться файлы;
- неизвестно, успел ли upstream выполнить request.

---

# 22. Circuit Breaker

Для нестабильных provider/model:

```text
CLOSED
  ↓ failures
OPEN
  ↓ cooldown
HALF_OPEN
  ↓ probe
CLOSED / OPEN
```

Circuit breaker нужен отдельно на provider и при необходимости на model.

---

# 23. Automatic Fallback

Fallback должен быть безопасным.

## 23.1. Logical Model Group

```yaml
logical_model: gpt-x
routes:
  - provider: agentrouter
    model: gpt-x
    priority: 100
  - provider: gorouter
    model: gpt-x
    priority: 90
```

По умолчанию предпочитать **ту же логическую модель** у другого провайдера.

## 23.2. Safe fallback

Если provider умер до начала meaningful execution:

```text
Provider A failed
    ↓
Provider B / same logical model
```

## 23.3. Stateful fallback

После tool calls переключение возможно только с корректно сохранённой history.

Если side effect уже мог произойти, нельзя повторять turn с нуля.

## 23.4. Sticky session

Provider внутри активной session остаётся sticky и меняется только:

- по действию пользователя;
- при failure;
- при rate limit согласно policy;
- при circuit breaker.

---

# 24. Health Monitoring

Использовать комбинацию сигналов:

- успешный реальный user request;
- ошибка реального request;
- `/models`;
- cheap inference;
- 401/403;
- 404/model missing;
- 429;
- 5xx;
- timeout;
- protocol parse error;
- latency.

Если модель только что успешно обслужила реальную session, не нужно сразу отправлять дополнительный health prompt.

---

# 25. Временная конфигурация Codex

Использовать принцип из `agentrouter_for_codex`:

```text
Launch
  ↓
Validate current config
  ↓
Create backup/snapshot
  ↓
Generate temporary runtime config
  ↓
Start local bridge if required
  ↓
Start Codex in selected project directory
  ↓
Wait for Codex exit
  ↓
Stop bridge
  ↓
Restore original config
  ↓
Verify restore
```

Нельзя перезаписывать пользовательский config без backup.

Использовать atomic write + rename.

---

# 26. Crash Recovery

При следующем запуске после crash:

1. найти stale runtime session;
2. проверить lock/PID;
3. определить, остался ли temporary config;
4. проверить checksum/mtime;
5. восстановить исходный config, если это безопасно;
6. не затереть более новый config пользователя.

Backups должны иметь timestamp, а не один безымянный `.bak`.

---

# 27. Claude Code Runtime

Для Claude Code предпочтительно создавать environment только для дочернего процесса:

```text
Provider Switcher
   ↓
child environment
   ↓
ANTHROPIC_BASE_URL=...
ANTHROPIC_AUTH_TOKEN=...
ANTHROPIC_MODEL=...
ANTHROPIC_CUSTOM_HEADERS=...
   ↓
claude
```

Глобальное environment пользователя после закрытия процесса не должно изменяться.

---

# 28. Client Selection

Для модели:

```text
Preferred client:
- Auto
- Codex
- Claude Code
```

`Auto` выбирает лучший клиент по compatibility profile.

Пользователь всегда может override.

---

# 29. Prompt Profiles / Agent Prompts

Профиль должен содержать:

- name;
- description;
- instructions;
- preferred provider;
- preferred logical model;
- preferred client;
- reasoning level;
- fallback policy;
- optional client flags.

Пример:

```yaml
name: Practical Coding
instructions: |
  Work practically.
  Inspect existing implementation first.
  Do not run redundant tests.
  Test only what is necessary to validate the change.
  Prefer fixing the actual issue over unrelated abstractions.
client: auto
model: gpt-x
reasoning: xhigh
```

Prompt profile не должен содержать API keys.

---

# 30. Secrets

API keys нельзя хранить:

- в git;
- в обычном YAML provider profile;
- в diagnostics bundle;
- в логах;
- в temporary config, если есть безопасный env-вариант.

Предпочтительно:

1. Windows Credential Manager / DPAPI;
2. OS keychain abstraction;
3. environment variable;
4. encrypted local store.

`.env` — только compatibility fallback с предупреждением.

---

# 31. Log Redaction

Центральный redaction layer должен скрывать:

- Authorization;
- x-api-key;
- cookies;
- custom secret headers;
- query tokens;
- secret JSON fields.

Полные prompt/request bodies по умолчанию не логировать.

---

# 32. Diagnostics

## Provider Doctor

Пример:

```text
AgentRouter Diagnostics

Connectivity      PASS
Authentication    PASS
Models            PASS (12 discovered)
Responses         DEGRADED
Chat              PASS
Streaming         PASS
Tools             PASS

Detected fixes:
- client identity headers
- tool history normalization
- terminal event normalization

Codex             Compatible via adapter
Claude Code       Not tested
```

## Model Doctor

```text
Model X
Basic inference       PASS
Streaming             PASS
Tools                 PASS
Tool continuation     PASS
Reasoning             DEGRADED
Images                UNKNOWN
Last error            none
```

---

# 33. Error Normalization

Внутренние типы:

```text
AUTH_ERROR
PERMISSION_ERROR
MODEL_NOT_FOUND
RATE_LIMIT
QUOTA_EXCEEDED
PROVIDER_UNAVAILABLE
TIMEOUT
NETWORK_ERROR
INVALID_REQUEST
UNSUPPORTED_FEATURE
PROTOCOL_ERROR
STREAM_ERROR
INCOMPLETE_RESPONSE
UNKNOWN
```

Хранить raw HTTP status и sanitized error body.

---

# 34. UI

## Главный экран

```text
Provider Switcher

Providers
------------------------------------------------
AgentRouter        ONLINE        8/9 models
GoRouter           DEGRADED      6/8 models
Custom X           OFFLINE       0/3 models

Models
------------------------------------------------
GPT-X   AgentRouter   ONLINE   Codex ✓   Claude ~
GPT-X   GoRouter      ONLINE   Codex ✓   Claude ?
Opus    GoRouter      ONLINE   Codex ~   Claude ✓
```

## Launch screen

Выбор:

- project folder;
- client;
- provider;
- model;
- prompt profile;
- fallback policy;
- reasoning level.

Перед запуском:

```text
Client:    Codex CLI
Provider:  AgentRouter
Model:     GPT-X
Adapter:   Enabled
Fallback:  GoRouter / GPT-X
Prompt:    Practical Coding
```

## Active session

```text
Client: Codex
Provider: AgentRouter
Model: GPT-X
Bridge: 127.0.0.1:<port>
Requests: 18
Fallbacks: 0
Protocol errors: 0
```

Provider Switcher не обязан отображать сам чат.

---

# 35. Local Bridge

Для несовместимых providers запускать private bridge:

```text
127.0.0.1:<random-free-port>
```

Требования:

- не слушать `0.0.0.0` по умолчанию;
- отдельный bridge на runtime session;
- случайный свободный порт;
- закрытие вместе с client session;
- no permanent daemon в MVP;
- минимальный streaming overhead.

---

# 36. Storage

Пример структуры:

```text
~/.provider-switcher/
  providers/
  prompts/
  runtime/
  backups/
  logs/
  cache/
  data.db
```

Для health/session history рекомендуется SQLite.

Secrets в SQLite plaintext хранить нельзя.

---

# 37. Предлагаемая архитектура

```text
provider-switcher/
│
├─ src/
│  ├─ core/
│  │  ├─ sessions/
│  │  ├─ routing/
│  │  ├─ fallback/
│  │  ├─ health/
│  │  └─ state-machine/
│  │
│  ├─ clients/
│  │  ├─ codex/
│  │  └─ claude/
│  │
│  ├─ protocols/
│  │  ├─ canonical/
│  │  ├─ openai-responses/
│  │  ├─ openai-chat/
│  │  └─ anthropic-messages/
│  │
│  ├─ providers/
│  │  ├─ generic-openai/
│  │  ├─ generic-anthropic/
│  │  ├─ agentrouter/
│  │  ├─ gorouter/
│  │  └─ registry/
│  │
│  ├─ compatibility/
│  │  ├─ fixes/
│  │  ├─ detector/
│  │  └─ capability-matrix/
│  │
│  ├─ bridge/
│  │  ├─ http/
│  │  ├─ sse/
│  │  └─ lifecycle/
│  │
│  ├─ config/
│  │  ├─ backups/
│  │  ├─ runtime/
│  │  └─ recovery/
│  │
│  ├─ security/
│  │  ├─ secrets/
│  │  └─ redaction/
│  │
│  └─ diagnostics/
│
└─ tests/
```

---

# 38. Технологический стек — рекомендация

Так как существующий AgentRouter Codex Bridge уже использует Node.js, логично начать с:

### Core

- Node.js 20+;
- TypeScript;
- native fetch / совместимый HTTP stack;
- runtime schema validation;
- SQLite.

### UI

Варианты:

- Tauri;
- Electron;
- local web UI + Node backend.

Core не должен зависеть от выбранного UI framework.

---

# 39. Capability Matrix

Capabilities:

```text
text
streaming
tools
parallel_tools
reasoning
images
web_search
long_context
usage
cancellation
model_discovery
```

Для каждой:

```text
SUPPORTED
UNSUPPORTED
DEGRADED
UNKNOWN
```

---

# 40. Provider/Client Version Drift

Provider API и сами Codex/Claude могут меняться.

Хранить:

- detected client version;
- last successful compatibility check;
- provider schema fingerprint;
- first seen / last seen;
- last compatibility change.

Если ранее рабочий provider начинает возвращать другой schema, показывать `Compatibility changed`, а не просто падать без объяснения.

---

# 41. Test Strategy

## Unit tests

Обязательны для:

- request normalization;
- response normalization;
- SSE parser;
- tool state machine;
- fallback decisions;
- config backup/restore;
- secret redaction.

## Fixture tests

Хранить sanitized fixtures:

- valid response;
- missing field;
- malformed usage;
- missing terminal event;
- duplicate event;
- tool call;
- tool result;
- network cut.

## Integration tests

Не запускать real paid API на каждое изменение.

Запускать:

- вручную;
- перед release;
- после изменений соответствующего adapter;
- optional nightly.

## Fault injection

Полезные сценарии:

- connection reset before response;
- reset after first token;
- reset after tool call;
- timeout;
- malformed SSE;
- duplicate SSE;
- 401;
- 429;
- 500;
- missing terminal event.

---

# 42. Regression Cases из AgentRouter опыта

Обязательные regression tests:

1. `401 unauthorized client detected` корректно диагностируется/исправляется.
2. Identity headers передаются.
3. API key не попадает в публичный config, если можно использовать env/secret store.
4. Tool call корректно переводится в client format.
5. Tool result связывается с правильным call.
6. После final answer нет нового автоматического request.
7. Stream close не вызывает blind replay.
8. Missing metadata нормализуется только безопасно.
9. Codex config восстанавливается после normal exit.
10. Crash recovery не уничтожает оригинальный config.

---

# 43. Security и Privacy

1. Bridge слушает только loopback.
2. Secrets redacted.
3. Telemetry отсутствует по умолчанию.
4. Raw prompt logging выключен.
5. Runtime config очищается.
6. Child process получает только необходимые secrets.
7. Полное environment не логируется.
8. Provider metadata никогда не исполняется как код.
9. Diagnostics export по умолчанию не содержит prompts/source files.
10. Provider Switcher сам не читает project files без необходимости — этим занимается выбранный coding client.

---

# 44. Производительность

Bridge не должен заметно замедлять model output.

Требования:

- не буферизовать весь ответ перед передачей клиенту;
- event-by-event streaming;
- не выполнять health inference в hot path;
- кэшировать capability detection;
- использовать connection reuse;
- минимизировать JSON transformations.

---

# 45. Failure UX

Вместо:

```text
Something went wrong
```

показывать причину:

```text
Provider returned 401.

API endpoint is reachable, but authentication/client identity was rejected.

Suggested action:
Run provider diagnostics or enable the detected identity-header fix.
```

При небезопасном retry:

```text
Provider connection was lost after a tool operation.

Automatic replay was blocked because the previous operation may have
modified the project.

Session state was preserved.
```

---

# 46. Этапы разработки

## Phase 1 — Multi-provider launcher

- providers CRUD;
- secret storage;
- model discovery;
- AgentRouter;
- GoRouter;
- generic OpenAI provider;
- Codex launch;
- temporary config;
- backup/restore;
- cheap health check;
- basic dashboard;
- logs.

Без автоматического fallback.

## Phase 2 — Compatibility Engine

- canonical protocol;
- Responses adapter;
- Chat Completions adapter;
- SSE normalizer;
- tools;
- anti-replay;
- anti-recursion state machine;
- terminal validation;
- Provider Doctor;
- Model Doctor.

## Phase 3 — Claude Code

- Anthropic Messages;
- Claude runtime environment;
- custom headers;
- generic Anthropic provider;
- OpenAI -> Anthropic adapter;
- Claude-specific health status.

## Phase 4 — Safe Fallback

- logical models;
- provider priority;
- circuit breaker;
- safe fallback;
- sticky session;
- stateful continuation;
- side-effect barrier.

## Phase 5 — Profiles

- agent prompts;
- project profiles;
- preferred model/provider/client;
- reasoning presets;
- fallback presets.

## Phase 6 — Advanced

- Linux/macOS;
- Bedrock;
- Vertex;
- Foundry;
- local models;
- usage/cost dashboard;
- import/export profiles;
- provider plugin SDK.

---

# 47. Критерии приёмки MVP

MVP готов, если:

1. Можно добавить минимум два разных provider.
2. Модели обоих providers отображаются в одном интерфейсе.
3. Можно увидеть ONLINE/DEGRADED/OFFLINE/AUTH_ERROR.
4. Можно выбрать provider + model.
5. Можно запустить Codex в выбранной project directory.
6. При необходимости local bridge запускается автоматически.
7. После закрытия Codex исходный config восстановлен.
8. После crash доступно безопасное recovery.
9. 401/provider errors объясняются понятным текстом.
10. Bridge не делает blind retry после partial stream/tool operation.
11. Tool call history не дублируется.
12. Секреты не попадают в обычные logs.
13. Deep diagnostics не запускается бессмысленно.
14. AgentRouter работает не хуже существующего `agentrouter_for_codex`.

---

# 48. Критерии приёмки Claude Code этапа

1. Можно выбрать Claude Code как client.
2. Environment применяется только к дочернему процессу.
3. Anthropic-compatible gateway подключается без ручного изменения глобальных настроек.
4. Model status показывается отдельно от Codex.
5. Streaming работает.
6. Tools работают.
7. Required Anthropic headers сохраняются.
8. После закрытия Claude Code глобальное environment пользователя не изменено.
9. OpenAI-compatible provider может работать через adapter, если capabilities достаточны.

---

# 49. Критерии приёмки Fallback

1. Два providers настроены на одну logical model.
2. Primary provider недоступен до начала ответа.
3. Request переключается на secondary provider.
4. Пользователь видит уведомление.
5. Если primary падает после side effect, full replay не выполняется.
6. Если state можно безопасно продолжить — используется continuation.
7. Если нельзя — session останавливается безопасно.
8. Рекурсивный повтор tool call невозможен.

---

# 50. Основные риски

## API fragmentation

**Риск:** каждый «compatible» provider отличается.  
**Решение:** capability detector + canonical protocol + adapters + scoped fixes.

## Client updates

**Риск:** Codex/Claude меняют поведение.  
**Решение:** отдельные client adapters + version detection + regression fixtures.

## Unsafe retry

**Риск:** повторная запись/команда.  
**Решение:** state machine + side-effect barrier + no blind replay.

## `/models` врёт о health

**Решение:** cheap inference + real-traffic signals.

## Config corruption

**Решение:** atomic writes + backup + crash recovery.

## Secret leak

**Решение:** central redaction + OS secret store.

---

# 51. Принципы разработки

1. Не делать core-fix только под один provider, если проблему можно выразить общим rule.
2. Provider-specific исключения изолировать.
3. Не запускать бесполезные тесты.
4. Не делать blind retries.
5. Не скрывать compatibility fixes от diagnostics.
6. Не менять permanent configs без backup.
7. Не считать `/models` доказательством работоспособности.
8. Не считать HTTP 200 доказательством полной совместимости.
9. Не считать Codex CLI и Claude Code одинаковыми клиентами.
10. Не превращать Provider Switcher в ещё один coding agent.

---

# 52. Definition of Done для compatibility fix

Fix считается готовым, если:

- описана исходная проблема;
- есть reproduction или sanitized fixture;
- есть regression test;
- fix ограничен нужным scope;
- он не ломает совместимые providers;
- его применение видно в diagnostics;
- неизвестная ситуация обрабатывается безопасно.

---

# 53. Пример пользовательского сценария

```text
1. Пользователь запускает Provider Switcher.

2. Добавляет AgentRouter и GoRouter.

3. Приложение:
   - проверяет authentication;
   - получает models;
   - делает дешёвый health check;
   - определяет compatibility;
   - применяет известные fixes.

4. Dashboard показывает:
   GPT-X / AgentRouter    ONLINE
   GPT-X / GoRouter       ONLINE
   Opus / GoRouter        DEGRADED
   Model Z                OFFLINE

5. Пользователь выбирает проект.

6. Выбирает:
   Client: Auto
   Logical Model: GPT-X
   Primary: AgentRouter
   Fallback: GoRouter
   Prompt Profile: Practical Coding

7. Provider Switcher:
   - создаёт runtime session;
   - делает backup config;
   - запускает bridge;
   - запускает Codex.

8. Пользователь работает как обычно.

9. Если AgentRouter падает до начала следующего ответа,
   safe fallback переключает запрос на GoRouter.

10. Если provider падает после потенциального side effect,
    full replay блокируется.

11. После закрытия Codex bridge останавливается,
    исходный config восстанавливается.
```

---

# 54. Что нужно переиспользовать из AgentRouter Codex Bridge

При разработке нового проекта следует переиспользовать рабочие идеи/код там, где это разумно:

- local compatibility bridge;
- provider identity headers;
- model discovery;
- function/custom tools;
- правильную tool history;
- защиту от recursive tool loop;
- temporary Codex config;
- dated backups;
- crash recovery;
- private bridge process per session;
- random free local port;
- automatic bridge shutdown вместе с launcher.

При этом AgentRouter должен стать **одним из providers**, а не фундаментом всей архитектуры.

---

# 55. Технические ограничения клиентов, учтённые в ТЗ

## Codex

Codex имеет provider-specific configuration и wire protocol настройки. Поэтому для него нужен отдельный client adapter и нельзя рассчитывать, что любой OpenAI-like API заработает напрямую без нормализации.

## Claude Code

Claude Code официально поддерживает LLM gateway-подход и переопределение API endpoint через `ANTHROPIC_BASE_URL`, а также custom authentication/headers. Gateway может предоставлять Anthropic Messages API; для полной совместимости важна корректная передача Anthropic-specific headers и semantics.

Это подтверждает архитектурное решение: Codex и Claude Code должны быть двумя отдельными клиентами поверх общего Provider Switcher core.

---

# 56. Источники

- AgentRouter Codex Bridge: https://github.com/MEGAJava505/agentrouter_for_codex
- OpenAI Codex / Amazon Bedrock provider configuration: https://help.openai.com/en/articles/20001253-configure-codex-with-amazon-bedrock
- Claude Code LLM gateway configuration: https://code.claude.com/docs/en/llm-gateway
- Claude Code environment variables: https://code.claude.com/docs/en/env-vars
- Claude Code model configuration: https://code.claude.com/docs/en/model-config

---

# 57. Итоговая формулировка продукта

> **Provider Switcher — локальный multi-provider manager и compatibility gateway для Codex CLI и Claude Code, который позволяет подключать сторонние AI API, определять реальную работоспособность моделей, исправлять protocol incompatibilities, безопасно управлять runtime-конфигурацией и выполнять failover без опасного повторного выполнения агентских действий.**

Ключевые инженерные области:

1. Provider abstraction.
2. Codex adapter.
3. Claude Code adapter.
4. Canonical protocol.
5. Streaming/SSE correctness.
6. Tool-call state machine.
7. Anti-replay / anti-recursion.
8. Temporary config lifecycle.
9. Model health monitoring.
10. Safe provider fallback.
11. Provider diagnostics.
12. Secret management.

Если эти слои реализованы правильно, добавление нового провайдера должно сводиться к provider profile/adapter и набору точечных compatibility rules, а не к переписыванию всей системы.
