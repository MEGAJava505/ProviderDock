# OMP: возможности и gates полного отказа от Claude Code / Codex CLI

Дата исследования: **2026-09-14**. Это исследовательский sidecar для общего плана миграции, **не реализация и не master-план**.

## 1. Основание и краткий вывод

Исследован исходный код **`unsigned-gg/omp` на commit `0c6c981ee5838d97700180383077eb0a3790637c`**. Использован уже существующий чистый checkout `.scratch/omp`; повторного скачивания не было. `git rev-parse HEAD`, `git ls-remote https://github.com/unsigned-gg/omp.git refs/heads/main` и [GitHub commits/main API][main-api] вернули один SHA: **текущий `main` на момент проверки не отличается от pin**.

`docs/omp-assessment.md` прочитан исключительно как неавторитетная предыдущая заметка и не изменён. Его заключения о сохранности локальных данных здесь не подтверждаются и не используются.

Обозначения доказательности:

- **Код** — механизм найден в закреплённой реализации; это не результат запуска.
- **Тест в upstream** — прочитана синтетическая проверка; **тесты в этой работе не запускались**.
- **Документация** — заявление самого проекта; при расхождении приоритет у кода.
- **Вывод / gate** — инженерная рекомендация, которую предстоит проверить.

**Рекомендация:** OMP подходит как целевой **единственный coding-agent runtime**, заменяющий оба официальных CLI, а не как дополнительный мост к ним. Практичная граница — отдельный OMP-процесс через RPC/RPC-UI, собственные OMP-сессии и прямые provider adapters. Встраиваемый SDK — альтернативный путь для Bun-host, ACP — для совместимого редактора. Управление порталами/балансами и защищённое хранение секретов остаются отдельными ответственностями.

**Безусловный первый gate cutover — approvals + OS-level sandbox.** Наличие tool prompts, ACP и task isolation у OMP не доказывает эквивалентность ограничениям официальных CLI. До закрытия этого gate полный переход нельзя считать безопасно готовым. Это ограничение готовности, а не предложение оставить Claude/Codex обязательными компонентами конечной архитектуры.

### Важная оговорка о поставке

[GitHub API][repo-api] определяет выбранный репозиторий как fork; [список releases][releases-api] на момент проверки пуст. При этом manifest содержит версию `18.0.4`, а metadata и Windows installer направляют к **`can1357/oh-my-pi`**, не к `unsigned-gg/omp`. Следовательно, upstream Windows binary / npm package нельзя автоматически считать сборкой исследованного SHA. Нужен отдельный gate provenance: выбранный репозиторий → точный commit → проверенный артефакт. [`package.json`][package], [`install.ps1`][installer-origin].

## 2. Приоритетный gate: approvals и sandbox

### Что реализовано в OMP

| Механизм | Проверенное поведение | Следствие для миграции |
| --- | --- | --- |
| `tools.approvalMode` | `yolo` — schema default; `always-ask` автоматически разрешает `read`, спрашивает `write`/`exec`; `write` спрашивает только `exec`. | `always-ask` **не** означает подтверждение каждого чтения. Не переносить названия режимов Claude/Codex как эквивалентные. |
| Per-tool policy | `allow` / `deny` / `prompt`; deny имеет приоритет. Неизвестный/malformed approval tier трактуется как `exec`. MCP tools документированы как `write`. | В режиме `write` вызов MCP может пройти автоматически. Нужен явный allowlist и policy для MCP, `eval`, `task`, browser/computer, а не только bash. |
| Нет UI для approval | Общая tool wrapper выбрасывает ошибку, если необходим prompt, но нет interactive UI. | Правильное поведение интеграции — отказ/отмена, а не автоматическое включение `yolo` ради headless. |
| Bash pattern rules | Проверяют bash tool; не распространяются на subprocess из `eval`. В `yolo` bare critical override не заставляет спрашивать, хотя explicit `prompt`/`deny` сохраняются. | Pattern blacklist не является системной изоляцией. |
| Subagents | Исполнитель устанавливает дочерним агентам `tools.approvalMode: yolo`; per-tool policies сохраняются. Parent `task` approval — граница авторизации. | Одно подтверждение делегирования не даёт пошагового контроля ребёнка. `prompt` без UI приводит к отказу, а не к вопросу родителю. |

Источники: [approval contract][approval-doc], [schema default][approval-default], [реальный resolver][approval-source], [no-UI fail-closed][approval-no-ui], [subagent override][subagent-approval].

**ACP имеет дополнительную, но не универсальную permission gate.** При обычной конфигурации клиентская gate сохраняется даже при schema-default `yolo`; **явный** `yolo` снимает её, если per-tool policy не требует prompt/deny. Gate зависит от предоставленной capability/method `requestPermission`. Список включает `bash`, `edit`, `delete`, `move`, однако для `edit` специальный intent создаётся **только для delete/move**, не для каждого редактирования; `write` в этом списке отсутствует. Общие approvals отдельно идут через form elicitation при поддержке клиента. Поэтому ACP нельзя считать «все записи обязательно подтверждаются редактором». [Код gate][acp-gate], [intent][acp-intent], [документация ACP approvals][acp-approval-doc].

### Чего эти механизмы не доказывают

- В проверенных execution/approval путях не найден эквивалент OS-enforced ограничения файловой системы и сети официальных CLI. Extensions прямо документированы как **unsandboxed, в том же процессе**. `--no-extensions` отключает discovery extension factories, но не весь MCP/skills/tools/config discovery. [Граница extensions][extension-isolation], [ограниченность флага][extension-disable].
- `task.isolation.mode` по умолчанию `none`; `auto`, `projfs`, `block-clone`, `rcopy` и другие backends описывают копирование/CoW/worktree и последующее применение diff. Это изоляция рабочего дерева, **не доказательство запрета чтения домашнего каталога, доступа к vault или сетевого выхода**. [Schema isolation][task-isolation].
- RPC — привилегированный локальный control channel. Например, RPC `bash` использует путь пользовательской bang-команды, а не model-facing bash interception; отключение `bash.enabled` не отключает этот RPC command. Не отдавать сырой RPC недоверенному UI/плагину. [Разделение bash surfaces][bash-surfaces].
- Некорректное значение `--approval-mode` в setter лишь логируется warning и не устанавливает override. Wrapper/launcher должен сам валидировать перечисление: опечатка не должна оставлять незаметный default `yolo`. [CLI setter][flag-approval].

### Сравнение с официальными CLI

Официальная [Codex Agent approvals & security][codex-security] разделяет sandbox (технические ограничения filesystem/network) и approval policy; описывает OS-enforced sandbox, workspace-write/read-only, отключённую по умолчанию сеть, нативный Windows sandbox и Linux sandbox в WSL2. Это **публичный контракт продукта**, не аудит текущей локальной настройки пользователя.

Официальная [Claude Code sandboxing][claude-sandbox] описывает OS-enforced filesystem/network ограничения Bash и его дочерних процессов: Seatbelt на macOS, Linux/WSL2 sandbox; **нативный Windows не поддерживается этим Bash sandbox**. [Permissions][claude-permissions] — отдельный слой правил deny → ask → allow. Поэтому неверно как приписывать всем запускам Claude на Windows sandbox, так и считать OMP prompts заменой sandbox Codex.

**Критерий приёмки:** выбранный способ запуска OMP должен отдельно продемонстрировать запрет чтения защищённых путей, записи вне разрешённых корней и запрещённого network egress, в том числе через `eval`, shell children, MCP, extensions и subagents. Если это обеспечивает внешний container/VM/OS policy, проверить именно Windows-развёртывание и границы mounted directories. Одного `--approval-mode always-ask` недостаточно.

## 3. CLI, RPC, SDK и ACP — разные интерфейсы

### Проверенные launch flags

Парсер/таблицы и CLI reference содержат:

- workspace/state: `--cwd`, повторяемый `--add-dir`, `--profile`, повторяемый `--config`, `--session-dir`, `--no-session`;
- history: `--continue` / `-c`, `--resume [id|path]` / `-r` / `--session`, `--fork`, `--from-claude`, `--from-codex`, `--export`;
- model: `--model`, legacy `--provider`, `--models`, `--smol`, `--slow`, `--plan`, `--thinking`, `--provider-session-id`, `--prompt-cache-key`, `--service-tier`;
- runtime: `-p` / `--print`, `--mode text|json|rpc|rpc-ui|acp`, `--tools`, `--no-tools` (built-ins), `--no-lsp`, `--no-pty`, `--approval-mode`, `--yolo` / `--auto-approve`, `--max-time`, `--no-title`;
- discovery: `--extension` / `-e`, `--hook`, `--trusted-extension`, `--plugin-dir`, `--no-extensions`, `--no-skills`, `--no-rules`.

`--plan <id>` выбирает **модель-ролевое назначение**, не аналог sandbox read-only. `--plan-yolo` предусматривает автоматическое одобрение плана с переходом к реализации. `--api-key` существует, но для миграции не рекомендуется передавать секреты в argv. [CLI reference][cli], [Args][args], [flag tables][flags].

### RPC

Это **собственный NDJSON протокол**, а не drop-in JSON-RPC 2.0 или официальный Codex app-server: команды вида `{"id":"r1","type":"get_state"}`, ответы `type:"response", command, success, data/error`. Название «JSON-RPC» в краткой CLI-таблице не заменяет реальную wire schema. [Типы команд][rpc-types], [контракт ответов][rpc-responses].

Есть `prompt`, `steer`, `follow_up`, `abort`, `new_session`, `set_model`, `get_state`, paginated messages, session switch/branch/export, retry controls, host tools/URI и подписка на subagents. На старте `ready`: v1, поддержка `[1,2]`, physical frame 1 MiB, reassembly 64 MiB; v2 требует negotiation и проверки последовательности `rpc_chunk`. Входящие команды остаются unchunked JSONL. [Transport][rpc-framing].

**ACK prompt ≠ завершение задачи:** `prompt` возвращает success до окончания работы, поздняя ошибка может прийти с тем же id. Нужны lifecycle events, `prompt_result` для local-only команд, обработка error/abort/retry и terminal state; порядок concurrent ответов не гарантирован. Нельзя повторять prompt только потому, что клиент не дождался ответа. `rpc-ui` предоставляет UI requests, на которые host должен отвечать; это не готовая замена существующего dashboard. [Контракт lifecycle][rpc-lifecycle], [код async scheduling][rpc-prompt].

### SDK

`createAgentSession`, `SessionManager`, `Settings`, `AuthStorage`, `ModelRegistry`, tool/discovery APIs и typed events действительно экспортированы. **SDK предназначен для Bun-процесса, Bun >= 1.3.14**, не обещает stock Node runtime. Default creation включает discovery config/extensions/MCP/LSP и file-backed sessions; это не чистая функция без IO. Для нескольких top-level sessions рекомендован отдельный `AgentRegistry` на каждую. [SDK][sdk], [manifest][package].

README говорит «embed in Node», но специализированная SDK-документация, `engines.bun` и фактический `bun:sqlite` делают предположение о прозрачном Node-встраивании необоснованным. Для Node-host предпочтительнее process boundary RPC, с проверкой выбранного клиентского wrapper. [README wording][readme-sdk], [SQLite import/serialization][credential-json].

### ACP

Реализован JSON-RPC поверх `ndJsonStream` через `AgentSideConnection`. `initialize` объявляет load/list/fork/resume/close sessions, image/embedded context и MCP HTTP/SSE; есть собственные handlers new/load/resume/prompt/cancel. Это реальная реализация, но не доказательство полной совместимости с каждым ACP client и его расширениями. [Transport][acp-mode], [capabilities][acp-capabilities]. Требуются conformance/permission/cancellation проверки именно целевого редактора.

## 4. Bun, Windows и native dependencies

| Способ использования | Что требуется |
| --- | --- |
| Исходники / установленный TS-package / in-process SDK | Bun >= 1.3.14 — **runtime requirement**, не только build tool. |
| Compiled CLI | Build использует `Bun.build({compile: ...})`, то есть standalone executable с runtime внутри. Для основного пути отдельный установленный `bun.exe` не является обязательным. |
| Сборка native addons | Rust/Cargo либо Bazel/toolchains на стороне сборки; не обязательный Rust toolchain на каждом клиентском ПК. |
| Расширенные возможности | Standalone не означает «всё внутри»: `fastembed`/`onnxruntime-node` явно external/on-demand; language servers, выбранная shell и другие feature dependencies требуют отдельной проверки. |

[SDK/runtime manifest][package], [compile implementation][compile], [native build contract][native-build].

Release target явно содержит **`omp-windows-x64.exe` / `bun-windows-x64-baseline`**. Windows ARM64 target нет; native loader поддерживает `win32-x64`, а не `win32-arm64`. Эмуляция ARM64 не проверялась. `.node` addon встроен/извлекается в versioned cache, остаётся платформенно-зависимым; ошибки загрузки/несовпадения версии могут происходить до первого запроса. [Binary targets][binary-targets], [loader][native-loader].

Build contract задаёт Windows native baseline x86-64-v2 и static CRT для MSVC addon; это намерение сборки, **не проведённая проверка DLL-зависимостей/CPU/антивируса на данном ПК**. Installer ищет Git Bash, иначе сообщает о built-in shell; Git for Windows полезен для snapshots/interactive terminals, но не заявлен обязательным для любого запуска. [Native build][native-build], [Windows shell handling][installer-shell].

Installer имеет `-Binary` и `-Source`, но это не инструкция запускать его сейчас. В `-Binary` код скачивает release и сразу пишет success; подтверждение старта/проверку hash нужно включить в приёмку отдельно. В выбранном fork releases пока нет (раздел 1). [Installer binary branch][installer-binary].

## 5. Точная форма `models.yml` и выбор протокола

Файл по умолчанию `~/.omp/agent/models.yml`, затем `.yaml`; legacy `.json` может автоматически мигрироваться. Root schema — объект с опциональным `providers`, mapping `provider-id → config`; model/credential identity — конкретные `provider + model id`, не display name. Для deterministic selection использовать точный `provider/model-id`. [Загрузка][models-doc], [идентичность][model-identity], [schema][model-schema].

### Минимальный custom provider без секретов

**Иллюстрация конфигурации, не созданный config и не команда запуска.** Endpoint `.invalid`, model ID и имя env являются заглушками; схема сверена статически, runtime validation не выполнялась.

```yaml
providers:
  migration-chat:
    baseUrl: https://gateway.example.invalid/v1
    api: openai-completions
    apiKey: MIGRATION_CHAT_API_KEY
    models:
      - id: exact-upstream-model-id
```

`MIGRATION_CHAT_API_KEY` — **имя переменной**, не значение ключа. Важная ловушка: если переменная отсутствует/пуста, resolver возвращает эту строку как **literal bearer**, а не ошибку «env missing». В будущем exporter/launcher обязан заранее fail-closed проверить наличие значения, не логируя его. Можно вместо этого выбрать command resolver с отказом при ошибке; это отдельный gate, не выполненная интеграция. [Resolver][secret-resolver].

### Schema: не путать с settings `config.yml`

- Provider fields: `baseUrl?: string`, `apiKey?: string`, `api?: Api`, `headers?: Record<string,string>`, `compat?`, `remoteCompaction?`, `authHeader?: boolean`, `auth?: "apiKey"|"none"|"oauth"`, `discovery?`, `models?: ModelDefinition[]`, `modelOverrides?: Record<string,ModelOverride>`, `disableStrictTools?: boolean`, `guardrailIdentifier?`, `guardrailVersion?`, `guardrailTrace?: "enabled"|"disabled"|"enabled_full"`, `transport?: "pi-native"`. [Полная provider schema][provider-schema].
- При **непустом `models`** runtime validator требует provider-level `baseUrl`, `api` на provider или на каждом model, непустой model `id`; `apiKey` обязателен кроме `auth:none` **или `auth:oauth`**. Положительные `contextWindow`/`maxTokens`, если заданы. Override-only provider должен содержать хотя бы одно полезное override/discovery поле. [Validator][model-validator].
- **Расхождение с docs:** `docs/models.md` утверждает, что `auth:oauth` не отменяет требование `apiKey`. На этом SHA код отменяет; есть соответствующий upstream unit test. Это лишь прохождение validation: произвольный custom provider не получает OAuth login implementation автоматически. Регистрация нового OAuth flow — programmatic provider/extension API. [Устаревшее утверждение][models-auth-doc], [тест][models-auth-test], [registration][provider-registration].
- Model definition: обязательный `id`; остальные поля включают `name`, `api`, `baseUrl`, `reasoning`, `thinking`, `input: ("text"|"image")[]`, `imageInputDecoder:"stb"`, `tokenizer`, `supportsTools`, `cost`, `premiumMultiplier`, `contextWindow`, `maxTokens`, `omitMaxOutputTokens`, `headers`, `compat`, `contextPromotionTarget`, `compactionModel`, `remoteCompaction`. Если `cost` задан для нового model, нужны все четыре числа: `input`, `output`, `cacheRead`, `cacheWrite`; у `modelOverrides.cost` они sparse/optional. `thinking` задаётся через `mode` + `efforts` (также принимается legacy vocabulary), а не произвольным числом. [Model/override schema][model-schema].
- `compat` — конкретный набор полей, включая `maxTokensField`, поддерживаемые reasoning/tool-choice/strict/streaming поля, routing, `extraBody`, `whenThinking` и Anthropic/Bedrock flags. Нет универсального «все OpenAI-compatible одинаковы». `discovery.type`: `ollama`, `llama.cpp`, `lm-studio`, `openai-models-list`, `proxy`, `litellm`; timeout положительный; provider `api` обязателен кроме `proxy`. [Compat/API schema][compat-schema], [discovery/schema][provider-schema], [validator][model-validator].
- Fallback chains и роли живут в **settings `config.yml`** (`retry.fallbackChains`, `modelRoles`), не дополнительными root keys в `models.yml`. [Fallback settings][fallback-settings].

### Допустимые `api`

Ровно перечисленные schema варианты:

`openai-completions`, `openai-responses`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`. Значений `auto`, `chat`, `messages`, `agentrouter`, `gorouter` в `ApiSchema` нет. [ApiSchema][compat-schema].

- `openai-completions` — Chat Completions; к base URL добавляется `/chat/completions` после удаления завершающих `/`. [URL construction][chat-url].
- `anthropic-messages` — Messages; OMP сначала удаляет trailing `/` и конечный `/v1` из base URL, затем client добавляет `/v1/messages`. Передавать полный endpoint `/v1/messages` как base URL нельзя; итоговый URL gateway всё равно требует проверки. API key идёт через `X-Api-Key`, OAuth — через Authorization; `authHeader:true` явно добавляет bearer. Не назначать его автоматически профилю с header auth. [Нормализация][anthropic-url], [Anthropic client][anthropic-client], [клиентские auth options][anthropic-options], [header resolver][secret-resolver].
- `openai-responses` и `openai-codex-responses` не взаимозаменяемы: у Codex отдельные account/beta headers, websocket/SSE state и replay semantics. Не выбирать Codex wire только потому, что имя модели содержит GPT/Codex. [Endpoint distinctions][endpoint-constraints].
- `transport:pi-native` — отдельный transport к совместимому OMP auth-gateway `/v1/pi/stream`, не произвольный upstream HTTP proxy. [Provider schema][provider-schema].

**Применение к переданному parent inventory, без повторного чтения локальных профилей:** 10 явно `chat` (9 generic-openai + 1 gorouter) — кандидаты на `openai-completions`; 1 `messages/generic-anthropic/header` — кандидат на `anthropic-messages` с проверкой имени auth header и URL; **5 `auto`** (2 agentrouter + 3 generic-openai) заблокированы до явного протокольного решения. Название legacy adapter не доказывает protocol/compat parity. Нулевые `secretHeaders/queryParams` упрощают перенос, но не являются результатом OMP-проверки.

## 6. Секреты, DPAPI и единственный refresh owner

### Resolver — возможный seam, не готовая поддержка DPAPI

Для `apiKey` и provider/model `headers`:

1. Строка с `!` — shell command, trimmed stdout становится значением; **кавычки в YAML обязательны для такого строкового примера**, это не YAML tag. Например, концептуально `apiKey: "!vault-helper read opaque-reference"`; такого helper в проекте этим исследованием не создано.
2. Иначе проверяется env с **точным именем строки**, затем literal fallback. Это не синтаксис `${ENV}`.
3. Команда синхронная, timeout 10 s, `windowsHide:true`; успешный результат кэшируется в процессе, ошибки/пустой stdout negative-cached 30 s. `forceRefresh` в ModelRegistry может принудительно обновить command-backed key. [Resolver][secret-resolver], [forced refresh][command-refresh].

**Вывод:** можно спроектировать read-only helper, который остаётся владельцем доступа к DPAPI и отдаёт OMP только требуемый API key; либо передавать env только дочернему процессу. Это позволяет не переводить весь vault в plaintext SQLite, но **не** сохраняет защиту секрета в памяти OMP и не делает его недоступным дочерним процессам/unsandboxed extensions. Нужно отдельно проверить stdout/stderr, argv, crash dumps, env inheritance, кэширование и отзыв ключа. Нативного DPAPI/SQLCipher пути в исследованных OMP auth/config исходниках не найдено.

### SQLite at rest

Локальный store — `agent.db`; credential serializer сохраняет API key и OAuth fields через обычный `JSON.stringify` в `data TEXT`, читает `JSON.parse`; открывает обычный `bun:sqlite Database`. **Шифрования credential payload at rest здесь нет.** Есть попытки directory `0700`, file `0600`; chmod errors, в том числе Windows, игнорируются. Включены WAL и `synchronous=NORMAL`. Это не DPAPI и не проверенный Windows ACL boundary; DB/WAL/backup должны рассматриваться как секретные. [Serialization][credential-json], [open/permissions][credential-open], [WAL][credential-wal], [DDL][credential-ddl].

Secret obfuscation в OMP — отдельное отключённое по умолчанию преобразование текста перед отправкой модели; **не шифрование auth database и не замена vault**. [Secrets feature][secret-obfuscation].

### OAuth и refresh

Код поддерживает stored OAuth и provider-scoped auth, API key precedence, несколько accounts и refresh. Встроенные flows — возможность реализации, **не проверенная в этом исследовании авторизация, совместимость подписки или разрешение провайдера на использование стороннего клиента**. Никакие browser/device flows и внешние model calls не выполнялись. [Provider auth contract][provider-auth].

Для совместного локального SQLite есть durable per-credential lease, reread, renewal/CAS; upstream тест проверяет один mock refresh на две `AuthStorage` instances с общей DB. Это не глобальная блокировка на копии refresh token в другом vault или официальном CLI. [Lease implementation][refresh-leases], [ownership code][refresh-owner], [upstream test][refresh-test].

У auth-broker canonical vault/refresh owner централизован. Но важно различать:

- **Broker clients / gateway process:** `exportSnapshot()` редактирует **только `refresh`**, сохраняя API keys и access tokens. Называть этот snapshot «без секретов» нельзя.
- **Gateway-only consumers:** получают gateway bearer и вызывают gateway, не обязаны получать provider access/refresh tokens.
- Snapshot disk cache шифруется AES-256-GCM ключом из broker bearer; это отдельный механизм, **не** шифрование `agent.db`. TLS/network boundary обеспечивает оператор. [Snapshot code][broker-snapshot], [broker architecture][broker-doc], [snapshot cache][broker-cache].

**Gate владения:** выбрать ровно один canonical refresh owner на каждый OAuth account — OMP local store либо broker/другой явно спроектированный владелец. Не оставлять активные копии rotating refresh tokens в Claude, Codex, старом backend и OMP. Копирование DB/refresh token само по себе не миграционный протокол. Для API-key-only профилей OAuth/broker вообще не обязателен. `auth-broker import` ожидает CLIProxyAPI-style JSON; `migrate --from-local` — OMP SQLite, а не ProviderDock DPAPI importer. [Broker commands][broker-import].

## 7. Round-robin, fallback и replay после tools

### Три различных слоя

1. **Credential selection:** ключи `provider:type`; без session ID — process-local round-robin, с ID — hash-based start (`Bun.hash.xxHash32`) и session stickiness, дополненные блокировками/usage-aware ranking для поддерживаемых providers. Это не обещание равномерного распределения всех запросов и не аналог порядка UI-профилей. Config-pinned `apiKey` приоритетнее stored OAuth; один env/command key не превращается в пул. [Selection code][credential-selection], [precedence][provider-auth], [ranking interface][usage-ranking].
2. **Auth retry:** ordinary 401/auth failure — refresh того же account, затем ограниченная sibling rotation; 403/account-policy/usage failures могут вращать distinct siblings до undefined/cycle/лимита 64 attempts; concurrency caps исключены из части direct-rotation случаев. Streaming auth retry имеет свой pre-output buffer/veto. [Auth driver][auth-retry], [stream driver][stream-replay].
3. **AgentSession TurnRecovery:** normalized errors + provider-aware text fallback, backoff, model chains по role / exact model / provider wildcard. `retry.enabled` default true, max retries 10, base 500 ms, local cap 8 s с jitter, `maxDelayMs` default 300000; успешный switch даёт delay 0, fallback model получает новый budget. Hard pre-content errors тоже могут идти в configured model fallback; context overflow имеет отдельный recovery. [Retry contract][retry-doc], [hard error code][hard-fallback], [retry execution][retry-execution].

**Нет гарантии «мгновенного failover при любой 500».** Внутри provider adapters могут быть свои retries, например Anthropic client получает `maxRetries:5`; снаружи действуют auth/session recovery. Нужно измерять end-to-end dispatch latency и суммарный request budget, а не только `retry.baseDelayMs`. [Anthropic options][anthropic-options]. Missing config/disabled/unavailable model до запроса не обязаны попасть в эту provider-error retry цепочку.

### Replay safety: реализованные предохранители и пределы

- Общий retry отвергает replay при tool call, image, server-tool block и **committed** непустом text. Thinking/whitespace и ещё не committed buffered text допускаются. Поэтому формула «любая частичная text всегда запрещает retry» из кратких docs слишком груба для этого SHA. [Actual guard][replay-guard].
- Для malformed-function/classifier terminal cases есть узкое исключение: каждый tool call должен иметь synthetic result с `executed:false`; любой реальный/неопределённый result сохраняет veto. Это доказательство внутри runtime о **неисполнении**, не универсальная идемпотентность. [Guard details][replay-guard].
- Для reasonless abort, stream stall, HTTP/2 reset, premature close существует **preserve-and-continue**: если каждому emitted tool call соответствует result, сохраняются assistant + tool results, затем выполняется continuation. Это не повтор начального prompt с нуля. [Resolved-turn continuation][resolved-turn], [preserve/schedule][retry-preserve].
- Upstream тест запрещает timeout retry после streamed write call; другой тест проверяет continuation с одним сохранённым tool result. Это synthetic coverage, а не гарантия exactly-once внешнего side effect при kill/crash, потерянном reply, MCP timeout, частично выполненном shell command или повторной выдаче семантически того же действия моделью. [Write-veto test][replay-test], [continuation test][continuation-test].
- **Отдельный риск внутри MCP tool:** при retriable connection error (`ECONNRESET`, closed transport, некоторые HTTP 404/502/503 и т. п.) wrapper делает reconnect и повторяет `callTool` с теми же args. В этой ветке нет проверки, выполнил ли server первый side effect. AgentSession replay guard не предотвращает такой внутренний повтор. Нужна проверка идемпотентности/дедупликации для каждого consequential MCP tool. [Classifier][mcp-retry-classifier], [повтор вызова][mcp-retry].

**Gate для интегратора:** не накладывать внешний blind retry на целый RPC prompt. Проверить pre-header 401/429/5xx, disconnect после thinking/text/toolCall, side effect до/после result persistence, abort во время backoff и crash/restart. Для неясного результата инструмента — reconciliation/ручное решение, не автоматический replay. Upstream retry counters/`auto_retry_*`/`retry_fallback_*` должны быть видимы в UI отдельно от финальной ошибки.

Usage-aware fallback отдельно opt-in; unknown/unmapped usage не обеспечивает fail-closed квоту. Это особенно важно для custom gateways, у которых нет собственного usage adapter. [Settings/semantics][retry-usage].

## 8. Импорт сессий и нестандартные home paths

Native OMP sessions — JSONL, по умолчанию `~/.omp/agent/sessions/<encoded-cwd>`; `history.db` отдельно. `PI_CODING_AGENT_DIR`, profiles и `--session-dir` управляют соответствующими областями, но не дают process sandbox и не гарантируют перенос всех остальных config roots. Например, LSP lookup отдельно учитывает `PI_CONFIG_DIR`/profiles. [Session layout][session-layout], [dirs][dirs], [LSP roots][lsp].

| Source | Что делает importer | Ограничение cutover |
| --- | --- | --- |
| Claude Code | `ClaudeSessionStore()` использует `resolveClaudePaths()`: учитывает `CLAUDE_CONFIG_DIR`, colocated `.claude.json`; default `~/.claude` + `~/.claude.json`. Ищет `projects` / `.projects`, history index optional. Конструктор принимает explicit root. | Provider-scoped homes требуют явного inventory. Encoded cwd с дефисами/Windows paths нуждается в проверке project registry/metadata. |
| Codex | Default constructor жёстко `path.join(os.homedir(), ".codex")`, **не `CODEX_HOME`**. Explicit `rootDirectory` есть у класса. Сначала newest `state_N.sqlite` readonly, таблица `threads`; если найдены sessions, возвращает их; иначе JSONL fallback `sessions`, `.sessions`, `archived_sessions` + index. | CLI factory создаёт класс без root. `CODEX_HOME=custom` само по себе import root не переключает. Частичный state index не объединяется автоматически со всем JSONL fallback. |

[Claude resolver][claude-paths], [Claude constructor][claude-constructor], [Claude listing][claude-store], [Codex constructor/listing][codex-store], [factory][foreign-import]. Relocated Claude root покрыт upstream fixture test; это не проверка реальных пользовательских сессий. [Test][claude-import-test].

`--from-claude` / `--from-codex` открывают picker; несовместимы друг с другом, `--no-session`, `--continue`, `--resume`, `--fork`; в protocol mode они отклоняются. Пустой список/отмена picker завершаются exit 0 — это **не доказательство успешной миграции**. Нельзя предполагать, что `--from-codex --resume <path>` решит custom home. `/resume @claude` и `/resume @codex` тоже используют foreign import picker. [CLI restrictions][import-flags], [startup path][import-startup], [slash command docs][session-resume].

Importer конвертирует transcript в in-memory OMP SessionManager и `persistCopy` создаёт новую identity с provenance `source/sourceId/sourcePath/sourceCwd`; отсутствующий cwd может заменяться fallback cwd. Это **односторонний импорт контекста**, а не продолжение native CLI process/session и не перенос approval state, hooks, sandbox policy, live shell/MCP processes или auth. [Persistence code][foreign-import], [new identity test][import-test].

Конверсия зависит от известных record/content типов: например, Codex response-message branch сохраняет user/assistant, image conversion принимает data URL; unknown формы нельзя считать lossless. Usage может нормализоваться в пустые значения, поэтому импортированные logs не годятся автоматически для billing reconciliation. [Codex conversion][codex-conversion].

**Gate:** отдельный manifest всех default/legacy/provider-scoped home roots, explicit-root importer для Codex, backup originals, fresh-ID mapping/dedup, counts/tool linkage/compaction/images/cwd checks на синтетических и затем одобренных сессиях. Не подменять процессный `HOME` ради обхода: он влияет не только на источник истории. User credentials/transcripts в этой работе не читались.

## 9. Tools, LSP, MCP, extensions, subagents

- Реальный factory registry содержит read/write/edit, grep/glob/AST, bash/eval, browser/computer, LSP/debug, task/hub, todo, web search, memory и другие tools; часть создаётся условно (`createIf`). Это подтверждает самостоятельность OMP как agent harness, **не** идентичность поведения инструментам официальных CLI. Числа «31 tools / 60+ providers» — README summary, не проверенный здесь compatibility matrix. [Factory map][tools], [README counts][readme-counts].
- LSP auto-detection проверяет cwd root markers и наличие binary; `lsp.json` задаёт servers/config. Bundled definitions не означают установленные language servers. `--no-lsp` отключает и связанные diagnostics/formatting. [LSP][lsp], [CLI][cli].
- MCP реализует `stdio`, Streamable HTTP и legacy SSE; transports выбираются в коде. Есть reconnect/auth/cancellation lifecycle, но reconnect транспортного соединения сам по себе не делает side-effecting tool request идемпотентным; внутренний повтор tool рассмотрен в разделе 7. [Transport switch][mcp-source], [protocol docs][mcp-doc], [reconnect contract][mcp-lifecycle].
- Extensions/hooks/skills/context files и custom provider registration существуют; переносить надо содержательные capabilities, а не просто копировать каталоги `.claude`/`.codex`. Extensions выполняются с полномочиями процесса. [Extension loading][extension-isolation], [provider registration][provider-registration].
- Task agents имеют model/effort/spawn policy, depth cap и optional isolation; это **OMP subagents**, не обязательный запуск Claude/Codex executables. Их safety boundary рассмотрен выше; автоматически активировать всех child tools на cutover нельзя. [Task discovery/execution][task-doc], [headless override][subagent-approval].

## 10. Что OMP не заменяет в порталах и dashboard

`omp stats` действительно имеет web dashboard и SQLite-агрегации JSONL: latency/TTFT/tokens/cache/errors, API-equivalent cost estimates. Документация прямо отличает estimate для subscription models от счёта пользователя. [Stats][stats].

`omp usage` / broker usage endpoints показывают provider-specific quota windows/limits; тип `UsageReport` допускает `usd`, но наличие такого unit **не означает universal portal balance integration**. Fetcher может вернуть `null`, сведения могут быть cached/last-good. [Usage types][usage-types], [fetcher/ranking contract][usage-ranking], [broker cache][broker-usage].

Не найдено оснований считать эти функции готовой заменой:

- произвольных portal logins/cookies/accounts и связанных balance APIs;
- UI distinction `portalStatus` vs API credential availability vs agent runtime state;
- repair corrupted local accounts storage;
- существующего profile catalog / DPAPI vault / mappings generic-openai, agentrouter, gorouter;
- корректного frontend error mapping и lifecycle состояния запуска.

### Контекст от родительского исследования — не результаты этого source review

Parent сообщил: accounts file содержит **280047 NUL**; UI игнорирует `portalStatus` и показывает disconnected accounts; inventory — 16 включённых provider profiles с распределением из раздела 5, без secretHeaders/queryParams. Также выявлены renamed subclasses `ModelDisabledError` / `ModelUnavailableError`, не попавшие в whitelist `publicErrorMessage`, и отображение nonzero exit как `EXITED`.

Эти данные **не перепроверялись здесь**. Они отменяют использование прежнего общего тезиса «повреждения не обнаружено» как основания cutover. OMP не восстанавливает этот accounts file и не исправляет parent UI автоматически. Общий план должен отдельно закрыть целостность portal storage, различение статусов и readable validation/runtime errors; новые RPC events не должны повторить прежнюю потерю причин ошибок.

## 11. Компактные gates для master-плана

Все gates ниже **ещё не пройдены**; в этой работе нет installation/smoke/auth/model tests.

| Приоритет | Gate | Минимальное доказательство готовности |
| --- | --- | --- |
| **P0** | **Approvals + sandbox parity** | Явная policy, fail-closed без UI/при disconnect, deny для нужных MCP/eval/task paths, проверенный запрет FS/network вне scope на Windows; subagents/extensions не обходят границы. |
| P0 | Секреты и refresh ownership | Однозначный owner; утверждённое at-rest решение вместо неявного plaintext DB; исключён dual refresh; helper/env не утечёт в logs/children; rollback не запускает устаревшие token copies. |
| P0 | Источник Windows artifact | Выбран fork/upstream осознанно; binary соответствует SHA; checksum/provenance; startup/native loading/CPU/shell/PTY проверены. |
| P0 | Provider protocol matrix | Для всех 16 profiles точные provider/model/API/baseURL/header mappings; **все 5 `auto` разрешены явно**; synthetic requests проверяют reasoning, tools, stream terminal events и auth header; missing env не превращается в literal bearer. |
| P0 | Ошибки и replay | Mock failures до/после side effect; отсутствие внешнего prompt replay; ограниченные суммарные retries/latency; terminal error, cancel и child-process cleanup различимы в UI. |
| P1 | Session migration | Полный root inventory, custom Codex root, snapshot originals, fresh-ID mapping, dedup и fidelity report; exit 0 без выбора не считается импортом. |
| P1 | Capability migration | Проверенная матрица нужных tools/LSP/MCP/skills/extensions/subagents; не переносить ambient privileges автоматически. |
| P1 | Portal/storage/UI | Parent evidence закрывает NUL corruption, portal/API/runtime status separation и error mapper; balances остаются отдельным backend. |
| Финальный | Полное retirement | OMP — единственный agent executable в launch/resume/task workflows; удалены production-зависимости от Claude/Codex CLI/bridges, нет активного legacy refresh owner; сохранены лишь offline migration archives по согласованной retention policy. |

**Предпочтительная конечная граница:** существующий продукт управляет provider metadata, portal accounts/balances, защищённым secret seam и UI; OMP управляет model requests, agent loop, tools и новыми sessions. Если нужен broker/gateway, он вводится для credential ownership, а не как способ сохранить официальные CLI в runtime. Внешняя isolation boundary обязательна там, где OMP сам не обеспечивает требуемые запреты.

## 12. Что осталось неизвестным

Не установлены: фактическая работоспособность выбранного SHA на целевом Windows; совместимость всех 16 реальных endpoints; доступность/допустимость OAuth подписок; полная fidelity реальных историй; exactly-once внешних tools; stock Node SDK compatibility; отсутствие security bypass при всех сочетаниях extensions/MCP/subagents; соответствие опубликованных чужих binaries fork SHA.

Проведены только read-only source/docs/API checks и проверка Git revision. Не выполнялись установка, сборка, запуск OMP/тестов, auth flows, чтение пользовательских secrets, вызовы моделей, изменения production-кода или commits. Parent отдельно сообщил, что общий `npm test` подхватывает Bun tests из `.scratch/omp`; scoped Vitest verification остаётся частью его плана, checkout здесь не менялся.

## Источники

Все GitHub `blob` ссылки ниже закреплены на исследованном SHA. Live GitHub API и официальные страницы CLI проверены 2026-09-14; они не являются snapshot установленной локальной версии.

[main-api]: https://api.github.com/repos/unsigned-gg/omp/commits/main
[repo-api]: https://api.github.com/repos/unsigned-gg/omp
[releases-api]: https://api.github.com/repos/unsigned-gg/omp/releases
[package]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/package.json#L2-L85
[installer-origin]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/scripts/install.ps1#L1-L23
[approval-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/approval-mode.md#L3-L60
[approval-default]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/settings-schema.ts#L4021-L4056
[approval-source]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/tools/approval.ts#L108-L219
[approval-no-ui]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/extensibility/extensions/wrapper.ts#L294-L321
[subagent-approval]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/task/executor.ts#L891-L908
[acp-gate]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/session-tools.ts#L705-L781
[acp-intent]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/acp-permission-gate.ts#L7-L123
[acp-approval-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/approval-mode.md#L122-L150
[extension-isolation]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/extension-loading.md#L237-L257
[extension-disable]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/extension-loading.md#L99-L116
[task-isolation]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/settings-schema.ts#L4800-L4874
[bash-surfaces]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/bash-tool-runtime.md#L9-L38
[flag-approval]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/cli/flag-tables.ts#L226-L235
[codex-security]: https://learn.chatgpt.com/docs/agent-approvals-security
[claude-sandbox]: https://code.claude.com/docs/en/sandboxing
[claude-permissions]: https://code.claude.com/docs/en/permissions
[cli]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/cli-reference.md#L56-L201
[args]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/cli/args.ts#L23-L99
[flags]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/cli/flag-tables.ts#L113-L249
[rpc-types]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/modes/rpc/rpc-types.ts#L24-L122
[rpc-responses]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/rpc.md#L200-L207
[rpc-framing]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/rpc.md#L3-L91
[rpc-lifecycle]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/rpc.md#L92-L193
[rpc-prompt]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L1015-L1068
[sdk]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/sdk.md#L1-L99
[readme-sdk]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L495-L537
[acp-mode]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/modes/acp/acp-mode.ts#L25-L63
[acp-capabilities]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/modes/acp/acp-agent.ts#L630-L674
[compile]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/scripts/compile-binary.ts#L4-L66
[native-build]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/natives-build-release-debugging.md#L3-L110
[binary-targets]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/scripts/ci-release-build-binaries.ts#L31-L81
[native-loader]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/natives-addon-loader-runtime.md#L13-L125
[installer-shell]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/scripts/install.ps1#L86-L162
[installer-binary]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/scripts/install.ps1#L241-L308
[models-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/models.md#L15-L37
[model-identity]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/models.md#L186-L201
[model-schema]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/models-config-schema-bundle.ts#L88-L264
[secret-resolver]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/model-config-values.ts#L1-L85
[provider-schema]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/models-config-schema-bundle.ts#L266-L324
[model-validator]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/models-config.ts#L36-L132
[models-auth-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/models.md#L100-L116
[models-auth-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/test/config/models-config-validation.test.ts#L7-L35
[provider-registration]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/model-registry.ts#L2271-L2325
[compat-schema]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/models-config-schema-bundle.ts#L24-L86
[fallback-settings]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/settings-schema.ts#L1867-L1895
[anthropic-client]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/providers/anthropic-client.ts#L198-L228
[anthropic-url]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/providers/anthropic.ts#L119-L126
[chat-url]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/providers/openai-completions.ts#L659-L669
[anthropic-options]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/providers/anthropic.ts#L3090-L3116
[endpoint-constraints]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/provider-endpoint-constraints.md#L43-L88
[command-refresh]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/model-registry.ts#L2143-L2182
[credential-json]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L1-L156
[credential-open]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L504-L552
[credential-wal]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L579-L598
[credential-ddl]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L726-L740
[secret-obfuscation]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/secrets.md#L1-L32
[provider-auth]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/providers.md#L9-L72
[refresh-leases]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L403-L488
[refresh-owner]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth-storage.ts#L2438-L2669
[refresh-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/test/auth-storage-oauth-refresh-race.test.ts#L394-L448
[broker-snapshot]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth-storage.ts#L6564-L6589
[broker-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L3-L42
[broker-cache]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L181-L187
[broker-import]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L44-L65
[credential-selection]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth-storage.ts#L1719-L1761
[auth-retry]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth-retry.ts#L8-L194
[stream-replay]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/stream.ts#L1466-L1577
[retry-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/non-compaction-retry-policy.md#L30-L116
[hard-fallback]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/turn-recovery.ts#L1730-L1768
[retry-execution]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/turn-recovery.ts#L1925-L2100
[replay-guard]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/turn-recovery.ts#L1074-L1159
[resolved-turn]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/turn-recovery.ts#L1162-L1253
[retry-preserve]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/turn-recovery.ts#L2150-L2245
[replay-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/test/agent-session-retry-cap.test.ts#L930-L1034
[continuation-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/test/agent-session-retry-cap.test.ts#L1156-L1273
[retry-usage]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/non-compaction-retry-policy.md#L158-L236
[session-layout]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/session-switching-and-recent-listing.md#L21-L49
[dirs]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/utils/src/dirs.ts#L752-L793
[lsp]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/lsp-config.md#L9-L43
[claude-paths]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/config/claude-paths.ts#L4-L18
[claude-store]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/claude-session-store.ts#L101-L143
[claude-constructor]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/claude-session-store.ts#L304-L319
[codex-store]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/codex-session-store.ts#L456-L556
[foreign-import]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/foreign-session-import.ts#L8-L52
[claude-import-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/test/foreign-session-stores.test.ts#L143-L165
[import-flags]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/main.ts#L667-L681
[import-startup]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/main.ts#L1557-L1620
[session-resume]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/session-switching-and-recent-listing.md#L131-L143
[import-test]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/test/foreign-session-stores.test.ts#L337-L361
[codex-conversion]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/session/codex-session-store.ts#L52-L249
[tools]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/tools/index.ts#L426-L465
[readme-counts]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L25-L27
[mcp-source]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/mcp/client.ts#L70-L85
[mcp-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/mcp-protocol-transports.md#L30-L69
[mcp-lifecycle]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/mcp-protocol-transports.md#L262-L275
[mcp-retry-classifier]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/mcp/tool-bridge.ts#L38-L60
[mcp-retry]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/coding-agent/src/mcp/tool-bridge.ts#L535-L585
[task-doc]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/task-agent-discovery.md#L175-L269
[stats]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/stats/README.md#L1-L41
[usage-types]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/usage.ts#L1-L119
[usage-ranking]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/usage.ts#L316-L370
[broker-usage]: https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L161-L179
