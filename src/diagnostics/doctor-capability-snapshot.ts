import type { NormalizedErrorType } from "../core/errors/provider-error.js";
import type {
  ModelCapabilityName,
  ModelCapabilitySnapshot,
} from "../core/health/provider-health-repository.js";
import type {
  CapabilityStatus,
  ClientCompatibilityStatus,
} from "../core/providers/model-catalog.js";
import type {
  DoctorCheck,
  DoctorProtocol,
  DoctorReport,
} from "./provider-doctor.js";

const capabilityCheckNames: Readonly<
  Partial<Record<DoctorCheck["name"], ModelCapabilityName>>
> = {
  "connectivity+models": "model_discovery",
  inference: "text",
  streaming: "streaming",
  tools: "tools",
};

const conclusiveCapabilityErrors = new Set<NormalizedErrorType>([
  "MODEL_NOT_FOUND",
  "INVALID_REQUEST",
  "UNSUPPORTED_FEATURE",
  "PROTOCOL_ERROR",
  "STREAM_ERROR",
  "INCOMPLETE_RESPONSE",
]);

/**
 * Converts one manually-run Doctor report into the latest non-secret
 * per-model capability snapshot. Reports without a resolved model cannot be
 * attached to the model matrix and are intentionally not persisted there.
 */
export function doctorReportToCapabilitySnapshot(
  report: DoctorReport,
): ModelCapabilitySnapshot | undefined {
  if (report.modelId === undefined) return undefined;

  const capabilities = unknownCapabilities();
  for (const check of report.checks) {
    const capability = capabilityCheckNames[check.name];
    if (capability === undefined) continue;
    capabilities[capability] = capabilityStatusOf(check);
  }

  const compatibility = compatibilityFor(report.protocol);
  const finalError = [...report.checks]
    .reverse()
    .find(
      (
        check,
      ): check is DoctorCheck & {
        readonly errorType: NormalizedErrorType;
      } => check.status === "FAIL" && check.errorType !== undefined,
    );

  return {
    providerId: report.providerId,
    modelId: report.modelId,
    checkedAt: report.checkedAt,
    doctorLevel: report.level,
    verdict: report.verdict,
    ...(report.protocol === undefined ? {} : { protocol: report.protocol }),
    capabilities,
    codexCompatibility: compatibility.codex,
    claudeCompatibility: compatibility.claude,
    ...(finalError === undefined
      ? {}
      : {
          lastErrorType: finalError.errorType,
          ...(finalError.details === undefined
            ? {}
            : { lastErrorMessage: finalError.details }),
        }),
  };
}

function unknownCapabilities(): Record<ModelCapabilityName, CapabilityStatus> {
  return {
    text: "UNKNOWN",
    streaming: "UNKNOWN",
    tools: "UNKNOWN",
    parallel_tools: "UNKNOWN",
    reasoning: "UNKNOWN",
    images: "UNKNOWN",
    web_search: "UNKNOWN",
    long_context: "UNKNOWN",
    usage: "UNKNOWN",
    cancellation: "UNKNOWN",
    model_discovery: "UNKNOWN",
  };
}

function capabilityStatusOf(check: DoctorCheck): CapabilityStatus {
  if (check.status === "PASS") return "SUPPORTED";
  if (check.status === "DEGRADED") return "DEGRADED";
  if (check.status === "SKIPPED") return "UNKNOWN";
  if (
    check.errorType === undefined ||
    conclusiveCapabilityErrors.has(check.errorType)
  ) {
    return "UNSUPPORTED";
  }
  return "UNKNOWN";
}

function compatibilityFor(
  protocol: DoctorProtocol | undefined,
): {
  readonly codex: ClientCompatibilityStatus;
  readonly claude: ClientCompatibilityStatus;
} {
  switch (protocol) {
    case "openai-responses":
      return { codex: "NATIVE", claude: "INCOMPATIBLE" };
    case "openai-chat-completions":
      return { codex: "ADAPTER", claude: "ADAPTER" };
    case "anthropic-messages":
      return { codex: "INCOMPATIBLE", claude: "NATIVE" };
    case undefined:
      return { codex: "UNKNOWN", claude: "UNKNOWN" };
  }
}
