// Shared SSE/HTTP fetch-mock helpers for the bridge-server suites (Anthropic,
// Responses, Chat Completions), which each previously redefined these
// byte-identical utilities. Only genuine duplicates live here; behavioural
// differences (e.g. the Responses bridge's `x-request-id` mock header) stay
// explicit at the call site via `jsonResponse`'s optional `headers` argument,
// so each test's failure location stays in its own file.
import { SseDecoder } from "../../src/index.js";

export const encoder = new TextEncoder();

/** A 200 text/event-stream response carrying a raw SSE body verbatim. */
export function sseResponse(source: string): Response {
  return new Response(source, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

/** A 200 application/json response; extra headers are merged in verbatim. */
export function jsonResponse(body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** A ReadableStream emitting `source` split at the given byte boundaries, for
 * exercising incremental SSE decoding across arbitrary network fragmentation. */
export function chunkedBody(source: string, boundaries: readonly number[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      let previous = 0;
      for (const boundary of boundaries) {
        controller.enqueue(encoder.encode(source.slice(previous, boundary)));
        previous = boundary;
      }
      controller.enqueue(encoder.encode(source.slice(previous)));
      controller.close();
    },
  });
}

/** Decode a raw SSE string into the decoder's emitted events (push + finish). */
export function decodeEvents(source: string) {
  const decoder = new SseDecoder();
  return [...decoder.push(encoder.encode(source)), ...decoder.finish()];
}
