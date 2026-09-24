import { randomUUID } from "node:crypto";
import { normalizedErrorTypes, providerErrorGuidance } from "./provider-error.js";

export type OperationStage =
  | "storage" | "validation" | "credentials" | "process-spawn"
  | "agent-init" | "upstream" | "stream" | "tool" | "shutdown";

export interface OperationDiagnostic {
  readonly operationId: string;
  readonly stage: OperationStage;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly suggestedAction: string;
  readonly occurredAt: string;
  readonly httpStatus?: number;
  readonly exitCode?: number;
}

export interface OperationDiagnosticInput {
  readonly operationId?: string;
  readonly stage: OperationStage;
  readonly code: string;
  readonly retryable?: boolean;
  readonly occurredAt?: string;
  readonly httpStatus?: number;
  readonly exitCode?: number;
}

// Intentionally content-free: callers supply classification, never error text,
// argv, environment, paths, provider payloads, or stacks. Unknown codes fail closed.
const guidance: Record<string, readonly [string, string]> = {
  ...Object.fromEntries(normalizedErrorTypes.map(code => {
    const item = providerErrorGuidance(code);
    return [code, [item.explanation, item.suggestedAction]];
  })),
  MODEL_DISABLED: ["Модель отключена в настройках.", "Включите модель или выберите другую."],
  MODEL_NOT_AVAILABLE: ["Модель недоступна у выбранного провайдера.", "Обновите каталог и выберите доступную модель."],
  EXECUTABLE_NOT_FOUND: ["Исполняемый файл агента не найден.", "Проверьте установку агента и путь к исполняемому файлу."],
  EXECUTABLE_UNAVAILABLE: ["Исполняемый файл агента недоступен.", "Проверьте права доступа и управляемую установку агента."],
  OMP_ARTIFACT_MISMATCH: ["Сборка OMP не соответствует закреплённому артефакту.", "Восстановите проверенную сборку OMP; не обходите проверку контрольной суммы."],
  OMP_CONFIG_INVALID: ["Выбранный маршрут или конфигурация OMP не поддерживается.", "Проверьте модель, протокол, адрес и способ авторизации выбранного маршрута."],
  OMP_ROUTE_NOT_ACCEPTED: ["Маршрут ещё не принят для пилотного запуска OMP.", "Подтвердите текущий fingerprint, аккаунт, origin, модель, протокол и локальное smoke-свидетельство."],
  OMP_MIGRATION_EVIDENCE_V2_REQUIRED: ["Сохранённые свидетельства OMP имеют старую версию.", "Пересоздайте проверенные evidence и route-decision версии 2; старые файлы сохраните как архив."],
  OMP_PROJECT_SETTINGS_UNREVIEWED: ["В проекте есть ещё не проверенные настройки агента.", "Для пилота используйте отдельный проект без настроек агента либо сначала выполните их явный импорт. Оригинальные настройки не удаляйте."],
  PROTOCOL_UNRESOLVED: ["Протокол модели не подтверждён.", "Явно выберите протокол для этого провайдера, аккаунта и модели."],
  OMP_PERMISSION_CONFIRMATION_REQUIRED: ["Права OMP ещё не подтверждены.", "Для пилота подтвердите: только инструмент чтения, без OS-песочницы; чтение вне проекта не заблокировано."],
  OMP_RUNTIME_DIRECTORY_UNAVAILABLE: ["Управляемый каталог OMP недоступен или уже занят.", "Проверьте каталог и создайте новый запуск. Не удаляйте существующую историю."],
  OMP_SPAWN_FAILED: ["Не удалось запустить процесс OMP.", "Проверьте управляемый исполняемый файл OMP и повторите запуск."],
  OMP_INITIALIZATION_TIMEOUT: ["OMP не подтвердил готовность за отведённое время.", "Проверьте закреплённую сборку и конфигурацию OMP, затем повторите запуск."],
  OMP_RPC_PROTOCOL_ERROR: ["OMP вернул недопустимый управляющий ответ.", "Проверьте закреплённую сборку OMP и маршрут; сырые RPC-данные не сохраняются."],
  OMP_SUPERVISOR_OWNERSHIP_LOST: ["Контроль над запуском потерян после перезапуска дашборда.", "Проверьте окно OMP и состояние задачи перед повторным запуском."],
  PROJECT_DIRECTORY_UNAVAILABLE: ["Каталог проекта недоступен.", "Выберите существующий локальный каталог проекта без перенаправляющих ссылок."],
  CREDENTIAL_MISSING: ["Ключ выбранного маршрута отсутствует.", "Выберите сохранённый ключ для этого аккаунта; другие ключи автоматически не подставляются."],
  CREDENTIAL_INVALID: ["Формат ключа выбранного маршрута не поддерживается.", "Проверьте тип авторизации; OAuth нельзя переносить как обычный API-ключ."],
  CREDENTIAL_UNAVAILABLE: ["Ключ не удалось прочитать из защищённого хранилища.", "Проверьте доступ к DPAPI под исходной учётной записью Windows."],
  PROCESS_EXIT_NONZERO: ["Агент завершился с ошибкой.", "Проверьте установку и конфигурацию агента; не повторяйте задачу автоматически."],
  PROCESS_EXIT_UNKNOWN: ["Результат завершения агента неизвестен.", "Проверьте состояние процесса и задачи перед повторным запуском."],
  PROCESS_SIGNALLED: ["Процесс агента остановлен сигналом.", "Проверьте, почему процесс был остановлен, и состояние задачи перед повтором."],
  OPERATION_CANCELLED: ["Операция отменена.", "Проверьте частичные результаты перед новым запуском."],
  PORTAL_STORAGE_CORRUPT: ["Хранилище кабинетов повреждено; связи аккаунтов неизвестны.", "Восстановите хранилище из проверенной резервной копии. Не удаляйте ключи до восстановления."],
  VAULT_UNAVAILABLE: ["Защищённое хранилище ключей недоступно.", "Проверьте доступ к хранилищу Windows под исходной учётной записью; не заменяйте ключи вслепую."],
  CREDENTIAL_REGISTRY_UNAVAILABLE: ["Реестр управляемых ключей недоступен.", "Восстановите реестр ключей; до этого не изменяйте секреты через общий редактор."],
  OPERATION_FAILED: ["Операция не выполнена.", "Проверьте настройки и состояние операции перед повтором."],
};
const stages: readonly string[] = [
  "storage", "validation", "credentials", "process-spawn", "agent-init",
  "upstream", "stream", "tool", "shutdown",
];

/** Shared creation contract for dashboard and future supervisors. No persistence. */
export function createOperationDiagnostic(input: OperationDiagnosticInput): OperationDiagnostic {
  return sanitizeOperationDiagnostic(input);
}

/** Safe projection at an untrusted read boundary; ignores all free-form text. */
export function sanitizeOperationDiagnostic(input: unknown): OperationDiagnostic {
  const value = input !== null && typeof input === "object"
    ? input as Record<string, unknown> : {};
  const code = typeof value.code === "string" && Object.hasOwn(guidance, value.code)
    ? value.code : "OPERATION_FAILED";
  const [message, suggestedAction] = guidance[code]!;
  return {
    operationId: typeof value.operationId === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.operationId)
      ? value.operationId : randomUUID(),
    stage: stages.includes(value.stage as string) ? value.stage as OperationStage : "validation",
    code,
    message,
    retryable: code !== "OPERATION_FAILED" && code !== "UNKNOWN" && value.retryable === true,
    suggestedAction,
    occurredAt: typeof value.occurredAt === "string" &&
      /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.occurredAt) &&
      Number.isFinite(Date.parse(value.occurredAt))
      ? value.occurredAt : new Date().toISOString(),
    ...(typeof value.httpStatus === "number" && Number.isInteger(value.httpStatus) &&
      value.httpStatus >= 100 && value.httpStatus <= 599 ? { httpStatus: value.httpStatus } : {}),
    ...(typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode) &&
      Math.abs(value.exitCode) <= 0xffffffff ? { exitCode: value.exitCode } : {}),
  };
}
