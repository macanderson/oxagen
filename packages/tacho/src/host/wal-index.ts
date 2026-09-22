/**
 * Byte offsets into a session's body file, so shipping a batch reads the
 * batch's bodies and not the session's history.
 *
 * `Wal.bodiesFor` used to answer a batch by scanning `<session>.bodies.jsonl`
 * from the top. A session with 16,000 model bodies holds about 7 GB, and the
 * shipper asks for 200 events at a time, so one drain re-read those 7 GB for
 * every batch: quadratic in the session's length, on the daemon's only thread,
 * which is why `/status` stopped answering and a day of runs never reached the
 * record (issue #3694).
 *
 * The index is a derived artifact and nothing depends on it existing. It
 * records, for each stored body, the byte offset and byte length of its line,
 * and the number of bytes of the body file those entries account for. A read
 * seeks to the offset and reads that many bytes. A body file that arrives
 * without an index (every file already on disk when this shipped) is scanned
 * once and indexed; a body file that grows is scanned from where the last scan
 * stopped; a body file that shrank was rewritten by `Wal`, so its index is
 * discarded and rebuilt.
 *
 * The sidecar is `<session>.bodies.index`, append-only, one JSON array per
 * line: a header, then `[event_id_idem, offset, length]` entries, then
 * `["through", bytes]` to commit them. A torn final line fails to parse and is
 * dropped, which costs a rescan of the region it covered and nothing else.
 * Entries hold no content, only event ids and numbers.
 */
import {
  appendFileSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

/** Read size for a scan. Large enough that a 1 MiB body costs few reads. */
const SCAN_CHUNK_BYTES = 256 * 1024;

const SIDECAR_SUFFIX = ".bodies.index";
const SIDECAR_HEADER = "tacho/bodies-index";
const SIDECAR_VERSION = 1;

/** How many sessions keep their entries in memory. */
const DEFAULT_CACHED_SESSIONS = 8;

/** One line of a file, with the bytes it occupies. */
export interface IndexedLine {
  text: string;
  /** Byte offset of the line's first byte. */
  offset: number;
  /** Byte offset just past the line, including its newline when it has one. */
  end: number;
  /** Whether a newline closed the line, rather than the end of the file. */
  terminated: boolean;
}

/** One line of a session's body file. */
export interface StoredBody {
  event_id_idem: string;
  seq: number;
  content_type: string;
  bytes_base64: string;
}

/** Where one stored body's line sits in the body file. */
export interface BodyLocation {
  offset: number;
  length: number;
}

export interface BodyIndex {
  entries: Map<string, BodyLocation>;
  /** Bytes of the body file these entries account for. */
  covered: number;
}

/**
 * A stored body, or undefined when the line is anything else.
 *
 * Strict on purpose. A line that parses as JSON but names no event, `null` or
 * `{}` after a torn append, can never ship, so every path treats it the way it
 * treats an unparseable line: the read skips it, and a rewrite drops it.
 */
export function parseStoredBody(text: string): StoredBody | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const stored = value as Partial<StoredBody>;
  if (
    typeof stored.event_id_idem !== "string" ||
    !Number.isSafeInteger(stored.seq) ||
    typeof stored.content_type !== "string" ||
    typeof stored.bytes_base64 !== "string"
  )
    return undefined;
  return stored as StoredBody;
}

/** Split a chunked read into lines, tracking the bytes each one occupies. */
class LineSplitter {
  private parts: Buffer[] = [];
  private partsBytes = 0;
  private lineStart: number;
  private position: number;

  constructor(from: number) {
    this.lineStart = from;
    this.position = from;
  }

  /**
   * The complete lines this chunk closes. Splitting on the newline byte keeps
   * a character that straddles a read boundary intact, because a line is
   * decoded only once its bytes are all in hand.
   */
  push(chunk: Buffer): IndexedLine[] {
    const out: IndexedLine[] = [];
    let cursor = 0;
    for (;;) {
      const newline = chunk.indexOf(10, cursor);
      if (newline === -1) break;
      const tail = chunk.subarray(cursor, newline);
      const bytes =
        this.partsBytes === 0
          ? tail
          : Buffer.concat([...this.parts, tail], this.partsBytes + tail.length);
      const end = this.position + newline + 1;
      out.push({
        text: bytes.toString("utf8"),
        offset: this.lineStart,
        end,
        terminated: true,
      });
      this.parts = [];
      this.partsBytes = 0;
      this.lineStart = end;
      cursor = newline + 1;
    }
    if (cursor < chunk.length) {
      const rest = chunk.subarray(cursor);
      this.parts.push(rest);
      this.partsBytes += rest.length;
    }
    this.position += chunk.length;
    return out;
  }

  /** The unterminated tail an interrupted append leaves, if there is one. */
  rest(): IndexedLine | undefined {
    if (this.partsBytes === 0) return undefined;
    return {
      text: Buffer.concat(this.parts, this.partsBytes).toString("utf8"),
      offset: this.lineStart,
      end: this.position,
      terminated: false,
    };
  }
}

/** Every line of a file from `from`, one at a time, with its byte span. */
export function* readLinesFrom(
  path: string,
  from = 0,
): Generator<IndexedLine, void, undefined> {
  const fd = openSync(path, "r");
  try {
    const splitter = new LineSplitter(from);
    let position = from;
    for (;;) {
      const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
      const size = readSync(fd, chunk, 0, chunk.length, position);
      if (size <= 0) break;
      position += size;
      yield* splitter.push(chunk.subarray(0, size));
    }
    const rest = splitter.rest();
    if (rest !== undefined) yield rest;
  } finally {
    closeSync(fd);
  }
}

/**
 * The same walk, off the synchronous path. Each read is awaited, so the
 * daemon answers `/status` and its control-plane fetches while a multi-gigabyte
 * body file is indexed for the first time.
 */
export async function* readLinesFromAsync(
  path: string,
  from = 0,
): AsyncGenerator<IndexedLine, void, undefined> {
  const handle = await open(path, "r");
  try {
    const splitter = new LineSplitter(from);
    let position = from;
    for (;;) {
      const chunk = Buffer.allocUnsafe(SCAN_CHUNK_BYTES);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      for (const line of splitter.push(chunk.subarray(0, bytesRead)))
        yield line;
    }
    const rest = splitter.rest();
    if (rest !== undefined) yield rest;
  } finally {
    await handle.close();
  }
}

/** What a scan learned about the lines it walked. */
interface ScanResult {
  added: Array<[string, BodyLocation]>;
  covered: number;
  invalid: boolean;
}

function collect(
  line: IndexedLine,
  index: BodyIndex,
  result: ScanResult,
): void {
  result.covered = line.end;
  if (line.text.trim().length === 0) return;
  const stored = parseStoredBody(line.text);
  if (stored === undefined) {
    result.invalid = true;
    return;
  }
  // First line wins, the way a top-to-bottom read answered a duplicate.
  if (index.entries.has(stored.event_id_idem)) return;
  const at = {
    offset: line.offset,
    length: line.end - line.offset - (line.terminated ? 1 : 0),
  };
  index.entries.set(stored.event_id_idem, at);
  result.added.push([stored.event_id_idem, at]);
}

/**
 * The body indexes of one WAL directory, held for the sessions read most
 * recently and persisted beside each body file.
 *
 * Memory is bounded on purpose. A host that has run for a day holds hundreds
 * of sessions, and a session's entries are one per stored body, so keeping
 * every session's entries would trade a disk scan for a heap the daemon cannot
 * afford. The shipper works through sessions in order, so a small cache holds
 * the ones a drain touches, and an evicted session costs one read of its
 * sidecar rather than a scan of its bodies.
 */
export class BodyIndexStore {
  private readonly cached = new Map<string, BodyIndex>();

  constructor(
    private readonly dir: string,
    private readonly cacheLimit: number = DEFAULT_CACHED_SESSIONS,
  ) {}

  private sidecarFor(sessionUuid: string): string {
    return join(this.dir, `${sessionUuid}${SIDECAR_SUFFIX}`);
  }

  /** Whether a name in the WAL directory is one of these sidecars. */
  static isSidecar(name: string): boolean {
    return name.endsWith(SIDECAR_SUFFIX);
  }

  /** Drop what is held for a session and remove its sidecar. */
  invalidate(sessionUuid: string): void {
    this.cached.delete(sessionUuid);
    const path = this.sidecarFor(sessionUuid);
    if (existsSync(path)) unlinkSync(path);
  }

  private remember(sessionUuid: string, index: BodyIndex): void {
    this.cached.delete(sessionUuid);
    this.cached.set(sessionUuid, index);
    while (this.cached.size > this.cacheLimit) {
      const oldest = this.cached.keys().next().value;
      if (oldest === undefined) break;
      this.cached.delete(oldest);
    }
  }

  /** The index to extend, and the byte the scan starts from. */
  private base(sessionUuid: string, bodiesPath: string): BodyIndex {
    const size = statSync(bodiesPath).size;
    const held = this.cached.get(sessionUuid) ?? this.load(sessionUuid);
    if (held !== undefined && held.covered <= size) return held;
    // Either the sidecar said nothing this version can read, or the body file
    // is shorter than the index, which means a rewrite moved every offset.
    // Remove it, so the scan that follows writes a whole one rather than
    // appending to a file the next load will reject again.
    this.invalidate(sessionUuid);
    return { entries: new Map(), covered: 0 };
  }

  private load(sessionUuid: string): BodyIndex | undefined {
    const path = this.sidecarFor(sessionUuid);
    if (!existsSync(path)) return undefined;
    const entries = new Map<string, BodyLocation>();
    let covered: number | undefined;
    let header = false;
    for (const line of readLinesFrom(path)) {
      if (line.text.trim().length === 0) continue;
      let row: unknown;
      try {
        row = JSON.parse(line.text);
      } catch {
        continue; // A torn final line costs a rescan of what it covered.
      }
      if (!Array.isArray(row)) continue;
      if (!header) {
        if (row[0] !== SIDECAR_HEADER || row[1] !== SIDECAR_VERSION)
          return undefined;
        header = true;
        continue;
      }
      if (row[0] === "through") {
        if (Number.isSafeInteger(row[1])) covered = row[1] as number;
        continue;
      }
      const [idem, offset, length] = row as [unknown, unknown, unknown];
      if (
        typeof idem === "string" &&
        Number.isSafeInteger(offset) &&
        Number.isSafeInteger(length) &&
        !entries.has(idem)
      )
        entries.set(idem, {
          offset: offset as number,
          length: length as number,
        });
    }
    if (covered === undefined) return undefined;
    return { entries, covered };
  }

  /**
   * Persist what a scan added. The sidecar is a cache: a write that fails
   * costs the next process one scan, and the body file is untouched either
   * way, so the failure is recorded and the read proceeds.
   */
  private persist(
    sessionUuid: string,
    result: ScanResult,
    onWriteFailure: (error: unknown) => void,
  ): void {
    const path = this.sidecarFor(sessionUuid);
    const lines: string[] = [];
    if (!existsSync(path))
      lines.push(JSON.stringify([SIDECAR_HEADER, SIDECAR_VERSION]));
    for (const [idem, at] of result.added)
      lines.push(JSON.stringify([idem, at.offset, at.length]));
    lines.push(JSON.stringify(["through", result.covered]));
    try {
      appendFileSync(path, `${lines.join("\n")}\n`, { mode: 0o600 });
    } catch (error) {
      onWriteFailure(error);
    }
  }

  /** The index of a body file, built or extended to cover the whole file. */
  ensure(
    sessionUuid: string,
    bodiesPath: string,
    onInvalidRecord: () => void,
    onWriteFailure: (error: unknown) => void,
  ): BodyIndex {
    const index = this.base(sessionUuid, bodiesPath);
    const size = statSync(bodiesPath).size;
    if (index.covered < size) {
      const result: ScanResult = {
        added: [],
        covered: index.covered,
        invalid: false,
      };
      for (const line of readLinesFrom(bodiesPath, index.covered))
        collect(line, index, result);
      index.covered = result.covered;
      this.persist(sessionUuid, result, onWriteFailure);
      if (result.invalid) onInvalidRecord();
    }
    this.remember(sessionUuid, index);
    return index;
  }

  /** The same, with every read awaited. */
  async ensureAsync(
    sessionUuid: string,
    bodiesPath: string,
    onInvalidRecord: () => void,
    onWriteFailure: (error: unknown) => void,
  ): Promise<BodyIndex> {
    const index = this.base(sessionUuid, bodiesPath);
    const size = statSync(bodiesPath).size;
    if (index.covered < size) {
      const result: ScanResult = {
        added: [],
        covered: index.covered,
        invalid: false,
      };
      for await (const line of readLinesFromAsync(bodiesPath, index.covered))
        collect(line, index, result);
      index.covered = result.covered;
      this.persist(sessionUuid, result, onWriteFailure);
      if (result.invalid) onInvalidRecord();
    }
    this.remember(sessionUuid, index);
    return index;
  }
}
