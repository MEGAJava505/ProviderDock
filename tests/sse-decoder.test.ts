import { describe, expect, it } from "vitest";
import { SseDecodeError, SseDecoder, encodeSseEvent } from "../src/index.js";

const encoder = new TextEncoder();

describe("SseDecoder", () => {
  it("decodes several events and multiline data independently of network chunks", () => {
    const decoder = new SseDecoder();
    const first = decoder.push(encoder.encode("event: update\r"));
    const second = decoder.push(
      encoder.encode("\ndata: first\r\ndata: second\r\nid: evt-1\r\nretry: 250\r\n\r\n"),
    );
    const third = decoder.push(encoder.encode(": keepalive\n\ndata: final\n\n"));

    expect(first).toEqual([]);
    expect(second).toEqual([
      {
        event: "update",
        data: "first\nsecond",
        id: "evt-1",
        retry: 250,
        comments: [],
      },
    ]);
    expect(third).toEqual([
      { comments: ["keepalive"] },
      { data: "final", comments: [] },
    ]);
  });

  it("preserves split multibyte UTF-8 and flushes a final unterminated event", () => {
    const bytes = encoder.encode("data: Привет 🌍");
    const decoder = new SseDecoder();
    const split = bytes.length - 2;

    expect(decoder.push(bytes.slice(0, split))).toEqual([]);
    expect(decoder.push(bytes.slice(split))).toEqual([]);
    expect(decoder.finish()).toEqual([{ data: "Привет 🌍", comments: [] }]);
  });

  it("encodes comments, metadata and multiline data with valid framing", () => {
    expect(
      encodeSseEvent({
        event: "response.delta",
        id: "42",
        retry: 1000,
        data: "one\ntwo",
        comments: ["heartbeat"],
      }),
    ).toBe(
      ": heartbeat\nevent: response.delta\nid: 42\nretry: 1000\ndata: one\ndata: two\n\n",
    );
  });

  it("rejects an event that exceeds its configured bound", () => {
    const decoder = new SseDecoder(8);
    expect(() => decoder.push(encoder.encode("data: too-long"))).toThrow(SseDecodeError);
  });

  it("applies the bound per event rather than per network chunk", () => {
    const decoder = new SseDecoder(8);
    expect(decoder.push(encoder.encode("data: a\n\ndata: b\n\ndata: c\n\n"))).toHaveLength(3);
  });
});
