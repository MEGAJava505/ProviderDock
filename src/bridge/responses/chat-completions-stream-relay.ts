import type { ServerResponse } from "node:http";
import { SseDecodeError, SseDecoder, encodeSseEvent } from "../sse/sse-decoder.js";
import type { CanonicalRequest } from "../../protocols/canonical/canonical-protocol.js";
import {
  ChatToResponsesStreamTranslator,
  type ResponsesStreamEventRecord,
} from "../../protocols/openai-chat/chat-to-responses-stream.js";
import { ChatToResponsesTranslationError } from "../../protocols/openai-chat/chat-to-responses-response.js";

export interface RelayChatCompletionsStreamOptions {
  readonly response: ServerResponse;
  readonly body: ReadableStream<Uint8Array>;
  readonly request: CanonicalRequest;
  readonly abortUpstream: (reason: Error) => void;
  readonly heartbeatIntervalMs?: number;
  readonly idleTimeoutMs?: number;
  readonly maxEventCharacters?: number;
  readonly beforeForwardEvent?: (
    event: ResponsesStreamEventRecord,
  ) => void | Promise<void>;
}

export interface ChatCompletionsStreamRelayResult {
  readonly sawDoneMarker: boolean;
  readonly protocolFailure: boolean;
  readonly terminalEventType:
    | "response.completed"
    | "response.failed"
    | "response.incomplete"
    | undefined;
}

export async function relayChatCompletionsStream(
  options: RelayChatCompletionsStreamOptions,
): Promise<ChatCompletionsStreamRelayResult> {
  const translator = new ChatToResponsesStreamTranslator({ request: options.request });
  const decoder = new SseDecoder(options.maxEventCharacters);
  const reader = options.body.getReader();
  const seenEventIds = new Map<string, string>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 15_000;
  const idleTimeoutMs = options.idleTimeoutMs ?? 1_800_000;
  let sawDoneMarker = false;
  let protocolFailure = false;
  let clientClosed = false;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;

  const resetIdleTimer = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    if (idleTimeoutMs <= 0) return;
    idleTimer = setTimeout(() => {
      options.abortUpstream(new Error("Upstream Chat stream exceeded its idle timeout."));
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
          const outcome = await processChatEvent(
            event,
            translator,
            options.response,
            seenEventIds,
            options.beforeForwardEvent,
          );
          if (outcome === "done") {
            sawDoneMarker = true;
            finished = true;
            break;
          }
        }
        break;
      }
      resetIdleTimer();
      for (const event of decoder.push(chunk.value)) {
        const outcome = await processChatEvent(
          event,
          translator,
          options.response,
          seenEventIds,
          options.beforeForwardEvent,
        );
        if (outcome === "done") {
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
      error instanceof SseDecodeError || error instanceof ChatToResponsesTranslationError;
    if (!clientClosed) await reader.cancel().catch(() => undefined);
  } finally {
    stopHeartbeat();
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    reader.releaseLock();
  }

  if (clientClosed || options.response.destroyed || options.response.writableEnded) {
    return {
      sawDoneMarker,
      protocolFailure,
      terminalEventType: translator.terminalEventType,
    };
  }
  const terminalEvents = protocolFailure
    ? translator.fail("Upstream sent a malformed or conflicting Chat stream event.")
    : translator.finish();
  await writeTranslatedEvents(
    options.response,
    terminalEvents,
    options.beforeForwardEvent,
  );
  if (sawDoneMarker) {
    await writeResponseChunk(
      options.response,
      encodeSseEvent({ data: "[DONE]", comments: [] }),
    );
  }
  return {
    sawDoneMarker,
    protocolFailure,
    terminalEventType: translator.terminalEventType,
  };
}

export async function writeTranslatedEvents(
  response: ServerResponse,
  events: readonly ResponsesStreamEventRecord[],
  beforeForwardEvent?: (
    event: ResponsesStreamEventRecord,
  ) => void | Promise<void>,
): Promise<void> {
  for (const event of events) {
    await beforeForwardEvent?.(event);
    await writeResponseChunk(
      response,
      encodeSseEvent({
        event: typeof event.type === "string" ? event.type : "response.failed",
        data: JSON.stringify(event),
        comments: [],
      }),
    );
  }
}

async function processChatEvent(
  event: { readonly data?: string; readonly id?: string; readonly comments: readonly string[] },
  translator: ChatToResponsesStreamTranslator,
  response: ServerResponse,
  seenEventIds: Map<string, string>,
  beforeForwardEvent?: (
    event: ResponsesStreamEventRecord,
  ) => void | Promise<void>,
): Promise<"continue" | "done"> {
  if (event.data === "[DONE]") return "done";
  if (event.data === undefined) {
    if (event.comments.length > 0) {
      await writeResponseChunk(response, encodeSseEvent({ comments: event.comments }));
    }
    return "continue";
  }
  if (event.id !== undefined && event.id !== "") {
    const previous = seenEventIds.get(event.id);
    if (previous !== undefined) {
      if (previous === event.data) return "continue";
      throw new ChatToResponsesTranslationError(
        "PROTOCOL_ERROR",
        `Conflicting Chat SSE events used id '${event.id}'.`,
      );
    }
    seenEventIds.set(event.id, event.data);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(event.data);
  } catch (error) {
    throw new ChatToResponsesTranslationError(
      "PROTOCOL_ERROR",
      "Upstream Chat SSE data was not valid JSON.",
      { cause: error },
    );
  }
  await writeTranslatedEvents(response, translator.feed(payload), beforeForwardEvent);
  return "continue";
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
      reject(new Error("Bridge client connection closed during Chat translation."));
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
