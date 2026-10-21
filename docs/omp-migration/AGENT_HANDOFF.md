# Текущий статус M11

**A1 NOT PROVEN; A4 BLOCKED; M11 BLOCKED на приёмке.** Пакет A1-D `121aa3e` опубликован и **принят как честная диагностическая запись**. A1 PASS не выдан: `initialize` не ответил, причина исходного exit 1 не установлена. A1-F (§3 `M11_FULL_EXECUTION_TASK.md`) требует отдельного разрешения владельца.

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
