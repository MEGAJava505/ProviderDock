## M8 — отчёт исполнителя

### Сделано
- Подготовлено [решение Step 5](../STEP5_FIXTURE_IMPORT_DECISION.md): сравнение Bun library / RPC / ACP / SDK, source evidence, контракт readback и таблица пяти окон сбоя, изменения hash и конкуренции. Статус импорта и автоматического повтора — **BLOCKED/NOT PROVEN**.
- Обновлены `docs/omp-migration/REMAINING_PLAN.md` и `docs/omp-runtime-runbook-ru.md`. Прежний `docs/omp-migration/PEER_REVIEW.md` архивирован в `docs/omp-migration/archive/2026-10-01-pre-m8-peer-review.md`; раздел M8 содержит текущий отчёт. Восстановленный перед ним старый текст совпал со snapshot и сохранён. Всего пять doc-файлов; production-код и upstream не менялись.

### Проверено
- 1 октября 2026: `node scripts/omp-import-probe.mjs` — exit 0, pin `0c6c981…`, восемь фактов true, `unsupported`, `drift:[]`.
- `git -C .scratch/omp rev-parse HEAD` и `git -C .scratch/omp --no-optional-locks status --porcelain=v1 --untracked-files=all` — exit 0; закреплённый HEAD совпал, checkout чистый.
- `node .scratch/m8-static-audit-mlO5M7/verify-m8.mjs` — exit 0: 135 локальных ссылок, 75 диапазонов source evidence, whitespace пяти документов; архив и 256 файлов вне scope сохранены.
- `git diff --check` — exit 0, только предупреждения CRLF. Просмотрены M8-diff и новые untracked-документы.
- Повторная сверка `AGENT_HANDOFF.md` с начальным snapshot через `Get-FileHash -Algorithm SHA256` — совпадение; запрет runtime-этапа не изменён.
- **Standards:** no findings — независимое статическое review документов.
- **Spec:** no findings — независимое статическое review по M8.1–M8.3. Это не приёмка исполнения импорта.

### Не проверено / ограничения
- Bun не найден в `PATH`; OS filesystem/network-isolated runner не доказан. Нужны отдельное разрешение на него и проверенные strict reconciliation, operation marker и verified-finalize с межпроцессным владением. `SessionManager.open()` может записать missing/corrupt target; tolerant listing `[]` не разрешает повтор.
- Bun/importer, реальные homes/ключи/transcript, сеть, платный VSLLM, live v2, реальный OMP-пилот, cutover и commit/push/PR не выполнялись. Build/typecheck/полный suite не запускались: пакет doc-only. **Общая `/goal` не завершена: статус `blocked` до отдельного решения о runtime/recovery-этапе.**

### Skills
- Использованы: `using-superpowers` — маршрутизация; `research` — первичные локальные исходники; `code-review` — независимые Standards/Spec; `verification-before-completion` — фактический doc-only gate.
- TDD не применялся: runtime не менялся.

## Независимое review M8 — локально принято после исправления ссылок (1 октября 2026)

**Объект:** doc-only отчёт M8 выше и `STEP5_FIXTURE_IMPORT_DECISION.md` на `omp-integration` / HEAD `5025cb3`. Ни importer, ни Bun, ни живые данные в этом review не запускались.

**Подтверждено по pinned source:** `persistForeignSession()` вызывает `store.load(info)`, добавляет provenance и `persistCopy()`; copy создаёт новую OMP identity. `listSessionsReadOnly()` и `FileSessionStorage.listFilesSync()` скрывают ошибки как `[]`, а `loadSessionFile()` различает non-ENOENT ошибки, но ENOENT/невалидный header отдаёт пустые entries. `SessionManager.open()` после пустого чтения может изменить target. `packages/utils/src/env.ts` при загрузке читает `.env` из home/config/cwd. Поэтому вывод M8 **BLOCKED/NOT PROVEN** для fixture-импорта и автоматического повтора соответствует доступным доказательствам; выбранный Bun library API остаётся кандидатом, не принятым исполнением. Таблица отказов не разрешает ложный `imported` или слепой повтор.

**Проверки reviewer:** `node scripts/omp-import-probe.mjs` — exit 0, pinned `0c6c981ee5838d97700180383077eb0a3790637c`, `unsupported`, `drift:[]`; pinned checkout clean. Независимо проверены 135 локальных Markdown-ссылок в текущем пакете и 46 явных source-line диапазонов — ошибок нет; `git diff --check` exit 0 (информационные CRLF warnings). Авторские 75 диапазонов и snapshot-аудит не воспроизводились целиком; ключевые исходники прочитаны напрямую. Build/typecheck/полный suite reviewer не запускал, поскольку runtime-код M8 не менялся.

**Исправление интеграции документов:** исполнитель перенёс прежний `PEER_REVIEW.md` в архив и оставил в основном файле только M8, хотя прежние ссылки плана/runbook вели к основному файлу. Reviewer вернул **14 исторических разделов** в `PEER_REVIEW.md`, затем сохранил M8 как пятнадцатый раздел; архивная копия остаётся. Старые ссылки снова ведут к названным вердиктам. Текст прошлых выводов не менялся, только относительные пути ссылок при обратном переносе.

**Вердикт:** M8 **локально принят как статическое решение**, Step 5 остаётся **BLOCKED/NOT PROVEN**. Для fixture-run нужны отдельное решение об изолированном Bun-runner, строгий error-bearing readback, operation marker и verified-finalize с владением; согласие на один только Bun не покрывает эти условия. Платный VSLLM-запрос, live v2, реальный OMP-пилот и работа с живыми transcript остаются отдельными внешними gates. [M8 архивирован](2026-10-01-m8-handoff.md); следующее [M9](2026-10-01-m9-handoff.md) исправляет ложную формулировку «платный пилот подтверждён» в локальном Step 6 preview: текущий accepted gate означает только готовность **к** пилоту. Общая миграционная `/goal` открыта.
