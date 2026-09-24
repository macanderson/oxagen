/**
 * The hook-id journal: the replay ledger's entries since the daemon last
 * wrote its state file.
 *
 * The ledger (`SessionRecord.hookIds`) reaches disk with the rest of the
 * registry, and the daemon writes that file once per tick. A daemon that
 * dies in between restarts with a ledger that has never heard of the hooks
 * it recorded in its last moments, and their spool replays seal a second
 * time. The journal closes that window: one line per recorded hook,
 * appended right after the hook's frames reach the WAL, and removed once
 * the state file holds the same entries.
 *
 * A line holds a session uuid, a ledger key, a time, and a seq per chain.
 * It holds no payload, prompt, or tool input.
 */
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import type { TachoEvent } from "../envelope";
import { rememberHookId, type SessionRegistry } from "./registry";

export interface HookIdJournalEntry {
  /** The recording session's chain uuid (`recorder.sessionUuid`). */
  session: string;
  /** The hook's ledger key (`hookLedgerKey` in the hook handler). */
  key: string;
  /** When the ledger took the key, epoch ms. */
  at: number;
  /**
   * The highest seq the hook sealed on each chain, as `[uuid, seq]`. The
   * restore keeps an entry only when the WAL holds every one of them.
   */
  frames: Array<[string, number]>;
}

/** One journal entry for a hook whose events just reached the WAL. */
export function hookIdJournalEntry(
  session: string,
  key: string,
  at: number,
  events: readonly TachoEvent[],
): HookIdJournalEntry {
  const highest = new Map<string, number>();
  for (const event of events) {
    const seen = highest.get(event.session_uuid);
    if (seen === undefined || event.seq > seen)
      highest.set(event.session_uuid, event.seq);
  }
  return { session, key, at, frames: [...highest] };
}

/**
 * Append one entry. The write is not fsynced: the WAL bytes it follows are
 * not either until the next state write, and `restoreHookIdJournal` checks
 * the two against each other, so a power cut that keeps the line and loses
 * the frames restores nothing.
 */
export function appendHookIdJournal(
  path: string,
  entry: HookIdJournalEntry,
): void {
  appendFileSync(path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

/** Remove the journal once the state file holds every entry it had. */
export function clearHookIdJournal(path: string): void {
  rmSync(path, { force: true });
}

function isEntry(value: unknown): value is HookIdJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<HookIdJournalEntry>;
  return (
    typeof entry.session === "string" &&
    typeof entry.key === "string" &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    Array.isArray(entry.frames) &&
    entry.frames.every(
      (frame) =>
        Array.isArray(frame) &&
        typeof frame[0] === "string" &&
        typeof frame[1] === "number",
    )
  );
}

/**
 * Every well-formed entry in the journal, oldest first. A line that does
 * not parse is skipped: the last one is torn when the daemon died mid-write.
 */
export function readHookIdJournal(path: string): HookIdJournalEntry[] {
  if (!existsSync(path)) return [];
  const entries: HookIdJournalEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isEntry(value)) entries.push(value);
    } catch {
      // A torn line: the hook it names never finished its journal write.
    }
  }
  return entries;
}

/**
 * Put the journal's entries back into the restored registry and return how
 * many it took. An entry is skipped when its session is not in the registry
 * or when the WAL does not hold every frame the entry names: the ledger must
 * never claim a hook whose record did not survive, or its spool replay, the
 * one copy left, would be dropped.
 */
export function restoreHookIdJournal(
  path: string,
  registry: Pick<SessionRegistry, "byUuid">,
  walSeq: (sessionUuid: string) => number | undefined,
): number {
  const heads = new Map<string, number | undefined>();
  const headOf = (uuid: string): number | undefined => {
    if (!heads.has(uuid)) heads.set(uuid, walSeq(uuid));
    return heads.get(uuid);
  };
  let restored = 0;
  for (const entry of readHookIdJournal(path)) {
    const durable = entry.frames.every(([uuid, seq]) => {
      const head = headOf(uuid);
      return head !== undefined && head >= seq;
    });
    if (!durable) continue;
    const record = registry.byUuid(entry.session);
    if (record === undefined) continue;
    rememberHookId(record, entry.key, entry.at);
    restored += 1;
  }
  return restored;
}
