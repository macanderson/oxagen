/**
 * The Server-Sent Events decoder under `GET /v1/turns/{id}/events`.
 *
 * Written against the WHATWG event-stream grammar rather than against what
 * `stella-serve` emits today, because the two differ in what they promise. The
 * server writes `id: <seq>\n` + `data: <json>\n\n` with LF line ends and no
 * comments. The grammar also allows CRLF and bare CR, several `data:` lines
 * per record, `:` comment lines, and a final record with no trailing blank
 * line. A decoder that only read today's shape would break on the first proxy
 * that re-chunks or re-terminates lines, and the difference would surface as a
 * "hang" on a turn rather than as a parse error.
 */

import type { StellaSseFrame } from "./wire";

/** One event-stream record, after field parsing and before JSON decoding. */
export interface SseRecord {
  /** The record's last `id:` field, or `undefined` when it carried none. */
  id?: string;
  /** The record's last `event:` field, or `undefined` when it carried none. */
  event?: string;
  /** Every `data:` line, joined with `\n`. */
  data: string;
}

/**
 * Incremental record decoder. Feed it text as it arrives; it returns each
 * record as soon as the blank line that ends it has been seen, and `flush()`
 * returns the record a stream ended in the middle of.
 */
export class SseDecoder {
  private buffer = "";
  private fields = new RecordFields();

  /** Consume a chunk of the stream and return every record it completed. */
  push(chunk: string): SseRecord[] {
    this.buffer += chunk;
    const out: SseRecord[] = [];
    for (;;) {
      const line = this.takeLine(false);
      if (line === undefined) break;
      const record = this.fields.line(line);
      if (record) out.push(record);
    }
    return out;
  }

  /**
   * End the stream: whatever is buffered is one last line, and the record it
   * belongs to is returned even though no blank line closed it.
   */
  flush(): SseRecord | undefined {
    let pending: SseRecord | undefined;
    for (;;) {
      const line = this.takeLine(true);
      if (line === undefined) break;
      const record = this.fields.line(line);
      if (record) pending = record;
    }
    const tail = this.fields.close();
    return tail ?? pending;
  }

  /**
   * Remove and return the next complete line from the buffer, or `undefined`
   * when none has ended yet.
   *
   * A line ends at CRLF, LF, or a bare CR. A CR that is the very last byte of
   * the buffer is ambiguous until the next chunk arrives, because an LF may
   * follow it and belong to the same line end; it is left in place unless
   * `final` says nothing more is coming.
   */
  private takeLine(final: boolean): string | undefined {
    const buffer = this.buffer;
    if (buffer.length === 0) return undefined;
    let end = -1;
    let width = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      const ch = buffer.charCodeAt(i);
      if (ch === 0x0a) {
        end = i;
        width = 1;
        break;
      }
      if (ch === 0x0d) {
        if (i + 1 < buffer.length) {
          end = i;
          width = buffer.charCodeAt(i + 1) === 0x0a ? 2 : 1;
          break;
        }
        if (final) {
          end = i;
          width = 1;
          break;
        }
        return undefined;
      }
    }
    if (end === -1) {
      if (!final) return undefined;
      this.buffer = "";
      return buffer;
    }
    this.buffer = buffer.slice(end + width);
    return buffer.slice(0, end);
  }
}

/**
 * The field accumulator for one record. Separate from the line splitter so
 * each half is a plain function of its input and can be read on its own.
 */
class RecordFields {
  private data: string[] = [];
  private id: string | undefined;
  private event: string | undefined;

  /** Apply one line; returns the record when the line was the blank ender. */
  line(line: string): SseRecord | undefined {
    if (line.length === 0) return this.close();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "id":
        // The grammar reserves NUL to mean "no id"; nothing else is refused.
        if (!value.includes("\0")) this.id = value;
        break;
      case "event":
        this.event = value;
        break;
      default:
        // `retry:` and unknown fields carry nothing this client acts on.
        break;
    }
    return undefined;
  }

  /**
   * Finish the record in progress. A record with no `data:` line is dropped,
   * which is what the grammar says to do with it, so an `id:`-only record
   * never surfaces as a frame.
   */
  close(): SseRecord | undefined {
    if (this.data.length === 0) {
      this.id = undefined;
      this.event = undefined;
      return undefined;
    }
    const record: SseRecord = { data: this.data.join("\n") };
    if (this.id !== undefined) record.id = this.id;
    if (this.event !== undefined) record.event = this.event;
    this.data = [];
    this.id = undefined;
    this.event = undefined;
    return record;
  }
}

/** Decode a byte stream into records, releasing the body when iteration stops. */
export async function* decodeSseStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseRecord, void, undefined> {
  const reader = body.getReader();
  const decoder = new SseDecoder();
  const text = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const record of decoder.push(text.decode(value, { stream: true }))) {
        yield record;
      }
    }
    const rest = decoder.push(text.decode());
    for (const record of rest) yield record;
    const tail = decoder.flush();
    if (tail) yield tail;
  } finally {
    // Cancel rather than only release: a consumer that returns early would
    // otherwise leave the socket open until the server times it out.
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Decode one record's `data` into a frame.
 *
 * `seq` is read from the JSON, which is where the server puts it. The `id:`
 * line carries the same number and is used only when the JSON has none, so a
 * frame from a transport that stripped the body's `seq` still resumes
 * correctly. `replay_truncated` has neither and is left without one.
 */
export function recordToFrame(record: SseRecord): StellaSseFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(record.data);
  } catch (cause) {
    const preview =
      record.data.length > 200 ? `${record.data.slice(0, 200)}…` : record.data;
    throw new Error(
      `event stream carried a record that is not JSON: ${preview}`,
      { cause },
    );
  }
  if (typeof parsed !== "object" || parsed === null || !("type" in parsed)) {
    throw new Error(
      `event stream carried a record with no "type": ${record.data.slice(0, 200)}`,
    );
  }
  const frame = parsed as { type: string; seq?: unknown };
  if (
    frame.type !== "replay_truncated" &&
    typeof frame.seq !== "number" &&
    record.id !== undefined &&
    /^\d+$/.test(record.id)
  ) {
    frame.seq = Number(record.id);
  }
  return frame as StellaSseFrame;
}

/** The seq a frame carries, or `undefined` for one that has none. */
export function frameSeq(frame: StellaSseFrame): number | undefined {
  return "seq" in frame && typeof frame.seq === "number"
    ? frame.seq
    : undefined;
}
