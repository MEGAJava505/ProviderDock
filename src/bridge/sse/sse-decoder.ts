export interface SseEvent {
  readonly event?: string;
  readonly data?: string;
  readonly id?: string;
  readonly retry?: number;
  readonly comments: readonly string[];
}

export class SseDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SseDecodeError";
  }
}

/** Incremental UTF-8 SSE decoder. Network chunks are never treated as event boundaries. */
export class SseDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private eventType: string | undefined;
  private id: string | undefined;
  private retry: number | undefined;
  private readonly dataLines: string[] = [];
  private readonly comments: string[] = [];
  private hasFields = false;
  private firstLine = true;
  private eventCharacterCount = 0;

  constructor(private readonly maxEventCharacters = 16 * 1024 * 1024) {
    if (!Number.isSafeInteger(maxEventCharacters) || maxEventCharacters < 1) {
      throw new RangeError("maxEventCharacters must be a positive safe integer.");
    }
  }

  push(chunk: Uint8Array): readonly SseEvent[] {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    const events = this.drainLines(false);
    this.assertWithinLimit(this.eventCharacterCount + this.buffer.length);
    return events;
  }

  finish(): readonly SseEvent[] {
    this.buffer += this.decoder.decode();
    return this.drainLines(true);
  }

  private drainLines(flush: boolean): readonly SseEvent[] {
    const events: SseEvent[] = [];

    while (true) {
      const boundary = /\r\n|\r|\n/.exec(this.buffer);
      if (!boundary) break;
      if (!flush && boundary[0] === "\r" && boundary.index === this.buffer.length - 1) {
        break;
      }

      const line = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      this.processLine(line, events);
    }

    if (flush) {
      if (this.buffer.length > 0) {
        this.processLine(this.buffer, events);
        this.buffer = "";
      }
      this.dispatch(events);
    }

    return events;
  }

  private processLine(rawLine: string, events: SseEvent[]): void {
    const line = this.firstLine ? rawLine.replace(/^\uFEFF/, "") : rawLine;
    this.firstLine = false;

    if (line === "") {
      this.dispatch(events);
      return;
    }

    this.hasFields = true;
    this.eventCharacterCount += line.length;
    this.assertWithinLimit(this.eventCharacterCount);
    if (line.startsWith(":")) {
      this.comments.push(line.slice(1).replace(/^ /, ""));
      return;
    }

    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");

    if (field === "data") {
      this.dataLines.push(value);
    } else if (field === "event") {
      this.eventType = value;
    } else if (field === "id" && !value.includes("\0")) {
      this.id = value;
    } else if (field === "retry" && /^\d+$/.test(value)) {
      this.retry = Number(value);
    }
  }

  private dispatch(events: SseEvent[]): void {
    if (!this.hasFields) return;

    events.push({
      ...(this.eventType === undefined ? {} : { event: this.eventType }),
      ...(this.dataLines.length === 0 ? {} : { data: this.dataLines.join("\n") }),
      ...(this.id === undefined ? {} : { id: this.id }),
      ...(this.retry === undefined ? {} : { retry: this.retry }),
      comments: [...this.comments],
    });

    this.eventType = undefined;
    this.id = undefined;
    this.retry = undefined;
    this.dataLines.length = 0;
    this.comments.length = 0;
    this.hasFields = false;
    this.eventCharacterCount = 0;
  }

  private assertWithinLimit(size: number): void {
    if (size > this.maxEventCharacters) {
      throw new SseDecodeError(
        `SSE event exceeds the configured ${this.maxEventCharacters}-character limit.`,
      );
    }
  }
}

export function encodeSseEvent(event: SseEvent): string {
  const lines: string[] = [];
  for (const comment of event.comments) {
    lines.push(`:${comment ? ` ${comment}` : ""}`);
  }
  if (event.event !== undefined) lines.push(`event: ${event.event}`);
  if (event.id !== undefined) lines.push(`id: ${event.id}`);
  if (event.retry !== undefined) lines.push(`retry: ${event.retry}`);
  if (event.data !== undefined) {
    for (const line of event.data.split("\n")) lines.push(`data: ${line}`);
  }
  return `${lines.join("\n")}\n\n`;
}
