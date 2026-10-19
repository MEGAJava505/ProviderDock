# Архив handoff M10-R и M10-R2 — 18 октября 2026

Этот срез сохраняет заменённые результаты, прежнее промежуточное задание и отозванный статус исполнителя. Актуальный вердикт координатора находится в [AGENT_HANDOFF.md](../AGENT_HANDOFF.md).

## Результат проверки M10-R координатором — 18 октября 2026

**Вердикт: M10-R не принят полностью; локальные проверки, не требующие loopback/browser, подтверждены, а независимый dashboard/browser gate — BLOCKED средой.** Это не установленная регрессия production-кода. Не объявлять browser smoke PASS по отчёту исполнителя, пока его не повторит координатор на Windows-host с разрешённым `127.0.0.1` и заданным браузером.

**Подтверждено:** ранее в этом запуске `npm run typecheck` и `npm run build` прошли, сборка выдала 130 JS. Координатор повторил `tests/omp-runtime`, `omp-launch-service`, `omp-process-supervisor` и `omp-route-readiness-preview`: **4 файла / 124 теста PASS**. Оба изменённых smoke-скрипта проходят `node --check`; `git diff --check` для текущего worktree — exit 0. Число исполнителя **7 файлов / 198 тестов** арифметически согласуется с составом: 124 + integration harness 18 + provider-dashboard-omp 15 + provider-dashboard-server 41. Его browser evidence и результаты Brave остаются отчётом исполнителя, а не свежим независимым PASS.

**Причина массовых отказов dashboard suites:** отдельно повторены `tests/provider-dashboard-server.test.ts` (**38/41 failed**) и `tests/provider-dashboard-omp.test.ts` (**15/15 failed**). Во всех случаях первичная ошибка одна: `listen EPERM: operation not permitted 127.0.0.1`; это каскадный отказ тестов, которым нужен `ProviderDashboardServer`, а не различающиеся assertion-регрессии. `tests/omp-integration-harness.test.ts` при том же запрете не завершился за 15 s (`timeout` exit 124): его loopback-fixture ждёт callback `server.listen()` без обработки `error`. В данной Linux-среде `PROVIDERDOCK_TEST_BROWSER` не задан, дефолтный Windows Chrome отсутствует и Chrome/Chromium/Edge/Brave не найден в `PATH`; browser smoke поэтому **BLOCKED** также по отсутствию браузера. Запуск smoke здесь не даёт корректного PASS-доказательства и не предпринимался.

**Замечания:**

1. **P1 — нет.** Проверенные отказы dashboard-наборов не дают признака функциональной регрессии: все сходятся к запрету loopback bind до проверяемых сценариев.
2. **P2 — loopback error path тестовой инфраструктуры.** `tests/omp-integration-harness.test.ts` и `scripts/omp-browser-stack-smoke.mjs` ожидают успешный callback от `listen()` без reject на `error`; при `EPERM` harness зависает. M10-R2 должен добавить bounded/error-aware startup только в fixture/smoke и RED→GREEN для bind refusal; production-код не менять ради этого наблюдения.
3. **P2 — whitespace вне локального M10-R worktree diff.** Текущий `git diff --check` чист, но проверка накопительного диапазона `5025cb3..HEAD` сообщает `scripts/credential-recovery-smoke.mjs:909: new blank line at EOF`. Это не блокирует результат M10-R, но владелец следующего широкого cleanup должен исправить или обоснованно исключить его.

### Следующий блок: M10-R2 — воспроизводимая независимая локальная приёмка

1. Работать на Windows-host, где разрешён bind только на loopback, и задать существующий `PROVIDERDOCK_TEST_BROWSER`; записать путь и версию, без профиля пользователя. До кода воспроизвести bind-refusal с timeout, затем исправить fixture/smoke error-path минимально и показать RED→GREEN: быстрый ненулевой exit с различимой причиной, cleanup только собственных ресурсов.
2. Повторить `node --check` обоих smoke, `git diff --check`, typecheck/build и семь целевых Vitest-файлов. Для dashboard-поднабора требуются реальные HTTP-сценарии, не только арифметическая сверка; ожидаемый полный итог — 7/198 при неизменном наборе.
3. Повторить `omp-browser-stack-smoke.mjs` normal и `--negative` последовательно: normal exit 0 только после cleanup; negative должен дать дочерние ненулевые exits без nested `ok:true`; проверить сохранённые report/screenshots и HTTP 202/runId/UI/disk/cancel/restart/side-effect evidence. При отсутствии browser или loopback оставить точный `BLOCKED`, не PASS.
4. Не менять production routing или permission model без нового требования. Только loopback, synthetic fixture и `omp-fake-child`; без commit/push/PR, live-ключей/homes/transcripts, настоящего `omp.exe`, paid-запросов, Doctor, внешней сети, OS ACL/isolation или cutover.

**Критерий M10-R2:** независимый повтор всех локальных gates завершается с exit 0, browser evidence остаётся после cleanup, bind-refusal завершается ограниченно и понятно, review diff не содержит новых P1/P2. До этого статус главы 5: synthetic loopback evidence есть, browser acceptance координатором **NOT PROVEN/BLOCKED**.

### Корректировка результата M10-R — 18 октября 2026; уточнённое задание Sol M10-R2

**Уточнённый вердикт:** прежний вывод принимается только с этой корректировкой. M10-R пока не принят полностью: установлен воспроизводимый дефект чтения run-record при конкурентной атомарной замене. Прежняя атрибуция запрета loopback всему VPS и статуса dashboard как BLOCKED отозвана. Исторический текст выше сохранён; этот раздел уточняет его факты, объём M10-R2 и критерии приёмки. Требование Windows-host для локальных проверок снимается.

**Независимые данные OpenClaw, переданные пользователем:** вне codex-sandbox `net.createServer().listen(0, '127.0.0.1')` работает; dashboard-наборы проходят **2 файла / 56 тестов (41 + 15) PASS**. Полный harness-файл даёт 3–8 отказов из 18 с `OMP_RUN_UNSAFE_PATH`, хотя отдельный тест проходит. Linux x86_64, ext4 `/dev/vda1`, Node v24.22.0; обычные новые файлы имеют `nlink=1`. Эти результаты принадлежат независимой проверке, а не повторному запуску координатора внутри sandbox.

**Точная причина, подтверждённая локальным детерминированным воспроизведением:**

1. `create()` публикует запись через `write()`; дальнейший `transition()` пишет новый `.tmp` и вызывает `renameWithRetry(temporary, destination)`. Writer-lock сериализует писателей, но `get()`/`read()` наблюдателя его не берёт.
2. `read()` сначала делает `lstat(file)` с `nlink=1`, затем открывает файл. Между `open()` и первым `handle.stat()` либо между чтением байтов и заключительным `handle.stat()` писатель заменяет JSON через `rename()`.
3. Открытый дескриптор продолжает ссылаться на старый inode. После замены его последняя directory entry удалена, поэтому **`nlink=0`**, `isFile=true`, `isSymbolicLink=false`. По тому же пути уже находится другой inode с `nlink=1`. Это обычная семантика POSIX atomic replacement; дополнительных hard links и symlink-каталога для отказа не требуется.
4. `assertRegular(opened)` или `assertRegular(after)` проверяет `nlink !== 1n` **раньше** `sameFile(...)` и выдаёт `OMP_RUN_UNSAFE_PATH` вместо ожидаемого transient `OMP_RUN_CHANGED`. `safely()` сохраняет этот код. `waitFor()` (чтение на строке 224) повторяет только `OMP_RUN_CHANGED`, поэтому обрывает тест на этой гонке. Полный прогон увеличивает вероятность пересечения polling с переходами supervisor; взаимовлияние разных тестов не требуется для воспроизведения.

**Доказательство координатора в текущем sandbox:** отдельный Node filesystem probe показал `nlink: 1 → 0` на открытом старом inode после настоящего `rename()`, новый inode по пути — `nlink=1`. Затем текущий `omp-run-repository.ts` был преобразован встроенным Node `stripTypeScriptTypes` в памяти (без изменения файлов; dependency diagnostic взята из существующего `dist`). В отдельном процессе временный перехват `FileHandle.stat` вставил настоящий `repository.transition(..., 'STARTING')` в каждое из двух окон чтения. Оба сценария завершились ожидаемым `OmpRunStorageError: OMP_RUN_UNSAFE_PATH`, при следующем `get()` — `STARTING`; probe exit 0. Проверены `isFile=true`, `isSymlink=false`, сохранение старого inode дескриптором и замена inode по пути. Перехват восстановлен, собственные temp-каталоги удалены; код и тесты не менялись.

**Ограничения текущей проверки:** короткий bind probe внутри codex-sandbox снова дал `EPERM` (exit 1); это ограничение sandbox, не VPS. Запущенный здесь полный Vitest harness не дал итогового результата и был остановлен координатором (exit 130); он не засчитывается ни как воспроизведение внешних 3–8 отказов, ни как PASS. Полный RED и последующие три GREEN требуются от Sol вне этого ограничения. Dashboard 56/56 выше — внешнее доказательство OpenClaw. P2 про зависание при bind-refusal сохраняется: fixture и smoke ждут только callback `listen()` без reject на `error`.

**Browser gate: BLOCKED из-за системных библиотек.** По независимой проверке Chrome 155 установлен: `/home/agent/.cache/browsers/chrome/linux-155.0.8059.84/chrome-linux64/chrome`. Для запуска не хватает 13 системных библиотек, включая `libatk-1.0.so.0`; root-доступа нет. Прежняя причина «браузер отсутствует» уточнена. Наличие executable не означает успешный browser smoke. Устанавливать системные пакеты, менять ACL или выдавать browser PASS в этом пакете нельзя.

**Задание Sol — M10-R2 (этот объём заменяет прежний список следующего блока выше):**

1. До реализации воспроизведи RED **полным** `tests/omp-integration-harness.test.ts` вне codex bind-ограничения, с внешним ограничением времени. Запиши команду, exit, counts и stack. Зафиксируй для сбойного чтения этап (`lstat`, opened-fstat или after-read-fstat), `nlink`, тип файла, dev/ino открытого файла и текущего пути. Подтверди окно atomic replacement; не делай вывода о symlink/hardlink только по общему коду ошибки. Временная диагностика не должна остаться в итоговом diff.
2. Добавь regression test до исправления: реальное чтение repository пересекается с его собственным атомарным `transition()`/`rename()`. Сделай окно детерминированным; проверь RED на текущем коде по ожидаемой причине, затем GREEN. Покрой оба окна fstat, если одно исправление затрагивает их оба. Ожидаемый контракт — корректный цельный snapshot либо различимый transient `OMP_RUN_CHANGED`, который существующий bounded observer может повторить; никакого повреждённого/невалидированного record и ложного `UNSAFE_PATH` для подтверждённой unlink-on-replace гонки.
3. Внеси минимальную причинную правку в `src/clients/omp/omp-run-repository.ts`; изменение harness-фикстуры допустимо вместо неё только при доказанной причине именно в фикстуре. Сохрани fail-closed проверки symlink, настоящих hard links (`nlink>1`), non-regular файлов, размера, содержимого и идентичности. Не ослабляй глобально `assertRegular`, не добавляй общий retry/подавление `OMP_RUN_UNSAFE_PATH`, skip или ослабленные assertions; не делай сопутствующий рефакторинг routing/permissions.
4. Отдельно воспроизведи RED для bind-refusal в `tests/omp-integration-harness.test.ts` и `scripts/omp-browser-stack-smoke.mjs`. Минимально добавь error-aware и bounded startup: ошибка `listen()` должна быстро отклонять ожидание, зависший startup — завершаться по конечному deadline. Убери listeners/timers и закрой только собственные ресурсы, включая частично созданные при неуспешном старте. Покажи GREEN негативных проверок для отказа bind и отсутствия callback/error; smoke должен завершаться ненулевым exit с различимой причиной, без ложного success. Production dashboard не менять ради sandbox-ограничения.
5. После исправлений выполни полный harness-файл **3 раза подряд** без выбора отдельных тестов и без retries, маскирующих падения. Затем выполни семь целевых файлов одной командой, typecheck/build, syntax checks обоих smoke и whitespace gate:

```bash
npx vitest run tests/omp-integration-harness.test.ts
npx vitest run tests/omp-integration-harness.test.ts
npx vitest run tests/omp-integration-harness.test.ts
npx vitest run tests/omp-runtime.test.ts tests/omp-launch-service.test.ts tests/omp-process-supervisor.test.ts tests/omp-integration-harness.test.ts tests/provider-dashboard-omp.test.ts tests/omp-route-readiness-preview.test.ts tests/provider-dashboard-server.test.ts
npm run typecheck
npm run build
node --check scripts/dashboard-ui-smoke.mjs
node --check scripts/omp-browser-stack-smoke.mjs
git diff --check
```

   Исходное ожидание — **7 файлов / 198 тестов**, dashboard-поднабор — **56/56**. Новые regression/error-path тесты могут увеличить итог: укажи фактическое число и объясни прибавку, не удаляй тесты ради 198. При изменении repository также выполни `npx vitest run tests/omp-run-repository.test.ts` с сохранением существующих проверок безопасности. Негативные bind/deadline проверки запускаются дополнительно, если не входят в перечисленные файлы.
6. Browser smoke оставь честным **BLOCKED: отсутствуют системные библиотеки Chrome, root недоступен**; не подменяй его syntax check или HTTP-тестами. Запиши путь Chrome и доступную диагностику missing libraries без пользовательского профиля. Это остаточный browser gate, а не разрешение на установку пакетов или внешний этап.
7. Просмотри итоговый diff на соответствие этому контракту и отсутствие новых P1/P2, debug-кода, утечек и лишнего scope. Запиши в существующий `PEER_REVIEW.md` отчёт M10-R2: причина, RED→GREEN, команды/exit/counts, три последовательных прогона harness, отдельный browser BLOCKED и остаточные ограничения. Без commit/push/PR, live-ключей/сессий/homes/transcripts, paid-запросов, Doctor, настоящего OMP, внешней сети, cutover и изменения OS-настроек. Только собственные temp fixtures, loopback и fake child. При 503/5xx — пауза и повтор; при невозможности продолжить добавь в конец `AGENT_HANDOFF.md` состояние, причину и следующий воспроизводимый шаг.

**Критерии приёмки M10-R2:** полный harness стабильно GREEN три последовательных прогона; dashboard 56/56; семь целевых файлов (база 198 плюс объяснённые новые тесты), repository security/regression tests при его изменении, typecheck/build, оба `node --check` и `git diff --check` проходят; bind-refusal и startup deadline доказанно bounded, cleanup завершён; review diff без новых P1/P2. Browser остаётся отдельно **BLOCKED** по указанным библиотекам/root, поэтому принятие исправлений M10-R2 не закрывает browser acceptance главы 5 и не открывает M11/cutover.

### M10-R2 — состояние исполнителя, 18 октября 2026: BLOCKED до реализации

Доступен только codex-sandbox: loopback bind probe завершился с exit 1 (`listen EPERM: operation not permitted 127.0.0.1`). Запуск вне sandbox и escalation недоступны (`approval_policy=never`). `timeout --signal=TERM --kill-after=5s 35s npx vitest run tests/omp-integration-harness.test.ts` завершился с exit 124, без итоговых counts/stack; лог — `/tmp/providerdock-m10-r2-tyXtmz/full-harness-red.log`. Это не воспроизведение RED гонки `OMP_RUN_UNSAFE_PATH` вне bind-ограничения. Обязательный пункт 1 до реализации не выполнен; repository, тесты и smoke не менялись. Три GREEN harness и остальные gates не засчитываются.

Browser отдельно BLOCKED: указанный Chrome executable существует, `ldd` подтверждает 13 отсутствующих библиотек; `chrome --version` даёт exit 127 на `libatk-1.0.so.0`. Root недоступен, пакеты и OS не менялись. Подробный текущий отчёт — раздел M10-R2 в `PEER_REVIEW.md`.

Следующий воспроизводимый шаг: в разрешённом исполнителе вне codex bind-ограничения повторить приведённую timeout-команду полного harness, зафиксировать counts/stack и оба fstat-окна atomic replacement (`nlink`, тип, dev/ino дескриптора и текущего пути), после чего выполнить пункты 2–7 уточнённого задания. M10-R2 не принят; гонка repository и startup error path остаются неисправленными, browser acceptance и M11/cutover не открыты.
