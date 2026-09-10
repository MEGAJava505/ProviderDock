import { ProviderRequestError } from "../../core/errors/provider-error.js";

type JsonRecord = Record<string, unknown>;
export type ResponsesTerminalStatus = "completed" | "failed" | "incomplete";

/** Unknown usage stays null: fabricated zeroes would look like measured free usage. */
export function normalizeOpenAiUsage(value: unknown): JsonRecord | null {
  if (!isRecord(value)) return null;
  const input = tokenCount(value.input_tokens) ?? tokenCount(value.prompt_tokens);
  const output = tokenCount(value.output_tokens) ?? tokenCount(value.completion_tokens);
  if (input === undefined || output === undefined || !Number.isSafeInteger(input + output)) {
    return null;
  }
  const inputDetails = value.input_tokens_details ?? value.prompt_tokens_details;
  const outputDetails = value.output_tokens_details ?? value.completion_tokens_details;
  return {
    ...value,
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: normalizeDetails(inputDetails, "cached_tokens"),
    output_tokens_details: normalizeDetails(outputDetails, "reasoning_tokens"),
  };
}

/** Shared by native JSON and SSE. A terminal event may supply an omitted status. */
export function normalizeResponsesResponse(
  value: unknown,
  expectedStatus?: ResponsesTerminalStatus,
): JsonRecord {
  if (!isRecord(value) || !Array.isArray(value.output)) {
    throw invalid("Terminal Responses payload requires an output array.");
  }
  const status = value.status ?? expectedStatus;
  if (!["completed", "failed", "incomplete"].includes(String(status))) {
    throw invalid("Responses payload did not reach a terminal status.");
  }
  if (expectedStatus !== undefined && status !== expectedStatus) {
    throw invalid("Responses terminal event disagrees with its response status.");
  }
  if (status === "completed") {
    if (value.error != null || value.incomplete_details != null) {
      throw invalid("Completed Responses payload contains failure details.");
    }
    if (value.output.some((item) => !isRecord(item) ||
      (item.status !== undefined && item.status !== "completed"))) {
      throw invalid("Completed Responses payload contains unfinished output items.");
    }
  }
  return {
    ...value,
    object: "response",
    status,
    error: value.error ?? null,
    incomplete_details: value.incomplete_details ?? null,
    usage: normalizeOpenAiUsage(value.usage),
  };
}

function normalizeDetails(value: unknown, requiredField: string): JsonRecord | undefined {
  if (!isRecord(value) || tokenCount(value[requiredField]) === undefined) return undefined;
  return Object.fromEntries(Object.entries(value).filter(([, count]) => tokenCount(count) !== undefined));
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : undefined;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): ProviderRequestError {
  return new ProviderRequestError("PROTOCOL_ERROR", message);
}
