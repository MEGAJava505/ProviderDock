# Текущий статус M11

## Текущий статус A1 — 24 октября 2026, пакет 000242–000255

**A1 PASS по A1-F; A4 BLOCKED; весь M11 ещё не завершён.** Единственный запуск
`M11-A1D-FIX-909f2e9abafc4f6f8ab6094b8c6fd1f2`: `actualLaunches=1`, `retries=0`,
OMP и controller завершились с кодом 0. Валидные ответы `initialize` и `session/new`
получены; runtime header — 18.0.4. Все 17 проверок summary и все четыре deadline
пройдены: setup 7295.238 ms, protocol 6132.457 ms, teardown 860.682 ms, total
14288.376 ms.

Self-test связан с этим же runId, ETW-сессиями и PID/creation time. Все пять источников
ETW завершились с `eventsLost=0` и `buffersLost=0`; exit-коды self-test совпали с
ожидаемыми, loopback передал 64 байта в каждом направлении, negative TCP probe был
запрещён. Summary фиксирует нулевой наблюдаемый egress, полный process tree,
`orphan=0` и завершённый teardown. Независимое read-only ревьюерское заключение:
**PASS**, блокеров приёмки не найдено. В network summary исключены 26 912 host ETW
событий вне PID/lifetime scope; ни одно из них не было приписано OMP.

Проверка manifest `integrity-hashes-a1-final-000255.txt`: SHA-256 совпадает с заявленным
`b6cd1e2a73a3094738cd26a38ba83ecd5d05e0e62aa7b01137d7115ba4607969`, но **воспроизводимость неполная**:
`sha256sum -c` даёт **160/168 OK**, восемь записей указывают на отсутствующие файлы
(`stdout/stderr-fix-000193/000194/000207/000208`, `stdout/stderr-a1-final-000221/000222/000249/000250`).
Причина — `.gitignore:14 *.log`; в коммите нет этих логов, `git ls-tree` для каталога A1 даёт 161 файл.
Приёмка A1-F поэтому **условная**: PASS по существу, но пакет не полностью проверяем до исправления манифеста. Значение
`reviewAcceptance=pending` в immutable summary отражает состояние на момент его
создания; настоящий вердикт зафиксирован здесь. Это не открывает A4: для него отдельно
нужны утверждённые route/model/caps и план отзыва credential. Старые NOT PROVEN записи
ниже сохранены как история и этим результатом superseded.

## Продолжение диагностики — 24 октября 2026, локальные изменения

Новый A1-D run `M11-A1D-FIX-7f99790c0c2e439e82d506d8bb5d6f83` прошёл все 12 checks:
setup 7258.865ms (включает SEC_IMAGE 6020.245ms), CreateProcessW 22.621ms,
initialize response/version 18.0.4, exit 0, ETW loss 0, orphan 0, cleanup complete.
Protocol 25098.287ms завершился ответом; flush worker пережил 5s timeout, main loop продолжил работу.
Evidence 000200–000213, manifest `9719b56990284f925616918ff996ae15ae2487d311d48d2ec437b58f8c56d1ec`.
Это исполнительская проверка A1-D; A1 пока NOT PROVEN, independent review pending.

Следующий шаг A1-F: 000214–000227, один launch initialize/session-new/EOF в fresh AppContainer,
прежние бюджеты, пустой mcpServers, без inference. Контракт newSession статически подтверждён во встроенном
JS pinned omp.exe (offset 121131379 приблизительно): absolute cwd, mcpServers; result.sessionId.
Standing authorization владельца из чата действует; каждый runner пишет отдельную свежую запись scope/окна.

### Результат A1-F — 24 октября 2026

Единственный A1-F run `M11-A1D-FIX-ef794c26de704252ad46a2ac25f5b2ae` выполнен один раз,
`actualLaunches=1`, `retries=0`, pinned hash совпал, setup 6940.563 ms, protocol 6491.330 ms,
teardown 943.227 ms, total 14375.119 ms, OMP/controller exit 0, ETW loss 0, orphan 0,
process tree и cleanup прошли. ACP фактически завершил оба запроса: initialize и `session/new`;
ответ `session/new` содержит UUID `sessionId`, массив `configOptions` и объект `modes`.

Пакет `000214–000227` оставлен append-only и проверяется: manifest SHA-256
`b20287bf24074fc56ec9d7dab60a7e45da045a10e0fd0eecaac4cd3f2596f7b0`, 151 файлов покрыто.
Итог пакета — **A1 NOT PROVEN** по двум наблюдаемым причинам. Во-первых, контроллер ожидал
`configOptions` как объект, хотя pinned ACP вернул массив; это исправлено после запуска и покрыто
helper regression-тестом, поэтому исходный пакет нельзя пересчитывать под новым кодом.
Во-вторых, в lifetime OMP ETW зафиксировал четыре DNS-события для `zenmux.ai` (A/AAAA),
включая `QueryStatus=5`; TCP/IP/WFP transmitted bytes и соединения равны нулю, но попытка DNS
всё равно нарушает stop-правило unexpected egress. Неизвестные/запрещённые DNS-события не
переклассифицируются в PASS. Повтор actual не выполняется в этой фазе.

После run helper-код обновлён: валидатор принимает реальную ACP-форму `configOptions[]` +
`modes.availableModes/currentModeId`, проверяет owned absolute `cwd`, а controller exit теперь
fail-closed при protocol failure. Текущие source hashes: `a1d_controller.py`
`dba363a12f2b0ee4c6ba13f6b5d98907d898580174d558b426c72d78693091e2`, `test_controller.py`
`a7a6ceb4566efa643f311050876727bfeaedef7a608b25263e13fa925e34fdfc2`; они намеренно не
подставляются в уже опубликованный A1-F пакет. A1 остаётся NOT PROVEN, A4 не открыт.

Последний actual run `M11-A1D-FIX-716b19f18fdb4cb89340f93c96d69a13` сохранён в evidence 000186–000199:
`setupMs=24155.209`, внутри `CreateProcessW=23029.785ms`; `ResumeThread` не вызван,
`protocolMs=0`, `a1=NOT PROVEN`. Все проверки summary, кроме deadlines, прошли.
Манифест 000199: `7476b4b117c14c8a64b6ec467c412ab2cdcc0b4aaf702edffe6bfc0f3132a934`.
Эти артефакты не изменять; следующий диагностический пакет — 000200–000213.

Проверка защитных журналов не установила виновный драйвер: Defender сейчас passive, MPLog не содержит OMP,
Code Integrity сообщает о браузерах. Наблюдение на свежем Node-helper размером 190118912 байт:
создание в AppContainer 14036.576ms; с удержанием предварительно созданного SEC_IMAGE — весь helper 7123.704ms,
из них CreateProcessW 17.125ms. OMP в этих probes не запускался. Это обоснование проверяемой оптимизации,
не доказательство устранения задержки actual OMP и не доказательство вины конкретного антивируса.

Текущий план: (1) SEC_IMAGE внутри прежнего setup, закрытие handles при отказе;
(2) regression tests, полный no-OMP suite и проверка diff;
(3) один новый diagnostic run с прежними лимитами и fresh authorization record на основании разрешения владельца в чате;
(4) проверить реальный setup/initialize, затем решать A1-F. Лимиты и точка старта setup не сдвигаются.
Первый и второй пункты не открывают A1-F/A4 сами по себе. Старое состояние приёмки ниже сохранено как история.

**Исторический статус после A1-D (20 октября): A1 NOT PROVEN; A4 BLOCKED; M11 BLOCKED на приёмке.** Пакет A1-D `121aa3e` опубликован и **принят как честная диагностическая запись**. На тот момент A1 PASS не выдан: `initialize` не ответил, причина исходного exit 1 не установлена. A1-F (§3 `M11_FULL_EXECUTION_TASK.md`) требовал отдельного разрешения владельца.

Прежнее задание A1-D перенесено в [архив](archive/2026-10-20-a1d-acceptance-handoff-archive.md). [Полное задание M11](M11_FULL_EXECUTION_TASK.md) остаётся в силе; §3 не изменён.

## Результат приёмки A1-D — 20 октября 2026

**Исполнитель приёмки:** координатор (Элиус). Модели Astra/Opus/Fable были недоступны: `gpt-6-astra` зависал без вывода, `claude-opus-5-5` и `claude-fable-5` получили 429/high demand после 5 реконнектов. Проверки выполнены механически по чек-листу Astra; независимый модельный ревью не состоялся и это зафиксировано.

**Решение: A1-D принят как честная диагностическая запись. A1 остаётся NOT PROVEN, A4 BLOCKED.**

### Подтверждено

| Проверка | Результат |
|---|---|
| Append-only | `git diff --name-status 30c3357..121aa3e` — только `A`; 14 новых файлов, +1397; старые evidence не изменены |
| Манифест `000171` | `sha256sum -c` — **12/12 OK**, missing/mismatch 0 |
| Внутренние `integrityHash` | **10/10 OK** (000159–000163, 000166, 000167, 000169, 000170, 000145) |
| Redaction | 0 совпадений: секреты, Bearer, токены, cookies, абсолютные пути, email |
| Self-test | PASS: exit 7, 64-байтный loopback, direct TCP denied |
| Launch | один; CreateProcess suspended → ResumeThread; `initialize` записан 159 байт; `FlushFileBuffers=false`; ответа нет |
| Exit code | 124, `imposedByWatchdog=true`; controller 40043 мс, precreate 24435 мс, OMP lifetime 15567.7 мс |
| Потери ETW | EventsLost/LogBuffersLost/RealTimeBuffersLost = 0 |
| Процессы/сеть | orphan=0; declaredConhostObserved=1; unexpectedEgress=0; provider/inference requests=0; cost=0 |
| Cleanup | WER restored=true; fresh profile deleted=true; retries=0 |
| Честность summary | `a1=NOT PROVEN`, `a1d=NOT PROVEN`, rootCause честно отделяет watchdog-артефакт от исходного exit 1 |

### NOT PROVEN

- Причина исходного exit 1 (не воспроизведена; exit 124 — артефакт watchdog).
- Доставка `initialize`: 159 байт записаны, но flush вернул false, подтверждения доставки нет.
- Содержимое stdout/stderr: файлы созданы, но **0 байт**.
- Runtime version/header: не наблюдались.

### Замечания

**P1 — нет.**

- **P2-1 — манифест не покрывает `integrity-correction-backfill-000145.json`.** Файл в коммите есть, внутренний hash у него OK, но в `000171` его нет. Следующий манифест должен включать все артефакты фазы, либо дать явное обоснование исключения.
- **P2-2 — формулировка `stdoutCapturedOnTerminalPath: true` при 0 байт.** Корректно: «redirection активен, получено 0 байт». Текущая формулировка читается как «захвачен вывод», чего нет.
- **P2-3 — блокирующий `FlushFileBuffers` и бюджет дедлайна.** Синхронный flush заблокировал контроллер; из 40 с бюджета 24.4 с ушло на precreate, на протокол осталось ~15.6 с. Это дефект контроллера, а не OMP.
- **P2-4 — exit 124 нельзя трактовать как режим отказа OMP.** Summary это уже говорит; следующая запись не должна ссылаться на 124 как на поведение бинаря.

### Достаточно ли данных для A1-F

**Нет.** Диагностика не объяснила, почему OMP не ответил: доставка `initialize` не подтверждена, stdout/stderr пусты, причина исходного exit 1 не воспроизведена. Запускать A1-F сейчас — значит потратить второй бюджет без новой информации.

**Нужен ещё один диагностический прогон** (только с отдельным разрешением владельца):

1. Неблокирующая запись/flush: overlapped I/O или отдельный writer-поток с собственным дедлайном; контроллер не должен зависать на `FlushFileBuffers`.
2. Раздельные бюджеты: precreate ≤15 с, протокол ≥60 с, общий watchdog ≥90 с.
3. Подтверждение доставки на уровне сокета/канала (ack или счётчик принятых байт на стороне OMP), а не только `write` в stdin.
4. stdout/stderr: гарантировать сброс буферов на аварийном пути; при 0 байт фиксировать это как факт, а не как «capture».
5. Runtime version/header — из файла/VersionInfo и, если возможно, из handshake.
6. `conhost.exe` остаётся declared helper.
7. Новые append-only ID (следующий свободный — проверить по каталогу), манифест покрывает все файлы фазы.

### Требования к A1-F (после отдельного разрешения)

- Только после приёмки нового диагностического пакета.
- Один bounded launch, pinned OMP 18.0.4 (`1944c6e2…`), inert fixture.
- PASS только при ответе `initialize` и завершении `session/new`; иначе `NOT PROVEN`.
- Evidence: authorization/preflight/process-tree/network/handshake/run-log/side-effects/summary/manifest с внутренними hash.
- Stop-правила: self-test fail, EventsLost>0, unexpected child/egress, cap breach, timeout, hash mismatch, side effect вне fixture → стоп без повторов.

**Итог:** A1-D принят; M11 остаётся BLOCKED; A4 не открыт; следующий шаг — решение владельца о втором диагностическом прогоне по пунктам выше.

## Дополнение — независимое модельное ревью через Codex, 21 октября 2026

**Как выполнено:** модели VSLLM были недоступны — `gpt-6-astra` отдаёт 410/hang, `claude-opus-5-5` и `claude-fable-5` — 429, `gpt-6-sol`/`gpt-6-luna` висят. Ревью выполнено через сам Codex (default route, ChatGPT auth), exit 0, полный отчёт в `/tmp/a1d-verdict.md` (75 строк). Основной репозиторий не изменялся.

**Вердикт ревью:** A1-D принят как честная запись STOP; A1 остаётся NOT PROVEN. Integrity/redaction нарушений нет; P2-S1 backfill закрыт (19/19 fileSha256 и 19/19 canonicalSha256).

**Уточнение к разделу выше:** классификация «P1 — нет» заменяется. Независимое ревью выявило P1:

- **P1-1 — блокирующий синхронный `FlushFileBuffers` на управляющем пути.** `acp-handshake-000167.json:77–91`, `summary-diagnostic-000170.json:57`: flush удерживает шаг handshake ~15.54 с до watchdog, из-за чего прогон диагностически неполон (нет ответа, нет границ кадров).
- **P2-1 — deadline не даёт заявленного окна actual OMP.** authorization 45 с, внешний watchdog 43 с, внутренние 40 с; подготовка заняла 24.44 с, OMP получил 15.57 с.
- **P2-2 — decoded self-test не связан с текущим self-test.** Decoded lifecycle 17:58:42–45Z, PID 37672/32248/35644, loopback 5944 против текущего selfTest в 000161; связь не доказана.
- **P2-3 — неполные I/O и protocol границы.** Нет точных write/flush begin/end, payload/frame hash, отдельных frame/parse outcomes; runtime header/version не наблюдались (PE VersionInfo есть в 000161).

**Требования до A1-F:**
1. Без actual OMP исправить P1-1 и P2-1, опубликовать проверяемый patch или безопасный audit excerpt контроллера/конфига с hashes.
2. Проверить helper-сценариями: reader не читает stdin; раздельные setup/runtime/write/response/teardown deadlines; watchdog не маскирует причину.
3. Закрыть P2-2 append-only коррекцией из сохранённых источников либо честно записать отсутствие подтверждения; в новом прогоне связать self-test с теми же monitor PID/временем.
4. Закрыть P2-3: полные I/O-события, request ID, безопасная форма/хеш отправленных байтов, flush либо `not used` с причиной.
5. Только после этого — отдельное разрешение владельца на дополнительный диагностический прогон (один launch, retries=0, увеличенный согласованный deadline, нулевые provider/inference/cost).
6. A1-F — отдельно, по §3 `M11_FULL_EXECUTION_TASK.md`; PASS только при валидном ответе `initialize` и `session/new`.

**Итог без изменений:** A1-D принят; A1 NOT PROVEN; A4 BLOCKED; M11 BLOCKED; следующий шаг — исправление P1-1/P2-1 и новое разрешение владельца.

## Приёмка A1-F — 25 октября 2026 (координатор)

**Вердикт: A1-F PASS по существу подтверждён; приёмка пакета — условная из-за дефекта манифеста.**

Подтверждено по `summary-a1-final-000254.json` и пакету 000242–000255:

- `initialize` и `session/new` — валидные ответы, runtime header 18.0.4;
- `actualLaunches=1`, `retries=0`, OMP и controller exit 0;
- 17/17 проверок summary = true;
- дедлайны: setup 7295.238 ms, protocol 6132.457 ms, teardown 860.682 ms, total 14288.376 ms;
- `eventsLostAllZero=true`, orphan 0, teardown complete, egress 0;
- SHA-256 манифеста `b6cd1e2a…` совпадает с заявленным.

**P1-1 — манифест невоспроизводим.** `sha256sum -c` даёт 160/168 OK; отсутствуют 8 файлов:
`stdout/stderr-fix-000193/000194/000207/000208`, `stdout/stderr-a1-final-000221/000222/000249/000250`.
Причина — `.gitignore:14 *.log`; в коммите их нет (`git ls-tree` каталога A1: 161 файл).
Это значит, что PASS опирается на артефакты, которых нет в репозитории.

**Требуемое исправление (append-only, коммит 69fcbb8 не переписывать):**
1. `git add -f` этих 8 логов, проверить redaction (секретов/путей быть не должно), добавить их в новый манифест;
2. либо новая коррекция манифеста с явным исключением и причиной, а заявление «168 файлов» заменить на фактическое покрытие;
3. приложить SHA-256 нового манифеста и хеш коммита.

**P2-1 — падающий тест DPAPI.** Полный `npm test` 1200/1201; падает Windows-специфичный тест `tests/dpapi-secret-vault.test.ts`. На A1 не влияет, но должен быть исправлен или явно признан известным дефектом до cutover.

**P2-2 — `reviewAcceptance=pending`.** Допустимо как immutable-история, но следующая запись должна ссылаться на этот вердикт.

**Статус:** A1 — PASS условно; A4 — BLOCKED; M11 не завершён. Для A4 отдельно нужны утверждённые route/model/caps и план отзыва credential.
