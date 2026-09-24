# Оценка OMP как замены ProviderDock

Дата проверки: **14 сентября 2026 года**. Upstream `unsigned-gg/omp`, ветка
`main`, commit `0c6c981ee5838d97700180383077eb0a3790637c`. Ниже использованы
README, package manifest, документация и исходники самого репозитория.

## 1. Исчезнувшие токены и сессии

Проверка была только на чтение. ProviderDock по умолчанию использует
`%USERPROFILE%\.provider-switcher`; `PROVIDER_DOCK_HOME`, `CODEX_HOME` и
`CLAUDE_CONFIG_DIR` могут изменить корни. Файл профилей находится в
`providers/providers.json`, секреты в `secrets`, а изолированные дома клиентов
в `runtime/codex-home` и `runtime/claude-home` ([create-default-application.ts, строки 75–109](../src/application/create-default-application.ts#L75-L109)).

Фактическое состояние:

- переменные `PROVIDER_DOCK_HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR` не заданы;
- `providers.json` существует, имеет размер 10 721 байт и является валидным
  JSON с 16 включенными профилями и 16 уникальными ссылками на секреты;
- все 34 файла в `secrets` валидны, соответствуют схеме и именованию SHA-256;
  все 34 расшифровываются Windows DPAPI текущего пользователя;
- `~/.codex/auth.json`, `~/.codex/config.toml` и `~/.claude/.credentials.json`
  существуют и структурно читаются; значения токенов не выводились;
- ProviderDock ищет сессии в provider-scoped домах, а также в legacy Codex
  `sessions` ([agent-session-history.ts, строки 96–127](../src/clients/agent-session-history.ts#L96-L127)).

**Вывод:** повреждения или удаления хранилища не обнаружено. Наиболее вероятна
путаница между native-домами (`~/.codex`, `~/.claude`) и изолированными домами
ProviderDock либо запуск с другим набором переменных окружения/корнем. Это
объясняет видимость «пропавших» данных без восстановления или конвертации файлов.

## 2. Архитектура OMP

OMP не является небольшим provider switcher. Это самостоятельный coding agent:
README заявляет 60+ провайдеров, 31 встроенный инструмент и Rust core
([README.md, строки 25–27](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L25-L27)). Репозиторий представляет собой приватный Bun-monorepo с workspace-пакетами и нативной сборкой ([package.json, строки 1–17](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/package.json#L1-L17), [строки 83–103](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/package.json#L83-L103)).

Основные слои: `pi-ai` (провайдеры/стриминг), catalog, agent core, coding-agent,
TUI, native bindings, stats, memory и RPC wire ([README.md, строки 635–652](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L635-L652)). Один движок доступен через интерактивный TUI, print/headless mode, Node/TypeScript SDK, NDJSON RPC и ACP ([README.md, строки 495–551](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L495-L551)).

## 3. Провайдеры, auth и secrets

Поддерживаются прямые API и gateways Anthropic, OpenAI, OpenAI Codex OAuth,
Google/Gemini/Vertex, xAI, DeepSeek, Mistral, Groq, OpenRouter, Bedrock, Azure,
Cloudflare/Vercel gateways, coding plans, Cursor/Copilot и локальные Ollama,
LM Studio, llama.cpp, vLLM и LiteLLM ([README.md, строки 331–354](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L331-L354)). Свои OpenAI-compatible провайдеры задаются в `~/.omp/agent/models.yml`; доступны также fallback chains и path-scoped routing ([README.md, строки 355–385](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L355-L385)).

Доступность модели определяется каталогом, `models.yml`, discovery и extensions;
`disabledProviders` проверяется до credential resolution. Приоритет credentials:
runtime override, `models.yml` key, stored OAuth, login API key, env/.env, прочие
stored API keys и fallback resolver ([docs/providers.md, строки 9–50](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/providers.md#L9-L50)).

Локальное auth-хранилище OMP: `~/.omp/agent/agent.db`, SQLite; `PI_CODING_AGENT_DIR`
переносит весь этот каталог. Исходники создают каталог с restrictive permissions,
используют WAL, schema migrations, таблицы `auth_credentials` и блокировок, а также
отслеживание изменений из других процессов ([dirs.ts, строки 756–793](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/utils/src/dirs.ts#L756-L793), [sqlite-credential-store.ts, строки 504–552](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L504-L552), [строки 648–759](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/auth/sqlite-credential-store.ts#L648-L759)). Это другой формат и другой security boundary, не совместимый напрямую с ProviderDock JSON + Windows DPAPI vault.

Для Anthropic есть собственный OAuth flow Claude Pro/Max ([anthropic.ts, строки 1–25](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/registry/oauth/anthropic.ts#L1-L25)). Для Codex есть ChatGPT OAuth с browser callback на фиксированном `localhost:1455` и headless/device flow ([openai-codex.ts, строки 1–29](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/registry/oauth/openai-codex.ts#L1-L29), [строки 137–220](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/registry/oauth/openai-codex.ts#L137-L220), [openai-codex-device.ts, строки 4–18](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/ai/src/registry/openai-codex-device.ts#L4-L18)).

Есть auth-broker/gateway: broker держит canonical SQLite vault и единственный
обновляет OAuth refresh tokens; клиенты получают redacted snapshot, gateway
проксирует OpenAI/Anthropic-подобные API ([auth-broker-gateway.md, строки 1–10](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L1-L10), [строки 42–59](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L42-L59)). TLS, network boundary и bearer-token security оставлены оператору ([auth-broker-gateway.md, строки 127–187](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/auth-broker-gateway.md#L127-L187)).

## 4. CLI, API и сессии

CLI поддерживает интерактивный запуск, `-p`/headless, `--model`, `--provider`,
profiles, `--session-dir`, resume/fork/import/export и `--no-session`; режимы
включают `text`, `json`, `rpc`, `rpc-ui` и `acp` ([cli-reference.md, строки 3–22](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/cli-reference.md#L3-L22), [строки 56–96](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/cli-reference.md#L56-L96), [строки 163–201](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/cli-reference.md#L163-L201)). Есть отдельные команды `auth-broker`, `auth-gateway`, `models`, `usage`, `token`, `stats` и другие ([cli-reference.md, строки 203–245](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/cli-reference.md#L203-L245)).

Сессии OMP хранятся в `~/.omp/agent/sessions/<encoded-cwd>/*.jsonl`, а история
поиска/подсказок в `history.db` ([session-switching-and-recent-listing.md, строки 21–49](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/session-switching-and-recent-listing.md#L21-L49), [dirs.ts, строки 766–788](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/packages/utils/src/dirs.ts#L766-L788)). Документированы resume, picker, rollback состояния и `/resume @claude` / `/resume @codex` как импорт foreign transcript ([session-switching-and-recent-listing.md, строки 83–143](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/session-switching-and-recent-listing.md#L83-L143)). Импорт сохраняет transcript уже как OMP session: это не native bidirectional resume Claude Code/Codex. При отсутствии или повреждении target-файла OMP может инициализировать новую сессию, что важно для миграционной диагностики ([session-switching-and-recent-listing.md, строки 219–249](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/docs/session-switching-and-recent-listing.md#L219-L249)).

## 5. Совместимость и риски миграции

| Область | Оценка |
| --- | --- |
| Ширина каталога и fallback routing | Высокая |
| Anthropic/Codex auth внутри OMP | Высокая, через собственные flows |
| Прямое чтение ProviderDock `providers.json`/DPAPI | Нет |
| Нативные сессии Claude Code/Codex | Нет; есть импорт transcript |
| SDK/RPC/ACP для интеграции | Есть, но интеграция существенная |
| Операционная простота | Ниже ProviderDock: Bun, Rust/N-API, monorepo |

Текущая граница ProviderDock — управление профилями, secret vault, протокольными
bridge и запуском официальных клиентов; это прямо сформулировано в локальном
[README.md, строки 5 и 166–184](../README.md#L5), а не как реализация собственного
coding agent.
OMP, напротив, сам является coding agent. Поэтому:

1. **Как основной пользовательский coding agent** OMP технически подходит: у него
   есть провайдеры, OAuth, модели, fallback, инструменты, SDK/RPC/ACP.
2. **Как прозрачная замена provider switcher для официальных Claude Code и Codex
   CLI** он не подходит без адаптера: OMP использует свои auth/session/config
   форматы и документирует импорт, а не управление native CLI.
3. Перенос токенов потребует повторного `omp login`, контролируемого импорта API
   keys или интеграции с auth-broker. Автоматически конвертировать DPAPI vault в
   `agent.db` без отдельного importer нельзя.

Основные риски: большой runtime/build footprint; миграция refresh tokens и
аккаунтов; изменение provider/model/fallback semantics; OAuth и gateways с
отдельными условиями, лимитами и риском блокировки; auth-broker требует отдельно
защитить сеть и bearer tokens; remote install scripts лучше не запускать без
проверки и фиксации версии ([README.md, строки 35–41](https://github.com/unsigned-gg/omp/blob/0c6c981ee5838d97700180383077eb0a3790637c/README.md#L35-L41)).

## 6. Рекомендация

Не переключать весь рабочий контур одним шагом. Безопасная последовательность:

1. Сохранить ProviderDock как rollback/credential backup и запустить OMP с
   отдельным `PI_CODING_AGENT_DIR`.
2. На тестовых аккаунтах проверить Anthropic OAuth, Codex browser/device auth,
   API keys, fallback, tool approvals и поведение после перезапуска.
3. Импортировать несколько Claude/Codex transcripts и проверить, что ожидаемые
   контекст, проекты и разрешения действительно восстановимы.
4. После пилота выбрать границу: OMP как основной agent, ProviderDock как
   совместимый launcher/credential adapter или OMP auth-broker как общий backend.

**Итог:** OMP — сильный кандидат на замену agent/orchestration слоя, но не
готовая замена текущих ProviderDock профилей и официальных Claude Code/Codex CLI.
Локальная проблема сейчас выглядит как mismatch путей/областей хранения, а не
повреждение токенов или сессий.
