# OMP Step 4 — цепочка происхождения v2 (read-only, без сети)

Дата проверки: **2026-09-24**. Проверка только на чтение; сетевых запросов к
VSLLM или иным провайдерам не было; plaintext-секреты, cookie, полные
HTTP-ответы и пользовательские transcript в отчёт не попадают.

Проверяемый v2-кандидат: `vsllm / 16568 / gpt-5.4-mini / openai-responses`.
Файлы кандидата лежат в игнорируемой Git зоне
`.provider-dock/omp-mapping-2026-09-16-ExxykD/`; живые
`~/.provider-switcher/migration/*.json` остаются v1 и здесь не менялись.

## Что делает gate

`evaluateOmpRouteDecisionForPilot`
([src/migration/omp-route-decisions.ts:206](../src/migration/omp-route-decisions.ts#L206),
вызов из [src/application/omp-launch-service.ts:149](../src/application/omp-launch-service.ts#L149))
принимает пилот только если одновременно совпадают три группы полей:

1. **evidence-match** — decision совпадает с local-smoke evidence
   (`matchesLocalSmokeEvidence`).
2. **doctorSnapshot** — снимок из health-записи (`healthRecords.get(providerId)`,
   отфильтрован по `modelId`), НЕ свежий Doctor: `providerId`, `modelId`,
   `protocol`, `doctorLevel===3`, `verdict==="PASS"`,
   `checkedAt===decision.realPilot.checkedAt`,
   `configurationFingerprint===providerConfigurationFingerprint(profile)`,
   `credentialFingerprint===currentCredentialFingerprint` (вычисляется вживую при
   запуске), `capabilities.{text,streaming,tools}==="SUPPORTED"`,
   `fingerprintOmpDoctorSnapshot(doctor)===decision.realPilot.doctorSnapshotSha256`.
3. **selection/profile/artifact** — `providerId/accountId/modelId` из выбора,
   `profileSha256`, `baseUrl`, `origin`, модель входит в `knownModels` и не
   отключена, `apiType` совместим с `protocol`,
   `localSmoke.executableSha256===artifact.sha256`,
   `localSmoke.sourceCommit===artifact.sourceCommit`. Затем `compileOmpConfig`
   с закреплённым commit.

## Таблица: утверждение → файл/вычисление → результат → срок годности

| Утверждение | Файл / вычисление | Результат | Срок годности |
|---|---|---|---|
| SHA-256 бинарника `omp.exe` | `certutil -hashfile .provider-dock/tools/omp-0c6c981ee583/omp.exe` | `1944c6e2…d4ba` | **Подтверждено сейчас** (пересчитано 2026-09-24) |
| `artifact.json.sha256` = хеш бинарника | `.provider-dock/tools/omp-0c6c981ee583/artifact.json` | `1944c6e2…d4ba` — совпадает | Подтверждено сейчас |
| `artifact.json.sourceCommit` | тот же файл | `0c6c981e…637c` | Подтверждено сейчас (значение прочитано) |
| upstream checkout HEAD = pin | `git -C .scratch/omp rev-parse HEAD` | `0c6c981e…637c` — совпадает | Подтверждено сейчас |
| pin компилятора | `src/clients/omp/omp-config-compiler.ts:10` `ompConfigSchemaCommit` | `0c6c981e…637c` — совпадает | Подтверждено сейчас |
| `decision.localSmoke.executableSha256` = artifact.sha256 | `route-decision-2026-09-24-gpt54mini.json` + сравнение | `1944c6e2…d4ba` — совпадает | Подтверждено сейчас |
| `decision.localSmoke.sourceCommit` = artifact.sourceCommit | тот же файл + сравнение | `0c6c981e…637c` — совпадает | Подтверждено сейчас |
| SHA-256 inventory v2 = `decision.localSmoke.inventorySha256` | `certutil` по `inventory-2026-09-24-vsllm-gpt54mini.json` | `b89fa56d…4fc3` — совпадает | Подтверждено сейчас (пересчитано) |
| SHA-256 smoke-report = `decision.localSmoke.smokeReportSha256` | `certutil` по `F:/ProviderDockBuild/omp-0c6c981ee583/provider-local-smoke-5dgCO0/report.json` | `fe5ccd0c…8b4b` — совпадает | Подтверждено сейчас (пересчитано) |
| decision: providerId/accountId/model/protocol/baseUrl/origin | `route-decision-2026-09-24-gpt54mini.json` | `vsllm / 16568 / gpt-5.4-mini / openai-responses / https://vsllm.cc/v1 / https://vsllm.cc` | Подтверждено сейчас (значения прочитаны) |
| `decision.profileSha256` (fingerprint профиля) | тот же файл | `ec3b9a9b…2185` — записан в decision | **Проверяется только при запуске** против живого профиля; здесь не пересчитан (требует чтения профиля) |
| evidence v2 `launchAuthorized` | `omp-provider-evidence-2026-09-24-gpt54mini.json` | `false` | Подтверждено сейчас |
| smoke — характер | `report.json` `purpose` | `loopback-wire-shape-only-not-real-provider-acceptance`, 20 passed / 9 skip (`REAL_PILOT_NOT_APPROVED`) | Подтверждено сейчас — **не реальный OMP-пилот** |
| `realPilot.status: passed`, `doctorLevel 3`, `verdict PASS` | `route-decision…json` `realPilot`, `checkedAt 2026-09-23T14:31:29.206Z`, `doctorSnapshotSha256 16bbb658…3ca7d` | Записано в decision | **Зависит от старого Doctor snapshot (2026-09-23)** — НЕ переисполнено; свежесть не заявляется |
| `doctorSnapshot.checkedAt/verdict/fingerprints` | health-запись, `omp-launch-service.ts:146-147` | — | **Проверяется только при запуске**: снимок хранимый, не свежий; wall-clock давность gate не проверяет |
| `currentCredentialFingerprint` = `doctor.credentialFingerprint` | `omp-launch-service.ts:148`, вживую | — | **Проверяется только при запуске**; здесь не вычислялось (требует чтения credential) |

## Разделение «подтверждено сейчас» vs «зависит от старого Doctor»

- **Подтверждено сейчас (пересчитано read-only 2026-09-24):** вся хеш-цепочка
  бинарника, source-commit по трём независимым источникам (artifact.json,
  `.scratch/omp` HEAD, pin компилятора), inventory- и smoke-report-хеши,
  тождество этих хешей полям `decision.localSmoke`, значения
  provider/account/model/protocol/origin, `launchAuthorized:false`, loopback-only
  характер smoke.
- **Зависит от старого Doctor snapshot:** `realPilot.status:passed` /
  `verdict PASS` / `doctorLevel 3` датированы **2026-09-23T14:31:29Z** и
  представляют хранимый снимок, а не свежую проверку. Gate не проверяет
  wall-clock давность снимка; при ротации credential или изменении профиля он
  честно fail-closed (несовпадение `credentialFingerprint`/`profileSha256`), но
  сам по себе PASS не переисполняется. **Свежим его не считать.**
- **Проверяется только при запуске (здесь не вычислялось):** `profileSha256`
  против живого профиля и `credentialFingerprint` против живого credential —
  оба требуют чтения пользовательских данных, что вне разрешённой границы этого
  этапа.

## Вывод этапа

Несоответствий в статических артефактах v2 не найдено: каждая связка hash/commit
либо пересчитана сейчас, либо явно помечена «зависит от старого Doctor» /
«проверяется только при запуске». Gate остаётся корректно fail-closed:
`launchAuthorized:false`, PASS опирается на снимок 2026-09-23 и на живые
fingerprint-проверки при запуске. **Блокеров для честности отчёта нет; для
реального пилота по-прежнему требуются отдельный свежий платный Doctor и явное
решение пользователя** — этот этап их не заменяет.
