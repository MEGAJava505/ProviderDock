import type { ServerResponse } from "node:http";
import { SseDecodeError, SseDecoder, encodeSseEvent, type SseEvent } from "../sse/sse-decoder.js";
import {
  ResponsesStreamProtocolError,
  ResponsesStreamState,
  isJsonRecord,
  type JsonRecord,
} from "./responses-stream-state.js";

export interface RelayResponsesStreamOptions {
  readonly response: ServerResponse;
  readonly body: ReadableStream<Uint8Array>;
  readonly abortUpstream: (reason: Error) => void;
  readonly heartbeatIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxEventCharacters?: number;
}

export interface ResponsesStreamRelayResult {
  readonly repairedTerminal: boolean;
  readonly sawDoneMarker: boolean;
  readonly protocolFailure: boolean;
}

export async function relayResponsesStream(
  options: RelayResponsesStreamOptions,
): Promise<ResponsesStreamRelayResult> {
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 1_800_000;
  const decoder = new SseDecoder(options.maxEventCharacters);
  const state = new ResponsesStreamState();
  const reader = options.body.getReader();
  let sawDoneMarker = false;
  let protocolFailure = false;
  let clientClosed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const resetIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      options.abortUpstream(new Error("Upstream Responses stream exceeded its idle timeout."));
    }, idleTimeoutMs);
    idleTimer.unref?.();
  };
  const stopHeartbeat = startHeartbeat(options.response, heartbeatIntervalMs);
  resetIdleTimer();

  try {
    let finished = false;
    while (!finished) {
      const chunk = await reader.read();
      if (chunk.done) {
        for (const event of decoder.finish()) {
          if (await processEvent(event, state, options.response)) {
            sawDoneMarker = true;
            finished = true;
            break;
          }
        }
        break;
      }

      resetIdleTimer();
      for (const event of decoder.push(chunk.value)) {
        if (await processEvent(event, state, options.response)) {
          sawDoneMarker = true;
          finished = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
      }
    }
  } catch (error) {
    clientClosed = options.response.destroyed || options.response.writableEnded;
    protocolFailure =
      error instanceof SseDecodeError || error instanceof ResponsesStreamProtocolError;
    if (!clientClosed) {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    stopHeartbeat();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (clientClosed || options.response.destroyed || options.response.writableEnded) {
    return { repairedTerminal: false, sawDoneMarker, protocolFailure };
  }

  const repair = state.buildTerminalRepair({
    forceFailure: protocolFailure,
    message: protocolFailure
      ? "Upstream sent a malformed or conflicting Responses stream event."
      : "Upstream stream ended before a terminal Responses event was received.",
  });
  if (repair !== undefined) {
    await writeJsonEvent(options.response, repair);
  }
  if (sawDoneMarker) {
    await writeResponseChunk(
      options.response,
      encodeSseEvent({ data: "[DONE]", comments: [] }),
    );
  }

  return {
    repairedTerminal: repair !== undefined,
    sawDoneMarker,
    protocolFailure,
  };
}

async function processEvent(
  event: SseEvent,
  state: ResponsesStreamState,
  response: ServerResponse,
): Promise<boolean> {
  if (event.data === "[DONE]") return true;

  if (event.data === undefined) {
    await writeResponseChunk(response, encodeSseEvent(event));
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(event.data);
  } catch (error) {
    throw new ResponsesStreamProtocolError("Upstream SSE data was not valid JSON.", {
      cause: error,
    });
  }
  if (!isJsonRecord(parsed) || typeof parsed.type !== "string") {
    throw new ResponsesStreamProtocolError(
      "Upstream SSE data was not a typed Responses event object.",
    );
  }

  const observation = state.observe(parsed, event.id);
  if (observation.kind !== "forward") return false;

  await writeResponseChunk(
    response,
    encodeSseEvent({
      event: observation.event.type as string,
      data: JSON.stringify(observation.event),
      ...(event.id === undefined ? {} : { id: event.id }),
      ...(event.retry === undefined ? {} : { retry: event.retry }),
      comments: event.comments,
    }),
  );
  return false;
}

async function writeJsonEvent(response: ServerResponse, event: JsonRecord): Promise<void> {
  await writeResponseChunk(
    response,
    encodeSseEvent({
      event: typeof event.type === "string" ? event.type : "response.failed",
      data: JSON.stringify(event),
      comments: [],
    }),
  );
}

async function writeResponseChunk(response: ServerResponse, value: string): Promise<void> {
  if (response.destroyed || response.writableEnded) {
    throw new Error("Bridge client connection is closed.");
  }
  if (response.write(value)) return;

  await new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onError);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    const onClose = (): void => {
      cleanup();
      reject(new Error("Bridge client connection closed during streaming."));
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onError);
  });
}

function startHeartbeat(response: ServerResponse, intervalMs: number): () => void {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return () => undefined;

  const timer = setInterval(() => {
    if (!response.destroyed && !response.writableEnded) {
      response.write(encodeSseEvent({ comments: ["providerdock-keepalive"] }));
    }
  }, intervalMs);
  timer.unref?.();

  return () => clearInterval(timer);
}
