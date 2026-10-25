# M11 — задание Phase 6: rollback и закрытие (25 октября 2026)

Исполнитель — владелец на Windows, elevated PowerShell. Координатор команд не выполняет.

Предусловие: **A4 принят** (пакет с 000256+). Если A4 `BLOCKED` — Phase 6 не начинать.

## 1. Immutable snapshot (до внешних действий)

Снять и сохранить вне рабочего дерева:

```powershell
git bundle create C:\<OWNED>\snapshots\m11-omp-integration.bundle omp-integration
Get-FileHash -Algorithm SHA256 C:\<OWNED>\snapshots\m11-omp-integration.bundle
# состояние приложения (если есть)
if (Test-Path .provider-dock) { Copy-Item .provider-dock C:\<OWNED>\snapshots\provider-dock -Recurse -Force }
# pinned binary
Get-FileHash -Algorithm SHA256 <PINNED_OMP_PATH>
```

Зафиксировать в `snapshot-manifest`: bundle hash, state hash, binary hash, время UTC, пути в redacted-форме.

## 2. Восстановление и проверка

1. Восстановить bundle в **отдельный owned** каталог (не поверх рабочего дерева).
2. Сверить дерево: `git fsck`, `git log`, совпадение HEAD и файлов с bundle.
3. Проверить state: сравнить хеши каталога с snapshot.
4. Проверить binary: hash совпадает с pinned.
5. Убедиться, что пользовательские homes, архивы и чужие профили не изменены и не удалены.

## 3. Residual-проверка

- 0 своих процессов (`omp.exe`, controller, helpers).
- 0 orphan, 0 открытых сессий ETW.
- 0 residual egress (монитор).
- Профиль `m11-pilot` отключён/удалён; credential отозван у issuer (подтверждение из A4).
- Локальная запись vault удалена после проверки bindings.

## 4. Аудит логов и redaction

- application/controller/gateway logs, shell history, temp/crash artifacts, staged diff;
- у issuer — usage/revocation audit за окно и после;
- сопоставить route/model/request/cost counters, исключить лишних потребителей;
- поиск по полному значению credential только локально, без значения в аргументах и без печати совпадений;
- повторный redaction-скан всех новых файлов; недоступный источник = «непроверено».

## 5. Финальный статус

Создать `m11-final-status` с честной таблицей по фазам:

| Фаза | Статус | Доказательство |
|---|---|---|
| Phase 0 | PASS | локальные gates, snapshot |
| A1 | PASS | `initialize`/`session/new`, 17/17, manifest 168/168 |
| A2 | PASS (наблюдение) | idle resume, linkage, hashes |
| A3 | PASS (наблюдение) | изоляция, egress counters |
| A4 | PASS/BLOCKED | один запрос, caps, отзыв |
| Phase 6 | PASS/BLOCKED | restore, residual 0, логи |

Никаких необъяснённых `BLOCKED`. Cutover и удаление legacy — вне M11 и требуют отдельного решения (глава 6 REMAINING_PLAN).

## 6. Evidence-контракт (append-only, продолжение после A4)

| ID | Файл | Содержимое |
|---|---|---|
| next+1 | `authorization-rollback-*.json` | окно, роли, scope, stop rules |
| next+2 | `snapshot-manifest-*.json` | bundle/state/binary hashes, UTC, redacted paths |
| next+3 | `restore-verification-*.json` | fsck, tree match, state match, binary match |
| next+4 | `residual-check-*.json` | processes, orphans, sessions, egress |
| next+5 | `log-audit-*.json` | источники, границы, совпадения, недоступное |
| next+6 | `summary-rollback-*.json` | PASS/BLOCKED, ссылки |
| next+7 | `integrity-hashes-rollback-*.txt` | SHA-256 всех файлов |
| next+8 | `m11-final-status-*.json` | таблица фаз, честный итог |

Номера выделять последовательно от текущего максимума; каждый JSON — с внутренним `integrityHash`.

## 7. Критерии приёмки Phase 6

1. Snapshot снят до действий, хеши совпадают.
2. Restore подтверждён: `fsck` 0, дерево/state/binary совпадают.
3. Residual: 0 процессов, 0 orphan, 0 egress, профиль выключен.
4. Credential отозван у issuer (подтверждение с UTC).
5. Пользовательские данные не изменены и не удалены.
6. Логи проверены; redaction чист.
7. Манифест покрывает все файлы; финальный статус честный.

## 8. Stop-правила

Restore mismatch, fsck error, residual process/egress, отсутствие revocation confirmation, изменение пользовательских данных, утечка в логах → **STOP**, `BLOCKED`, без «подгонки» статуса.

## 9. Публикация

```powershell
git add evidence/m11-pilot
git commit -m "evidence(m11): record rollback and final status"
git push origin omp-integration
```

Прислать: hash коммита, SHA-256 последнего манифеста, финальную таблицу фаз.

## 10. Чек-лист

- [ ] Snapshot (bundle/state/binary) и хеши
- [ ] Restore в отдельный каталог, fsck 0
- [ ] Совпадение дерева/state/binary
- [ ] Residual: 0 процессов/orphan/egress
- [ ] Credential отозван, подтверждение UTC
- [ ] Пользовательские данные целы
- [ ] Логи и redaction проверены
- [ ] Evidence + манифест
- [ ] `m11-final-status` без необъяснённых BLOCKED
- [ ] Push + хеши
