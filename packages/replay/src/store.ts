/**
 * The record store (ADR-028) — an append-only NDJSON record log plus a
 * content-addressed blob store, both living under a session's `record/` dir:
 *
 *   record/record.ndjson    the record log (record-v1 envelope)
 *   record/blobs/<sha256>   payload blobs, named by their content hash
 *
 * Same durability stance as the ADR-023 session store: appends are serialized
 * per writer but never fsync'd; readers tolerate torn tails. Blobs are
 * immutable by construction — a ref either resolves to content that hashes
 * back to the ref, or the store is corrupt and `verify` says so.
 *
 * SENSITIVITY: this store is deliberately verbatim — it holds whatever the
 * agent's tools read and wrote, unredacted, so a replay is faithful. That
 * includes anything a tool happened to surface: environment dumps, config
 * files, tokens echoed by a failing command. Blobs and the log inherit the
 * process umask, so treat a `record/` directory as sensitive as the working
 * tree it recorded, and never copy one off the machine unreviewed.
 */
import {
  access,
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { sha256Hex, stableStringify } from "./hash.js";
import {
  RECORD_SCHEMA_VERSION,
  parseReplayRecordLine,
  serializeReplayRecord,
  type ReplayRecord,
  type ReplayRecordInput,
  type TruncatedBlob,
} from "./records.js";

/** The record sidecar's directory name inside a session directory. */
export const RECORD_DIR_NAME = "record";

/**
 * Head characters preserved in a truncation marker (enough to eyeball the
 * payload). Counted in UTF-16 code units, not bytes — the marker is a preview,
 * so an exact byte budget buys nothing and would risk splitting a surrogate
 * pair. The full payload's real byte length rides in the marker's `bytes`.
 */
const TRUNCATION_HEAD_CHARS = 64 * 1024;

export interface RecordWriter {
  readonly sid: string;
  /** Append one record; stamps `rv`/`sid`/`seq`/`ts`. */
  append(input: ReplayRecordInput): ReplayRecord;
  /** Await every queued append (call before process exit). */
  flush(): Promise<void>;
}

export interface PutBlobResult {
  ref: string;
  /** True when the stored blob is a truncation marker, not the payload. */
  isTruncated: boolean;
}

export class RecordStore {
  private readonly dir: string;
  private readonly blobsDir: string;

  constructor(opts: { dir: string }) {
    this.dir = opts.dir;
    this.blobsDir = join(opts.dir, "blobs");
  }

  get rootDir(): string {
    return this.dir;
  }

  private get logFile(): string {
    return join(this.dir, "record.ndjson");
  }

  /** Create the record dir, blob dir, and empty log (idempotent). */
  async init(): Promise<void> {
    await mkdir(this.blobsDir, { recursive: true });
    await appendFile(this.logFile, "");
  }

  /**
   * Store `content` content-addressed; returns its ref. Payloads over
   * `maxBytes` store an explicit truncation marker instead (whose ref
   * addresses the MARKER — the full content's hash lives inside it).
   */
  async putBlob(
    content: string,
    opts: { maxBytes?: number } = {},
  ): Promise<PutBlobResult> {
    const maxBytes = opts.maxBytes ?? Number.POSITIVE_INFINITY;
    const bytes = Buffer.byteLength(content, "utf8");
    if (bytes > maxBytes) {
      const marker: TruncatedBlob = {
        __truncated: true,
        bytes,
        sha256: sha256Hex(content),
        head: content.slice(0, TRUNCATION_HEAD_CHARS),
      };
      const ref = await this.writeBlob(stableStringify(marker));
      return { ref, isTruncated: true };
    }
    const ref = await this.writeBlob(content);
    return { ref, isTruncated: false };
  }

  /** Store a JSON value (stable key order) content-addressed. */
  async putJsonBlob(
    value: unknown,
    opts: { maxBytes?: number } = {},
  ): Promise<PutBlobResult> {
    return this.putBlob(stableStringify(value), opts);
  }

  /** Read a blob's raw content, or null when the ref does not resolve. */
  async getBlob(ref: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(ref)) return null;
    try {
      return await readFile(join(this.blobsDir, ref), "utf8");
    } catch {
      return null;
    }
  }

  /** Read and JSON-parse a blob, or null when missing/unparsable. */
  async getJsonBlob<T = unknown>(ref: string): Promise<T | null> {
    const raw = await this.getBlob(ref);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  /**
   * Open the writer half. `sid` stamps every record; `lastSeq` seeds the
   * counter (0 for a fresh record log). One promise chain per writer keeps
   * on-disk order identical to emission order — the ADR-023 discipline.
   */
  openWriter(opts: {
    sid: string;
    lastSeq?: number;
    now?: () => number;
  }): RecordWriter {
    const now = opts.now ?? Date.now;
    let seq = opts.lastSeq ?? 0;
    let queue: Promise<void> = Promise.resolve();

    const enqueue = (work: () => Promise<void>): void => {
      queue = queue.then(work, work);
      queue.catch(() => {});
    };

    return {
      sid: opts.sid,
      append: (input: ReplayRecordInput): ReplayRecord => {
        seq += 1;
        const record = {
          rv: RECORD_SCHEMA_VERSION,
          sid: opts.sid,
          seq,
          ts: now(),
          ...input,
        } as ReplayRecord;
        const line = serializeReplayRecord(record) + "\n";
        enqueue(() => appendFile(this.logFile, line));
        return record;
      },
      flush: async (): Promise<void> => {
        await queue;
      },
    };
  }

  /** All records currently on disk, in log order. Torn/foreign lines skipped. */
  async readRecords(): Promise<ReplayRecord[]> {
    let raw: string;
    try {
      raw = await readFile(this.logFile, "utf8");
    } catch {
      return [];
    }
    const records: ReplayRecord[] = [];
    for (const line of raw.split("\n")) {
      const record = parseReplayRecordLine(line);
      if (record) records.push(record);
    }
    return records;
  }

  /** True when a record log exists for this store (i.e. the run was recorded). */
  async hasRecords(): Promise<boolean> {
    try {
      await readFile(this.logFile, "utf8");
      return true;
    } catch {
      return false;
    }
  }

  private async writeBlob(content: string): Promise<string> {
    const ref = sha256Hex(content);
    const file = join(this.blobsDir, ref);
    try {
      // Presence only — reading the bytes back would re-load up to 8 MB per
      // unchanged file, per turn, on the recorder's hot path.
      await access(file);
      return ref; // Content-addressed: already present means already correct.
    } catch {
      // Not present — write via tmp+rename so concurrent writers of the SAME
      // content never expose a torn blob (both write identical bytes).
      await mkdir(this.blobsDir, { recursive: true });
      const tmp = join(this.blobsDir, `.${ref}.${process.pid}.tmp`);
      await writeFile(tmp, content);
      await rename(tmp, file);
      return ref;
    }
  }
}

/** The record store for a given ADR-023 session directory. */
export function openRecordStore(sessionDir: string): RecordStore {
  return new RecordStore({ dir: join(sessionDir, RECORD_DIR_NAME) });
}
