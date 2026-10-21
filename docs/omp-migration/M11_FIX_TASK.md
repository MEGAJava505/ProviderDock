# M11 — задание на исправление и повторную диагностику (21 октября 2026)

Цель: закрыть P1-1 и P2-1…P2-3 из приёмки A1-D (`ade4655`), затем выполнить один диагностический прогон и, при валидном ответе протокола, открыть A1-F.

Исполнитель — владелец на Windows, elevated PowerShell. Координатор команд не выполняет.

## 0. Что именно исправляем

| ID | Проблема | Где видно |
|---|---|---|
| P1-1 | Блокирующий `FlushFileBuffers` на управляющем пути: flush держал handshake 15.54 с до watchdog | `acp-handshake-000167.json:77–91`, `summary-000170.json:57` |
| P2-1 | Бюджет deadline: подготовка 24.44 с, OMP получил 15.57 с при заявленных 45 с | `authorization-000159:30–39`, `config-000160:43–47`, `summary-000170:62–67` |
| P2-2 | Decoded self-test не связан с текущим (другие PID/время) | `preflight-000161:120–203` |
| P2-3 | Неполные I/O и protocol границы | `acp-handshake-000167:29–31,50,70–98` |

## 1. Исправление P1-1 — неблокирующая запись

Требование: управляющий цикл не должен блокироваться дольше **5 с** ни на write, ни на flush.

### 1.1 Схема

- Весь write/flush выполняется в отдельном worker-потоке.
- Управляющий поток ставит задачу в очередь и продолжает читать ответы.
- Если worker не завершился за `WRITE_TIMEOUT_MS` (2000) или `FLUSH_TIMEOUT_MS` (5000), фиксируется `writeTimeout`/`flushTimedOut=true`, worker помечается abandoned, цикл продолжается.
- Никаких синхронных `FlushFileBuffers` в основном потоке.

### 1.2 Референс (Python)

```python
import queue, threading, time, os

class BoundedWriter:
    def __init__(self, stream, write_timeout=2.0, flush_timeout=5.0):
        self.stream = stream
        self.write_timeout = write_timeout
        self.flush_timeout = flush_timeout
        self.q = queue.Queue()
        self.abandoned = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            item = self.q.get()
            if item is None:
                return
            data, result = item
            try:
                self.stream.write(data)
                self.stream.flush()   # только внутри worker
                result.update(ok=True, bytes=len(data))
            except Exception as e:
                result.update(ok=False, error=repr(e))

    def write(self, data, timeout=None):
        timeout = self.write_timeout if timeout is None else timeout
        result = {}
        self.q.put((data, result))
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if result:
                return result
            time.sleep(0.01)
        self.abandoned = True
        return {"ok": False, "timeout": True}

    def close(self):
        self.q.put(None)
```

### 1.3 Обязательные поля в evidence

`writeBeginUtc`, `writeEndUtc`, `bytesAttempted`, `bytesWritten`, `partial`, `writeError`, `flushMode` (`bounded`|`not-used`), `flushBeginUtc`, `flushEndUtc`, `flushResult`, `flushTimeoutMs`, `controllerBlockedMs`.

### 1.4 Проверка без actual OMP

Helper-сценарий: дочерний процесс, который **не читает stdin** (например, `cmd /c timeout /t 30`). Контроллер должен:

- вернуться из write/flush за ≤5 с;
- записать `flushTimedOut=true` (или `writeTimeout`), не зависнуть;
- корректно завершить helper по watchdog.

Это и есть test on P1-1.

## 2. Исправление P2-1 — раздельные бюджеты

Заменить единый `deadline` на явные стадии (монотонные часы):

| Стадия | Бюджет | Что измеряется |
|---|---:|---|
| setup/precreate (среда, Job, token, ETW) | ≤15 с | от старта контроллера до `ResumeThread` |
| protocol (write → ответ → session/new) | ≥60 с | от `ResumeThread` до ответа/таймаута |
| teardown | ≤15 с | остановка процессов, сессий, профиля |
| total watchdog | ≥90 с | аварийный предел |

Требования:

- В summary — отдельные поля `setupMs`, `protocolMs`, `teardownMs`, `totalMs`, а не одно `controllerDurationMs`.
- Watchdog не должен срабатывать раньше, чем истёк protocol-бюджет.
- `deadlineSatisfied` считается по каждой стадии отдельно.

### Проверка без actual OMP

Helper, который «молчит» 30 с: контроллер обязан дать ему полный protocol-бюджет и завершить по нему, а не по общему watchdog.

## 3. Исправление P2-2 — привязка self-test

Self-test должен выполняться **в тех же ETW-сессиях и в том же прогоне**, что и actual launch, и фиксировать:

- PID + creation time helper-процессов, их parent;
- ожидаемый и наблюдаемый exit code (например, 7);
- capture markers: сколько байт stdout/stderr реально получено;
- loopback: один запрос, 64 байта в каждую сторону, порт и PID;
- negative probe: direct TCP → `EACCES`/`10013`, время;
- decoded verification: тот же source hash, что и у live-сессий, с указанием «decoded after stop».

Если используется ранее декодированный self-test — добавить **append-only коррекцию** (`self-test-linkage-0001xx.json`) с явной связью: runId, PID, creation time, session names, хеши.

## 4. Исправление P2-3 — полные I/O и protocol границы

В handshake/IO evidence добавить:

- `requestId`, `payloadBytes`, `payloadSha256`, `encoding`, `framing`, `newline`;
- `writeBeginUtc`, `writeEndUtc`, `bytesAttempted`, `bytesWritten`, `partialWrites[]`, `writeError`;
- `flushMode`, `flushBeginUtc`, `flushEndUtc`, `flushResult`, `flushTimeoutMs`;
- границы кадров: `framesSent`, `framesReceived`, `frameBoundaries[]`, `parseResults[]`, `requestResponseLinkage`;
- stdout/stderr: `bytes`, `sha256`, `eof`, `pendingAtEof`, `redactions`, `complete`;
- runtime header/version: `observed` | `not-observed` с причиной;
- watchdog: `scheduleUtc`, `fireUtc`, `terminationUtc`, `reason`; отдельно `controllerExit` и `ompExit`;
- network: counters с фильтром по PID **и lifetime**, source/unit/baseline/final/delta;
- ETW: live loss snapshots и финальные `EventsLost`/`buffersLost` по каждой сессии.

## 5. Evidence-контракт (append-only)

Следующий свободный ID — **000172**. Выделять последовательно, проверить отсутствие коллизий.

| ID | Файл | Содержимое |
|---|---|---|
| 000172 | `authorization-fix-000172.json` | окно UTC, scope, роли, лимиты, stop rules, `launchCount=1`, `retries=0`, hashes контроллера/конфига |
| 000173 | `controller-fix-audit-000173.json` | что изменено: writer/flush, стадии deadline, версии, hashes; либо audit excerpt |
| 000174 | `config-fix-000174.json` | ETW-сессии, WER, redirects, expected helpers (`conhost.exe`), бюджеты |
| 000175 | `self-test-linked-000175.json` | PID/creation, exit 7, capture bytes, loopback, denied probe, decoded linkage |
| 000176 | `preflight-fix-000176.json` | pin SHA-256, VersionInfo, environment attestation, policy |
| 000177 | `process-tree-fix-000177.json` | controller→OMP→children, PID+creation, path+SHA-256, exit, orphan |
| 000178 | `network-counters-fix-000178.json` | counters с PID+lifetime фильтром |
| 000179 | `stdout-fix-000179.log` | сырой stdout + метаданные |
| 000180 | `stderr-fix-000180.log` | сырой stderr + метаданные |
| 000181 | `acp-handshake-fix-000181.json` | полные I/O и frame-границы |
| 000182 | `run-log-fix-000182.txt` | хронология UTC стадий |
| 000183 | `side-effects-fix-000183.json` | только owned fixture |
| 000184 | `summary-fix-000184.json` | итог, cause или NOT PROVEN, стадии, ссылки |
| 000185 | `integrity-hashes-fix-000185.txt` | SHA-256 всех файлов, включая backfill 000145 |

Каждый JSON — с внутренним `integrityHash` (canonicalization как в принятых пакетах). Манифест покрывает **все** артефакты фазы, включая `integrity-correction-backfill-000145.json`, или даёт явное обоснование исключения.

## 6. Порядок исполнения

1. Исправить контроллер: writer/flush (P1-1), стадии deadline (P2-1). Записать hashes.
2. Прогнать helper-тесты без OMP: «молчащий» child на 30 с, «не читающий stdin» child; подтвердить bounded возврат ≤5 с и полный protocol-бюджет.
3. Проверить self-test linkage (P2-2) и полноту I/O-полей (P2-3) на helper-прогоне.
4. Только после PASS helper-тестов — получить **отдельное разрешение владельца** на diagnostic run.
5. Один actual launch: pinned `omp.exe` 18.0.4, SHA-256 `1944c6e2a4f8e652f656e0d500b88a68a5f15f234258bef06a91a7aa6755d4ba`, inert fixture, `launchCount=1`, `retries=0`, без provider/credentials.
6. Собрать evidence 000172–000185, teardown, orphan=0, `EventsLost=0`.
7. `git add evidence/m11-pilot && git commit && git push`, прислать hash коммита и SHA-256 манифеста `000185`.

## 7. Критерии приёмки исправления

- P1-1: контроллер не блокируется >5 с на write/flush; helper-тест подтверждает bounded возврат.
- P2-1: стадии разделены, protocol получает ≥60 с, watchdog ≥90 с, summary содержит `setupMs/protocolMs/teardownMs`.
- P2-2: self-test привязан к PID/времени текущего прогона, либо есть append-only коррекция связи.
- P2-3: все перечисленные поля присутствуют; отсутствующие — `null`/`not-observed` с причиной.
- Integrity/redaction: манифест полный, внутренние hashes сходятся, секретов нет.

## 8. Stop-правила

Helper-тест не PASS, flush не bounded, стадии не разделены, self-test не привязан, потери ETW, unexpected egress/child, cap breach, hash mismatch, side effect вне fixture → **STOP**, `BLOCKED`/`NOT PROVEN`, без actual launch и без повторов.

## 9. Что открывается после

- Приёмка исправления и диагностического пакета → обсуждение A1-F (§3 `M11_FULL_EXECUTION_TASK.md`).
- A1-F PASS — только при валидном ответе `initialize` и `session/new`; иначе A1 остаётся NOT PROVEN.
- A4 — отдельно, по чек-листу: scoped credential, pinned модель, caps, UTC-окно, отзыв.

## 10. Чек-лист

- [ ] Writer/flush вынесен из управляющего потока
- [ ] Таймауты write ≤2 с, flush ≤5 с, abandoned-логика
- [ ] Стадии setup ≤15 с / protocol ≥60 с / teardown ≤15 с / watchdog ≥90 с
- [ ] Helper-тест «молчащий child» PASS
- [ ] Helper-тест «не читает stdin» PASS
- [ ] Self-test привязан к PID/времени прогона
- [ ] I/O-поля P2-3 заполнены
- [ ] Evidence 000172–000185 + манифест со всеми файлами
- [ ] Отдельное разрешение на diagnostic run
- [ ] Один launch, teardown, orphan=0, EventsLost=0
- [ ] Push + hash коммита и манифеста
