/**
 * The bodies a host holds until the control plane takes them.
 *
 * A frame's content is digested onto the chain in every retention mode
 * (`contentFrameOf`). Under `content_exact` the redacted bytes are kept here
 * as well, one file per event, and shipped next to the event that names them.
 * Under `digest_only` nothing reaches this store, so an operator who reads the
 * disk sees the same thing the control plane does.
 *
 * One file per event rather than a log: a body is dropped the moment its
 * event is acknowledged or refused, and unlinking one file is cheaper and
 * safer than rewriting a shared one while the daemon is shipping.
 *
 * The directory is 0700 and every file 0600, the same as the rest of
 * `~/.config/oxagen/tacho`. The bytes are redacted before they arrive, so
 * what is on disk carries no credential the detectors recognise, but it is
 * still the operator's prompt text and is treated as theirs.
 */
import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { retainsBody, type RetentionMandate } from "../evidence/retention";
import { TACHO_MAX_BODY_BYTES, type TachoBody } from "../wire";
import { ensureDir, readJsonFileIfExists, writeSensitiveFileAtomic } from "./fs";

/** What one stored body file holds. */
interface StoredBody {
  /** The frame's kind, so the mandate's classes can be applied later too. */
  kind: string;
  content_type: string;
  bytes_base64: string;
}

export interface BodyStoreStats {
  bodies: number;
  bytes: number;
}

/** `evt_` followed by 64 hex characters, which is also a safe file name. */
const EVENT_ID_IDEM = /^evt_[0-9a-f]{64}$/;

export class BodyStore {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
    ensureDir(dir);
  }

  private fileFor(eventIdIdem: string): string {
    return join(this.dir, `${eventIdIdem}.json`);
  }

  /**
   * Keep the bytes for one event. Returns false, and keeps nothing, when the
   * id is not one this store will name a file after or the bytes are over the
   * wire's ceiling. An oversized body is dropped here rather than shipped and
   * refused: the frame keeps its digest either way, and a body the control
   * plane will not accept is not worth the disk.
   */
  put(
    eventIdIdem: string,
    kind: string,
    contentType: string,
    bytes: Uint8Array,
  ): boolean {
    if (!EVENT_ID_IDEM.test(eventIdIdem)) return false;
    if (bytes.byteLength > TACHO_MAX_BODY_BYTES) return false;
    const stored: StoredBody = {
      kind,
      content_type: contentType,
      bytes_base64: Buffer.from(bytes).toString("base64"),
    };
    writeSensitiveFileAtomic(
      this.fileFor(eventIdIdem),
      JSON.stringify(stored),
    );
    return true;
  }

  /**
   * The bodies held for these events that the mandate in force still
   * retains, in the order asked for. One that it no longer retains is
   * dropped rather than returned: the mandate at ship time is the one that
   * decides, so a narrowing between the write and the drain is honoured
   * instead of raced.
   */
  take(
    eventIdIdems: readonly string[],
    retention: RetentionMandate | undefined,
  ): TachoBody[] {
    const out: TachoBody[] = [];
    for (const id of eventIdIdems) {
      const stored = readJsonFileIfExists(this.fileFor(id)) as
        | StoredBody
        | undefined;
      if (
        stored === undefined ||
        typeof stored.content_type !== "string" ||
        typeof stored.bytes_base64 !== "string"
      )
        continue;
      if (!retainsBody(stored.kind ?? "", retention)) {
        this.drop([id]);
        continue;
      }
      out.push({
        event_id_idem: id,
        content_type: stored.content_type,
        bytes_base64: stored.bytes_base64,
      });
    }
    return out;
  }

  /**
   * Drop every held body the mandate no longer retains, and answer how many
   * went. Called when a refreshed mandate narrows: what is already on disk is
   * bound by it too, not only what is sealed next.
   */
  dropDisallowed(retention: RetentionMandate | undefined): number {
    let dropped = 0;
    for (const name of this.files()) {
      const id = name.replace(/\.json$/, "");
      const stored = readJsonFileIfExists(join(this.dir, name)) as
        | StoredBody
        | undefined;
      if (retainsBody(stored?.kind ?? "", retention)) continue;
      this.drop([id]);
      dropped += 1;
    }
    return dropped;
  }

  /** Forget these bodies: the control plane took them, or refused them. */
  drop(eventIdIdems: readonly string[]): void {
    for (const id of eventIdIdems) {
      if (!EVENT_ID_IDEM.test(id)) continue;
      try {
        unlinkSync(this.fileFor(id));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  /**
   * Drop bodies older than `retainMs`. A body whose event was quarantined, or
   * whose batch never shipped, has nothing left to drop it, and prompt text
   * is not something to keep on a laptop indefinitely because a batch failed.
   */
  compact(now: number, retainMs: number): string[] {
    const dropped: string[] = [];
    for (const name of this.files()) {
      const path = join(this.dir, name);
      try {
        if (now - statSync(path).mtimeMs <= retainMs) continue;
        unlinkSync(path);
        dropped.push(name.replace(/\.json$/, ""));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return dropped;
  }

  stats(): BodyStoreStats {
    let bytes = 0;
    let bodies = 0;
    for (const name of this.files()) {
      try {
        bytes += statSync(join(this.dir, name)).size;
        bodies += 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { bodies, bytes };
  }

  private files(): string[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir).filter((name) => name.endsWith(".json"));
  }
}
