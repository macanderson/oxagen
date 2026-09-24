/**
 * The hook-id journal carries the replay ledger across a daemon crash: the
 * entries recorded since the last state write, and only those whose frames
 * the WAL still holds.
 */
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import {
  appendHookIdJournal,
  clearHookIdJournal,
  hookIdJournalEntry,
  readHookIdJournal,
  restoreHookIdJournal,
} from "./hook-id-journal";
import type { SessionRecord, SessionRegistry } from "./registry";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hook-id-journal-"));
  path = join(dir, "hook-ids.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const frame = (sessionUuid: string, seq: number): TachoEvent =>
  ({ session_uuid: sessionUuid, seq }) as unknown as TachoEvent;

/** A registry that knows the given session uuids, each with an empty ledger. */
function registryOf(...uuids: string[]): {
  registry: Pick<SessionRegistry, "byUuid">;
  ledger: (uuid: string) => Map<string, number> | undefined;
} {
  const records = new Map(
    uuids.map((uuid) => [
      uuid,
      { hookIds: new Map<string, number>() } as unknown as SessionRecord,
    ]),
  );
  return {
    registry: { byUuid: (uuid) => records.get(uuid) },
    ledger: (uuid) => records.get(uuid)?.hookIds,
  };
}

describe("hookIdJournalEntry", () => {
  it("keeps the highest seq on each chain", () => {
    const entry = hookIdJournalEntry("s1", "hook_a", 1_000, [
      frame("s1", 4),
      frame("s1", 6),
      frame("child", 2),
      frame("s1", 5),
    ]);
    expect(entry).toEqual({
      session: "s1",
      key: "hook_a",
      at: 1_000,
      frames: [
        ["s1", 6],
        ["child", 2],
      ],
    });
  });
});

describe("the journal file", () => {
  it("reads back what it appended, oldest first", () => {
    const first = hookIdJournalEntry("s1", "hook_a", 1_000, [frame("s1", 1)]);
    const second = hookIdJournalEntry("s1", "hook_b", 2_000, [frame("s1", 2)]);
    appendHookIdJournal(path, first);
    appendHookIdJournal(path, second);
    expect(readHookIdJournal(path)).toEqual([first, second]);
  });

  it("skips a torn last line and a malformed one", () => {
    const entry = hookIdJournalEntry("s1", "hook_a", 1_000, [frame("s1", 1)]);
    appendHookIdJournal(path, entry);
    appendFileSync(path, `${JSON.stringify({ session: "s1" })}\n`);
    appendFileSync(path, '{"session":"s1","key":"hook_b","at":20');
    expect(readHookIdJournal(path)).toEqual([entry]);
  });

  it("reads as empty once cleared or before it exists", () => {
    expect(readHookIdJournal(path)).toEqual([]);
    appendHookIdJournal(
      path,
      hookIdJournalEntry("s1", "hook_a", 1_000, [frame("s1", 1)]),
    );
    clearHookIdJournal(path);
    expect(readHookIdJournal(path)).toEqual([]);
    clearHookIdJournal(path);
  });
});

describe("restoreHookIdJournal", () => {
  it("restores an entry whose frames the WAL holds", () => {
    appendHookIdJournal(
      path,
      hookIdJournalEntry("s1", "hook_a", 1_000, [frame("s1", 3)]),
    );
    const { registry, ledger } = registryOf("s1");
    expect(restoreHookIdJournal(path, registry, () => 3)).toBe(1);
    expect(ledger("s1")?.get("hook_a")).toBe(1_000);
  });

  it("skips an entry whose frames the WAL lost", () => {
    // The replay is the only copy of that hook left, so the ledger must not
    // claim it.
    appendHookIdJournal(
      path,
      hookIdJournalEntry("s1", "hook_a", 1_000, [frame("s1", 3)]),
    );
    appendHookIdJournal(
      path,
      hookIdJournalEntry("s1", "hook_b", 2_000, [
        frame("s1", 4),
        frame("child", 1),
      ]),
    );
    const { registry, ledger } = registryOf("s1");
    const heads: Record<string, number> = { s1: 4 };
    expect(restoreHookIdJournal(path, registry, (uuid) => heads[uuid])).toBe(1);
    expect(ledger("s1")?.has("hook_a")).toBe(true);
    expect(ledger("s1")?.has("hook_b")).toBe(false);
  });

  it("skips an entry for a session the registry does not know", () => {
    appendHookIdJournal(
      path,
      hookIdJournalEntry("gone", "hook_a", 1_000, [frame("gone", 1)]),
    );
    const { registry } = registryOf("s1");
    expect(restoreHookIdJournal(path, registry, () => 9)).toBe(0);
  });
});
