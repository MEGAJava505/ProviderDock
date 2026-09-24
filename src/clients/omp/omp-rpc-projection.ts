export interface OmpRpcExpectedState {
  readonly requestId: string;
  readonly providerId: string;
  readonly modelId: string;
}

export type OmpRpcControlEvent =
  | { readonly type: "ready"; readonly protocolVersion: 1 }
  | { readonly type: "state"; readonly sessionId: string; readonly providerId: string; readonly modelId: string; readonly isStreaming: boolean }
  | { readonly type: "aborted" }
  | { readonly type: "failure"; readonly code: "OMP_RPC_INVALID_FRAME" | "OMP_RPC_MODEL_MISMATCH" | "OMP_RPC_COMMAND_FAILED" };

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/**
 * Only for JSON-decoded, bounded private child-pipe frames. Pinned OMP get_state
 * includes resolved Authorization in data.model.headers: raw frames are secret
 * data, NOT browser/log payloads. Never serialize them outside that private pipe.
 * This allowlist is for lifecycle only, not a general RPC proxy.
 */
export function projectOmpRpcControlFrame(
  input: unknown, expected: OmpRpcExpectedState,
): OmpRpcControlEvent | undefined {
  const frame = object(input);
  if (!frame) return undefined;
  if (frame.type === "ready") {
    return frame.protocolVersion === 1
      ? { type: "ready", protocolVersion: 1 }
      : { type: "failure", code: "OMP_RPC_INVALID_FRAME" };
  }
  if (frame.type !== "response" || frame.id !== expected.requestId ||
    !["get_state", "abort"].includes(frame.command as string)) return undefined;
  if (frame.success !== true) return { type: "failure", code: "OMP_RPC_COMMAND_FAILED" };
  if (frame.command === "abort") return { type: "aborted" };
  const data = object(frame.data);
  const model = object(data?.model);
  if (!data || !model || typeof data.sessionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.sessionId) ||
    typeof data.isStreaming !== "boolean") return { type: "failure", code: "OMP_RPC_INVALID_FRAME" };
  if (model.id !== expected.modelId || model.provider !== expected.providerId) {
    return { type: "failure", code: "OMP_RPC_MODEL_MISMATCH" };
  }
  return {
    type: "state", sessionId: data.sessionId,
    providerId: expected.providerId, modelId: expected.modelId, isStreaming: data.isStreaming,
  };
}
