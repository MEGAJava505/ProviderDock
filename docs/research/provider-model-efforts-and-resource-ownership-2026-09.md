# ProviderDock: reasoning effort/thinking and resource ownership

**Дата среза:** 11 сентября 2026 года (UTC+5, локальная дата среды).
**Тип:** sidecar research snapshot; разделы «текущее состояние кода» описывают
предварительный снимок до архитектурного фикса, а не текущий production-код.

После исследования реализованы отдельные изменения в capability layer,
approval preferences и Responses resource-scope handling; этот документ сохраняет
исходные наблюдения и доказательства, чтобы не смешивать baseline с результатом
фикса.

## Краткий вывод

1. ProviderDock не имеет закрытого списка моделей: он принимает manual model IDs и модели, обнаруженные через provider `/models`; поэтому «актуальная модель» в проекте — это либо точный ID из runtime/provider catalog, либо модель, совпавшая с эвристикой. Это важно: эвристика не является доказательством официальной поддержки effort.
2. В коде сейчас есть две небезопасные категории догадок: общая эвристика `claude -> low/medium/high/max` и специальная таблица AgentRouter `glm-5.3 -> low/high/max`. Официальные источники подтверждают иные формы/ограничения: Anthropic использует `output_config.effort`, а Z.AI для GLM-5.3 описывает forced thinking, а не effort enum.
3. Runtime-доказательство: nested reasoning item с `encrypted_content` из одной Azure-совместимой цепочки был отправлен в другую и вызвал оба HTTP 400 (`different Azure OpenAI resource` и `encrypted content could not be verified`). Local bridge удаляет только top-level `previous_response_id`/`conversation`, но не моделирует ownership вложенных items.
4. `full-auto` в ProviderDock — флаг конкретного запущенного CLI-процесса. Он не гарантирует отсутствие всех видов prompt: отдельными категориями остаются project trust, MCP elicitation, request-permissions, skills/hooks и login/другие клиентские состояния. Дополнительный сильный кандидат — новый provider-scoped `CODEX_HOME`/profile при каждом запуске.
5. Для Codex picker официальный снимок models.json на 2026-09-11 даёт, например, gpt-6-astra: default low и уровни low/medium/high/xhigh/max/ultra; gpt-5.6-sol: default low и те же шесть уровней. Текущий generated catalog отдаёт этим моделям только low/medium/high.

## 1. Что реально поддерживает текущий проект

### 1.1. Граница применимости

ProviderDock реализует:

- generic OpenAI Responses и Chat Completions adapters;
- generic Anthropic Messages adapter;
- встроенные `agentrouter` и `gorouter` adapters;
- manual/discovered model IDs;
- metadata extraction из `supported_reasoning_levels`, `supported_reasoning_efforts`, `reasoning_efforts`, `reasoning_levels` в raw model object, `metadata` или `capabilities`.

Источники в репозитории: [`src/core/providers/model-catalog.ts`](../../src/core/providers/model-catalog.ts), строки 22–115; [`src/providers/generic-openai/generic-openai-adapter.ts`](../../src/providers/generic-openai/generic-openai-adapter.ts); [`src/providers/generic-anthropic/generic-anthropic-adapter.ts`](../../src/providers/generic-anthropic/generic-anthropic-adapter.ts); [`src/providers/agentrouter/agentrouter-adapter.ts`](../../src/providers/agentrouter/agentrouter-adapter.ts).

Следовательно, точные IDs `gpt-5.6-sol`, `gpt-5.6-luna`, `claude-opus-4.8` и `glm-5.3`, встречающиеся в текущей ветке, имеют разный статус:

- `gpt-5.6-sol`, `gpt-5.6-luna`, `claude-opus-4.8` — рабочие fixture/example IDs в документации, тестах или примерах; они могут быть manual/discovered model IDs, но сами по себе не доказывают, что конкретный ключ провайдера их реально обслуживает.
- `glm-5.3` — единственный exact model ID, для которого production adapter содержит специальную metadata-эвристику AgentRouter.
- Любой другой ID может быть принят generic adapter’ом, если его отдал `/models` или он задан вручную. Для такого ID официальный effort можно назвать только после проверки конкретного upstream API/model catalog.

### 1.2. Модель → официальные значения и ограничения

| ID/семейство, которое покрывает код | Официально допустимые значения на 2026-09-11 | Ограничения и форма запроса | Что делает ProviderDock сейчас | Вердикт |
|---|---|---|---|---|
| `gpt-5.6-sol` и alias `gpt-5.6` | `none`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium` | OpenAI API: `reasoning: { effort: ... }` в Responses; в Chat Completions используется `reasoning_effort`. | Exact ID используется в текущих docs/tests; bridge переносит значение в `reasoning_effort` для Chat route. | **Подтверждено OpenAI.** Учитывать, что OpenAI-модель и конкретный OpenAI-compatible gateway могут поддерживать разные подмножества. |
| `gpt-5.6-terra` | `none`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium` | Те же OpenAI-поля; model availability зависит от upstream deployment. | Не hardcoded, но попадает в generic/manual/discovered route. | **Подтверждено OpenAI; не доказано для каждого gateway.** |
| `gpt-5.6-luna` | `none`, `low`, `medium`, `high`, `xhigh`, `max`; default `medium` | Те же OpenAI-поля. | Exact ID присутствует в текущих docs/examples; generic catalog не валидирует enum по официальной странице модели. | **Подтверждено OpenAI; gateway-specific availability неизвестна.** |
| `gpt-5-pro` | Только `high`; default `high` | Только Responses API; модель не поддерживает code interpreter. | `inferredReasoningLevels()` возвращает `['high']`. | **Подтверждено OpenAI; текущая эвристика совпадает по effort.** |
| `gpt-5.1` | `none` (default), `low`, `medium`, `high` | Не следует добавлять `xhigh` или `max` без отдельной model page/metadata. | Для любого ID, содержащего `gpt-5.1` и не содержащего `codex-max`, код возвращает `none/low/medium/high`. | **Подтверждено для exact `gpt-5.1`; suffix/alias нужно проверять отдельно.** |
| `gpt-5.1-codex-max` и другие IDs, совпадающие с `codex-max` | На официальной странице модели перечисление enum не найдено; подтверждено только, что это Responses-only coding model. | Не считать code-side `low/medium/high/xhigh` официальным контрактом. | Код возвращает `low/medium/high/xhigh`. | **Пробел. Текущая эвристика не доказана первичным источником.** |
| `claude-opus-4.8` | `low`, `medium`, `high`, `xhigh`, `max` | Anthropic effort задаётся как `output_config.effort`; `xhigh` и `max` — разные уровни. | Общая эвристика `claude -> low/medium/high/max` пропускает `max`, но теряет `xhigh`. | **Официально подтверждено Anthropic; current fallback metadata неполна.** |
| `claude-opus-5` | `low`, `medium`, `high`, `xhigh`, `max`; default `high` | На `xhigh`/`max` нельзя одновременно отключить thinking; при высоком effort нужен достаточный `max_tokens`. | Общая эвристика теряет `xhigh`. | **Официально подтверждено Anthropic; адаптер не моделирует Anthropic-native форму.** |
| `claude-sonnet-5` | `low`, `medium`, `high`, `xhigh`, `max`; default `high` | Effort — `output_config.effort`; `max` разрешён, `xhigh` разрешён. | Общая эвристика теряет `xhigh`. | **Официально подтверждено Anthropic.** |
| `claude-sonnet-4.6` | `low`, `medium`, `high`, `max`; `xhigh` не входит в официальную availability table | Не переносить `xhigh` от Sonnet 5/Opus 4.8. | Эвристика совпадает по четырём уровням, но только случайно; exact model не распознаётся отдельно. | **Официально подтверждено Anthropic; нужна model-aware проверка.** |
| `claude-haiku-4-5-20251001` | Effort не поддерживается; модельная страница указывает Extended thinking и `Default effort: Not supported` | Нельзя выдумывать `low/medium/high/max`; thinking/extended-thinking controls зависят от API/model. | `claude -> low/medium/high/max` ошибочно маркирует модель как effort-capable. | **Официально подтверждено Anthropic; текущая эвристика небезопасна.** |
| `glm-5.3` через AgentRouter | Официальный Z.AI API описывает thinking mode: thinking включён по умолчанию, GLM-5.3 использует forced thinking и не может быть disabled. Enum `low/high/max` для `reasoning_effort` не подтверждён. | Z.AI-native пример использует `thinking`; для preserved thinking требуется полный неизменённый `reasoning_content`. ProviderDock AgentRouter — OpenAI-compatible route и не доказывает, что upstream gateway маппит Z.AI semantics. | Специально добавляет `supported_reasoning_levels: ['low','high','max']`, если upstream metadata этого не дала. | **Не считать официальными значениями. Это локальная догадка, требующая проверки у AgentRouter.** |
| `kimi*` / `moonshot*` | В текущем исследованном наборе первичных источников не подтверждён единый effort enum. В code comment указано, что Kimi/Moonshot expose thinking as mode, not effort enum. | Не преобразовывать `reasoning.effort` в произвольный `thinking` без exact provider contract. | `inferredReasoningLevels()` возвращает пустой список. | **Консервативно и безопаснее, но полная model-specific матрица не установлена.** |
| любой прочий discovered/manual ID | Только значения, которые отдал сам provider в проверенной metadata/API schema или которые указаны официальной документацией владельца модели. | Generic OpenAI/Anthropic compatibility ≠ официальная поддержка конкретного enum. | Для отсутствующей metadata код по умолчанию выдаёт `low/medium/high`; для prompt profile принимает любую непустую строку до 64 символов. | **Нельзя считать официально поддержанным.** |

### 1.2.1. Codex CLI model catalog snapshot (2026-09-11)

ProviderDock генерирует `model-catalog.json`, который потребляет именно Codex CLI. Поэтому для Codex UI direct source — официальный `codex-rs/models-manager/models.json`, а не только OpenAI API model pages. Снимок ниже зафиксирован по commit `eb7bd64ef935cedb6a2c90c77c78d6677f1efb45` (2026-09-09, “Remove retired model entries…”).

| Codex model | Default | Supported reasoning levels |
|---|---|---|
| `gpt-6-astra` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-sol` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-terra` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.6-luna` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |
| `gpt-daybreak-blue-latest` | `low` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-daybreak-red-latest` | `medium` | `low`, `medium`, `high`, `xhigh`, `max`, `ultra` |
| `gpt-5.5` | `medium` | `low`, `medium`, `high`, `xhigh` |
| `gpt-5.4` | `medium` | `low`, `medium`, `high`, `xhigh` |
| `codex-auto-review` | `medium` | `low`, `medium`, `high`, `xhigh`, `max` |

Это не противоречит API-таблице выше: OpenAI API model pages и Codex CLI catalog описывают разные consumer-слои. Для ProviderDock первичным для Codex picker должен быть Codex catalog, а для прямых API-запросов — API/model-owner contract.

Фактический сгенерированный каталог текущей AgentRouter-2 сессии содержит только:

- `gpt-6-astra`: `low`, `medium`, `high` — отсутствуют `xhigh`, `max`, `ultra`;
- `gpt-5.6-sol`: `low`, `medium`, `high` — отсутствуют `xhigh`, `max`, `ultra`;
- `glm-5.3`: `low`, `high`, `max` — это локальная AgentRouter-эвристика, не официальная Z.AI semantics;
- `claude-opus-5`: `low`, `medium`, `high`, `max` — отсутствует `xhigh`;
- `deepseek-v4-flash`: `low`, `medium`, `high` — происхождение значений не задокументировано провайдером.
### 1.3. Важное различие между effort и thinking

- OpenAI: effort — параметр `reasoning.effort` (Responses) или `reasoning_effort` (Chat Completions); допустимый набор model-dependent.
- Anthropic: effort — `output_config.effort`; thinking — отдельная capability/configuration. На текущей Anthropic platform effort работает как steering signal и не является строгим token budget.
- Z.AI GLM: документация описывает `thinking`/`clear_thinking`, preserved thinking и turn-level enable/disable; это не доказательство OpenAI-style effort enum.
- ProviderDock canonical representation сейчас имеет одно строковое поле `reasoningEffort`; это удобное transport поле, но семантически недостаточно для различения OpenAI effort, Anthropic effort и Z.AI thinking mode.

Источники: [`src/protocols/canonical/canonical-protocol.ts`](../../src/protocols/canonical/canonical-protocol.ts), [`src/protocols/openai-chat/responses-to-chat-request.ts`](../../src/protocols/openai-chat/responses-to-chat-request.ts), строки 315–363; [`src/protocols/anthropic-messages/anthropic-to-chat-request.ts`](../../src/protocols/anthropic-messages/anthropic-to-chat-request.ts), строки 70–90 и 190–210.

## 2. Что безопасно нормализовать в UI/конфиге

### Можно безопасно

1. Хранить **opaque provider value** как строку без попытки доказать его смысл.
2. Разделять capability fields:
   - `effort`: `unknown | supported(values) | unsupported`;
   - `thinking`: `unknown | enabled | disabled | adaptive | forced | turn-level`;
   - `source`: `official-model-doc | provider-metadata | successful-probe | local-heuristic`.
3. Показывать общий UI-предикат `low / medium / high / max` только как **набор, объявленный конкретным provider/model**, с явным `unknown`, а не как глобальный enum.
4. Для OpenAI exact models нормализовать `reasoning.effort` ↔ `reasoning_effort` только на маршруте, где upstream действительно OpenAI-compatible и model metadata/официальная документация разрешает значение.
5. Для Anthropic передавать `output_config.effort` только на native Messages route и сохранять distinction `xhigh`/`max`.
6. Для GLM сохранять native extension (`thinking`, `clear_thinking`, preserved reasoning) отдельно от canonical `reasoningEffort`; при отсутствии доказанного mapping — не отправлять effort.
7. Показывать пользователю provenance и дату проверки: model page, `/models` metadata, probe result или heuristic.
8. Нормализовать `high` как «default/normal» только в presentation copy, не подменяя им отсутствующее поле. Anthropic прямо описывает high как equivalent to omitting effort, но это не переносится автоматически на OpenAI или gateway.

### Нельзя выдумывать

- Нельзя считать `low/medium/high` универсальным контрактом для любого OpenAI-compatible provider.
- Нельзя добавлять `xhigh` или `max` по имени модели, suffix или бренду без exact official/provider evidence.
- Нельзя преобразовывать Anthropic `output_config.effort` в GLM `thinking` или наоборот без adapter-specific contract.
- Нельзя считать AgentRouter metadata `low/high/max` официальной спецификацией GLM-5.3: это hardcoded local fallback в [`src/providers/agentrouter/agentrouter-adapter.ts`](../../src/providers/agentrouter/agentrouter-adapter.ts), строки 12–15 и 52–62.
- Нельзя сохранять effort value как доказательство того, что запрос был принят upstream: metadata catalog — advertisement, не inference proof.
- Нельзя считать строку из prompt profile валидированной: [`src/core/profiles/prompt-profile.ts`](../../src/core/profiles/prompt-profile.ts), строка 36, проверяет только непустую строку длиной до 64 символов.

## 3. Ошибка `Use the same resource that created the item to access it`

### Наиболее вероятная причина

Это выглядит как попытка dereference stateful Responses resource/item ID через другой upstream resource. Типичный сценарий:

1. Responses API создаёт `response_id`/item на resource A.
2. Следующий запрос или GET идёт на resource B, другой Azure OpenAI resource, другой base URL, другой deployment gateway или другой credential scope.
3. B видит ID, но не имеет ownership/access path к объекту, поэтому возвращает ownership error.

Официальная Microsoft Azure Responses documentation строит и create, и follow-up с `previous_response_id` через один и тот же `https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/` client/base URL; retrieve также выполняется на том же resource URL. Для stateless `store=false` документация вместо `previous_response_id` требует переносить output/encrypted reasoning items в input. OpenAI Responses reference описывает `previous_response_id` как ID предыдущего response и не разрешает одновременно использовать `conversation`.

### Фактическая корреляция из активной сессии

Structured parsing of the active Codex JSONL (без чтения prompt/tool content) даёт прямую цепочку:

1. `2026-09-11T08:05:22.482Z` — создан reasoning item `rs_0987608726fe1c61006aa3b640057481938292f3b10181edfd` с `encrypted_content`.
2. `2026-09-11T08:07:39.168Z` — upstream вернул HTTP 400: “The requested item was created under a different Azure OpenAI resource. Use the same resource that created the item to access it.”
3. `2026-09-11T08:35:27.599Z` — тот же item снова участвует в истории и upstream вернул HTTP 400: “The encrypted content for item `rs_0987608726fe1c61006aa3b640057481938292f3b10181edfd` could not be verified.”

Local bridge при этом удаляет только top-level `previous_response_id` и `conversation`. Nested `input` по-прежнему содержит provider-owned reasoning item и его `encrypted_content`. Ошибка подтверждает, что AgentRouter/upstream обслужил последовательные запросы разными Azure OpenAI resources или scopes, а локальная граница не моделирует ownership этого nested state.

Следовательно, локальная root cause — отсутствие resource-scope для nested provider-owned items/encrypted reasoning при stateless continuation. Внешний триггер — смена upstream resource/scope внутри AgentRouter. Идентификатор конкретного Azure resource ProviderDock сейчас не получает и не логирует.
### Что уже правильно сделано в текущем коде

- [`src/bridge/responses/responses-bridge-server.ts`](../../src/bridge/responses/responses-bridge-server.ts), строки 855–863: bridge прямо называет себя stateless, удаляет `previous_response_id` и `conversation`, не пересылая чужие state handles upstream.
- [`src/protocols/openai-chat/responses-to-chat-request.ts`](../../src/protocols/openai-chat/responses-to-chat-request.ts), строки 592–606: Chat adapter отвергает `previous_response_id`, `conversation` и background mode как unsupported без stateful store.
- [`docs/chat-compatibility.md`](../chat-compatibility.md), строки 36–39 и 81–84: stateful references не переводятся blindly; stateful `previous_response_id` storage оставлен отдельным persistence block.
- [`src/bridge/responses/responses-bridge-server.ts`](../../src/bridge/responses/responses-bridge-server.ts), строки 862–864: при fallback bridge может заменить `model`, но сохраняет stateless full input.

### Проверяемые признаки в текущем коде/логах

1. Ошибка приходит от direct Responses provider, а не от local bridge; в body/status нужно сохранить sanitized upstream detail и route/provider ID.
2. В момент ошибки меняются `profile.baseUrl`, host, Azure resource name, deployment, provider route или credential reference.
3. Ошибка появляется после fallback: первый response был создан на provider A, следующий turn ушёл на provider B, но клиент прислал исходный `previous_response_id`.
4. Ошибка исчезает, если отправить полный input history без `previous_response_id`/`conversation` и, для reasoning models, сохранить требуемые encrypted reasoning items.
5. Сравнение request trace должно показать, был ли ID удалён local bridge перед outbound request. Если да, ownership error пришёл из другого слоя (например, прямой/external bridge или upstream client), а не из этого stateless bridge.
6. Сравнить `base_url` в generated Codex TOML, `CODEX_HOME`, provider ID, route kind (`direct`/`managed`/`external`) и фактический outbound URL. ProviderDock intentionally uses per-provider/per-session routing, so a stale client-side response ID is especially suspicious.

### Безопасное правило API

- Stateful ID (response, conversation, item, file/vector-store reference where provider imposes ownership) должен использоваться через тот же owning resource/project/tenant и совместимый credential scope, который его создал.
- При смене provider, resource, base URL или fallback route не переносить stateful IDs; либо продолжать на owning resource, либо материализовать полноценный stateless input согласно конкретному API.
- Для этого проекта сохранение `previous_response_id` в новом state store нельзя включать без route/resource key. Минимальный ключ должен отличать как минимум provider ID + normalized base URL/origin + account/project/resource scope + protocol.

## 4. Почему prompts могут повторяться после `full access`

### Доказанные факты в ProviderDock

- [`src/clients/agent-approval.ts`](../../src/clients/agent-approval.ts), строки 24–35: Codex `full-auto` маппится на `--dangerously-bypass-approvals-and-sandbox`; default — `ask`.
- [`src/clients/codex/codex-launcher.ts`](../../src/clients/codex/codex-launcher.ts), строки 124–141: флаг передаётся только при конкретном запуске child process; `CODEX_HOME` подменяется runtime-specific directory.
- [`src/ui/provider-dashboard-server.ts`](../../src/ui/provider-dashboard-server.ts), строки 138–139: HTTP launch request default’ит `approvalLevel` обратно в default (`ask`), если UI/client не прислал `full-auto`.
- [`src/application/create-default-application.ts`](../../src/application/create-default-application.ts), строки 79–106: default Codex home — `~/.provider-switcher/runtime/codex-home`; explicit `CODEX_HOME` может быть переопределён.
- [`src/clients/codex/codex-runtime-config.ts`](../../src/clients/codex/codex-runtime-config.ts), строки 123–154: ProviderDock создаёт новый provider/session profile, записывает generated config и `[projects.<directory>] trust_level = "trusted"`.
- [`docs/codex-runtime.md`](../codex-runtime.md), строки 221–249: Codex получает provider-specific `CODEX_HOME`; shared history не смешивается, а trust записывается в isolated profile.

### Фактическое runtime-подтверждение по approval

В активной Codex-сессии каждый `turn_context` с `2026-09-11T08:02:56Z` по `08:50:43Z` показывает:

- `approval_policy: on-request`;
- `sandbox_policy: read-only`;
- managed permission profile с read-only filesystem и restricted network.

Это прямое доказательство, что `full-auto` не попал в фактический child process этих turns. При этом generated TOML был изменён Codex на `model = "glm-5.3"` и `model_reasoning_effort = "max"`, хотя runtime manifest остался привязан к `gpt-6-astra`. Значит, пользовательские настройки внутри Codex сохраняются в disposable profile, но launch approval preference в ProviderDock не персистится и не попадает в последующие запуски.
### Проверяемые объяснения

1. **`full-auto` не был передан в фактический запуск.** UI может быть перезагружен, resume может идти из другого пути, внешний caller может отправить request без `approvalLevel`, либо фактический запуск — не тот launch record. Проверить argv child process и POST body.
2. **Prompt не относится к approval/sandbox.** Official Codex config reference разделяет `approval_policy` и `sandbox_mode`, а также отдельно описывает granular prompts для `mcp_elicitations`, `request_permissions` и `skill_approval`. Полный bypass command не следует трактовать как отключение любой client UX-проверки.
3. **Project trust mismatch.** Generated TOML доверяет конкретному path, но Codex может видеть другой spelling/case, symlink/junction, UNC path, nested workspace или другой cwd. На Windows особенно сравнить normalized path, actual process cwd и path в `[projects...]`.
4. **Новый `CODEX_HOME`/provider profile.** ProviderDock намеренно изолирует Codex state по provider/session. Если пользователь доверил каталог в обычном `~/.codex`, это не означает, что новый isolated home знает тот же trust state.
5. **CLI/config precedence.** `--strict-config --profile` и generated profile могут скрывать изменения, внесённые в обычный user config; project-local `.codex/config.toml` не должен рассматриваться как источник provider keys, а для permissions нужно проверить, какой config layer реально прочитан.
6. **Другой процесс/клиент.** Auto launch может выбрать Codex или Claude Code; `full-auto` имеет разные native flags. Проверить resolved client и argv, а не только UI selection.
7. **Hook/skill/MCP/login prompt.** Проверить stderr/JSON event category и exact prompt text; не классифицировать всякий prompt как shell approval.
8. **Nested/sub-agent path.** Если prompt появляется у дочернего agent process, он может иметь иной runtime/config/environment, даже если parent был запущен с full-auto.

## 5. Пробелы и неопределённость

- ProviderDock не хранит официальную versioned model-capability registry; discovered raw metadata может быть неполной, ложной или gateway-specific.
- Текущий `inferredReasoningLevels()` не умеет различать точные Claude IDs (например, Haiku vs Opus/Sonnet) и не отражает Anthropic `xhigh` availability.
- Для `gpt-5.1-codex-max` официальная model page, исследованная на дату среза, подтверждает Responses-only coding use case, но не даёт в доступном model summary полного enum effort; нужен exact API probe или более подробная model guidance.
- `glm-5.3` в AgentRouter — не то же самое, что direct Z.AI endpoint. Нужна документация/fixture именно AgentRouter о mapping `reasoning_effort` → upstream `thinking`, а не только Z.AI docs.
- Для Kimi/Moonshot не установлена полная актуальная таблица по всем IDs, которые может вернуть gateway; текущая пустая эвристика — safety default, не полная поддержка.
- Ownership-ошибка локализована до вложенного provider-owned reasoning item/encrypted content, пересекающего смену upstream Azure resource/scope. Конкретный внешний resource identifier всё ещё неизвестен, потому что AgentRouter не отдаёт его в нормализованном response metadata.
- Official docs pages являются изменяемыми; этот документ фиксирует дату среза и должен обновляться при смене model catalog/API contract.

## Источники (только первичные)

### Provider/API documentation

1. OpenAI — Reasoning models guide: <https://developers.openai.com/api/docs/guides/reasoning>
   Ключевой факт: effort values model-dependent; guide перечисляет `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` и отдельно предупреждает проверять страницу конкретной модели.
2. OpenAI — Models catalog: <https://developers.openai.com/api/docs/models>
3. OpenAI — GPT-5 Pro model page: <https://developers.openai.com/api/docs/models/gpt-5-pro>
   Ключевой факт: Responses-only; supports only `reasoning.effort: high`.
4. OpenAI — GPT-5.1 model page: <https://developers.openai.com/api/docs/models/gpt-5.1>
   Ключевой факт: `none` (default), `low`, `medium`, `high`.
5. OpenAI — GPT-5.1-Codex-Max model page: <https://developers.openai.com/api/docs/models/gpt-5.1-codex-max>
6. OpenAI — GPT-5.6 Sol: <https://developers.openai.com/api/docs/models/gpt-5.6-sol>
7. OpenAI — GPT-5.6 Terra: <https://developers.openai.com/api/docs/models/gpt-5.6-terra>
8. OpenAI — GPT-5.6 Luna: <https://developers.openai.com/api/docs/models/gpt-5.6-luna>
9. OpenAI — Responses create reference: <https://developers.openai.com/api/reference/resources/responses/methods/create>
   Ключевой факт: `previous_response_id` — ID предыдущего response; нельзя использовать вместе с `conversation`.
10. Microsoft — Use the Azure OpenAI Responses API: <https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/responses>
    Ключевые факты: create/follow-up/retrieve examples use the same `YOUR-RESOURCE-NAME.openai.azure.com/openai/v1/`; stateless `store=false` carries output/encrypted reasoning items instead of using `PreviousResponseId`.
11. Anthropic — Adaptive thinking: <https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking>
    Ключевые факты: `output_config.effort`; levels are model-dependent; effort is a steering signal.
12. Anthropic — Effort and model availability: <https://platform.claude.com/docs/en/build-with-claude/effort>
    Ключевые факты: availability table for `low`, `medium`, `high`, `xhigh`, `max`; exact per-model recommendations and restrictions.
13. Anthropic — Models overview: <https://platform.claude.com/docs/en/about-claude/models>
    Ключевые факты: model IDs, thinking capability and default effort for current Claude models.
14. Z.AI — Thinking Mode: <https://docs.z.ai/guides/capabilities/thinking-mode>
    Ключевые факты: GLM-5.3 forced thinking cannot be disabled; preserved thinking requires unmodified reasoning content; native controls are `thinking`/`clear_thinking`, not a documented effort enum.
15. OpenAI/Codex — Configuration reference: <https://learn.chatgpt.com/docs/config-file/config-reference>
    Ключевые факты: profiles under `$CODEX_HOME`, `approval_policy` and `sandbox_mode` are separate configuration concepts; granular prompt categories include MCP/request-permissions/skills.

16. OpenAI/Codex — `codex-rs/models-manager/models.json`: <https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json>
    Ключевые факты: точный снимок Codex CLI model catalog; `default_reasoning_level` и `supported_reasoning_levels` для всех текущих моделей; commit `eb7bd64ef935cedb6a2c90c77c78d6677f1efb45`.
17. OpenAI/Codex — `codex-rs/protocol/src/openai_models.rs`: <https://github.com/openai/codex/blob/main/codex-rs/protocol/src/openai_models.rs>
    Ключевые факты: `ReasoningEffort` допускает `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `ultra`, `persistent` и `Custom`; `supported_reasoning_levels` — вектор preset’ов; `default_reasoning_level` опционален.
18. OpenAI/Codex — `codex-rs/tui/src/chatwidget/reasoning_shortcuts.rs`: <https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/reasoning_shortcuts.rs>
    Ключевые факты: UI ходит только по advertised efforts; если список пуст, fallback — default effort, а не выдуманные `low/medium/high`.
### Исходный код ProviderDock

- [`src/bridge/responses/codex-model-catalog.ts`](../../src/bridge/responses/codex-model-catalog.ts), строки 1–118 — catalog schema, local reasoning descriptions and fallback heuristics.
- [`src/providers/agentrouter/agentrouter-adapter.ts`](../../src/providers/agentrouter/agentrouter-adapter.ts), строки 12–62 — hardcoded `glm-5.3` metadata.
- [`src/core/providers/model-catalog.ts`](../../src/core/providers/model-catalog.ts), строки 22–115 — discovered/manual model merge and metadata aliases.
- [`src/bridge/responses/responses-bridge-server.ts`](../../src/bridge/responses/responses-bridge-server.ts), строки 855–864 — stateless stripping of foreign state handles.
- [`src/protocols/openai-chat/responses-to-chat-request.ts`](../../src/protocols/openai-chat/responses-to-chat-request.ts), строки 592–606 — rejection of stateful references in Chat translation.
- [`src/clients/agent-approval.ts`](../../src/clients/agent-approval.ts), строки 1–49 — approval-level mapping.
- [`src/clients/codex/codex-launcher.ts`](../../src/clients/codex/codex-launcher.ts), строки 124–141 — actual child argv/environment.
- [`src/clients/codex/codex-runtime-config.ts`](../../src/clients/codex/codex-runtime-config.ts), строки 123–154 — generated profile and project trust.
- [`src/application/create-default-application.ts`](../../src/application/create-default-application.ts), строки 79–106 — default/overridden homes.
- [`src/ui/provider-dashboard-server.ts`](../../src/ui/provider-dashboard-server.ts), строки 130–140 и 878–896 — launch request default and forwarding.

## Рекомендованный следующий технический шаг (не выполнен в рамках research)

Ввести provider/model capability record с обязательным provenance и запретом на heuristic values в `supportedReasoningLevels` по умолчанию. Для каждой модели хранить отдельно `effortValues`, `thinkingMode`, `requestField`, `stateScopeKey` и `evidence`. До этого UI должен показывать `unknown` вместо синтетического универсального списка, а bridge должен отправлять только явно разрешённое adapter’ом значение.
