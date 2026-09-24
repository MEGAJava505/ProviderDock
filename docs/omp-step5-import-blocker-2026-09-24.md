# Stage 5 · Подэтап 3 — закреплённый OMP importer на фиктивных данных: проверяемый блокер

Дата: 2026-09-24. Текущая следующая граница: [глава 3 единого плана](omp-migration/REMAINING_PLAN.md).
Область: только чтение закреплённого checkout `.scratch/omp` (HEAD = `0c6c981ee5838d97700180383077eb0a3790637c`, совпадает с provenance). **Ни один реальный home не читался, OMP не запускался и не собирался, сети не было, OMP SQLite/JSONL вручную не писался.**

## Вывод

Fixture-only **автоматический** «native» импорт (`--from-codex`/`--from-claude`) из нашего Node/vitest-харнесса **не поддерживается** закреплённой версией одновременно с требованиями задания (explicit synthetic source root + изолированный target + гарантированное отсутствие сети/inference, без подмены глобального `HOME`). Это честный, воспроизводимый блокер — не ложное завершение Stage 5. Этапы 1–2 (инвентарь + план/manifest) остаются готовыми и зелёными.

Вердикт закодирован типами в `src/migration/omp-import-capability.ts` (`OMP_IMPORT_CAPABILITY.route = "unsupported-automated-native-import"`) и перепроверяется статически скриптом `scripts/omp-import-probe.mjs` (drift=0, exit 0).

## Проверенные факты (file:line в закреплённом checkout)

| # | Вопрос | Факт | Источник |
|---|--------|------|----------|
| 1 | Команда импорта | `--from-claude` / `--from-codex` — взаимоисключающие, несовместимы с `--no-session`/`--continue`/`--resume`/`--fork`; открывают интерактивный picker. Пустой список/отмена → exit 0 (**не** доказательство импорта). | `packages/coding-agent/src/main.ts:667-685` (`resolveForeignSessionSource`) |
| 2 | Explicit source root | Классы **принимают** явный root: `CodexSessionStore` — `constructor(rootDirectory = path.join(os.homedir(), ".codex"))`; `ClaudeSessionStore` — `constructor(root = resolveClaudePaths().configDir)`. **Но** Node-достижимая CLI-фабрика строит их **без** аргумента. | `codex-session-store.ts:462-464`, `claude-session-store.ts:310`, `foreign-session-import.ts:9-10` (`return source === "claude" ? new ClaudeSessionStore() : new CodexSessionStore();`) |
| 3 | Изолированный target | **Поддержан** на уровне библиотеки: функция импорта принимает `options?: { fallbackCwd?; sessionDir?; suppressBreadcrumb? }`; `persistCopy(options)` пишет новую копию. | `foreign-session-import.ts:39,51`, `session-manager.ts:1610` |
| 4 | Сеть / inference при импорте | Не найдено `fetch`/`http`/`apiKey`/`Authorization` в цепочке импорта — это локальная трансформация transcript → in-memory `SessionManager` → `persistCopy` с provenance (`source/sourceId/sourcePath/sourceCwd`). | `foreign-session-store.ts` (нет сетевых вызовов), `foreign-session-import.ts:43-51` |
| 5 | Runtime | `codex-session-store` жёстко `import { Database } from "bun:sqlite"` и читает newest `state_N.sqlite` readonly. Пакет — **Bun-only**; как библиотека из Node/vitest не исполняется. | `codex-session-store.ts:1,469-472` |

## Почему это блокер именно для нашего харнесса

Чтобы задать **явный синтетический source root** для Codex, нужно обойти CLI-фабрику (она хардкодит home) и вызвать `new CodexSessionStore(root)` напрямую — но этот модуль требует **Bun-рантайма** (`bun:sqlite`), которого в Node/vitest нет. Единственный Node-достижимый вход — CLI-picker, который (а) читает `~/.codex`/`~/.claude` (переключить без подмены глобального `HOME` нельзя — запрещено) и (б) интерактивен. Поднять Bun и исполнить upstream-код ради обхода — это уже не «закреплённый интерфейс» и не безопасный fixture-only путь; требует отдельного явного решения пользователя.

Поэтому, по инструкции §3, **OMP SQLite/JSONL вручную не пишется**; вместо этого — `unsupported` с точной причиной и предложение адаптера ниже.

## Предложение безопасного адаптера (для отдельного решения пользователя, НЕ выполнено здесь)

Импорт — односторонний перенос контекста в **новую** OMP-identity (не native resume, не перенос approval/hooks/sandbox/auth). Безопасный будущий путь:

1. **Bun-hosted, network-disabled probe-харнесс** (отдельный opt-in, вне Node-тестов): конструирует `new CodexSessionStore(syntheticRoot)` / `new ClaudeSessionStore(syntheticRoot)` с явным синтетическим root, импортирует в изолированный `sessionDir`, проверяет новую session identity, count/порядок сообщений, tool-call/result linkage, cwd, model metadata, provenance, идемпотентность повторного запуска. Сеть выключена на уровне ОС/контейнера; реальный provider key ребёнку не передаётся.
2. **Либо** собственный context-transfer адаптер, читающий transcript через уже готовый Stage-1 инвентарь и Stage-2 план и формирующий вход для OMP через **поддержанный** публичный API, без ручной записи внутреннего формата.

Оба варианта требуют исполнения/сборки upstream-кода и/или Bun и потому выходят за границу текущего задания.

## Артефакты

- `src/migration/omp-import-capability.ts` — замороженный типизированный вердикт (потребляется Stage 4 preview).
- `tests/omp-import-capability.test.ts` — 4 теста (unsupported + что реально поддержано + frozen + гипотетический supported-путь).
- `scripts/omp-import-probe.mjs` — статический read-only probe закреплённого checkout; печатает JSON-вердикт, exit≠0 при дрейфе фактов, `{skipped:true}` если checkout отсутствует. Запуск 2026-09-24: drift=0, exit 0.

**Реальные пользовательские сессии не читались. Импорт не выполнялся.**
