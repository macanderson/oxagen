/**
 * Tacho collector P0-1: a daemon restart restored a recorder's chain cursor
 * from `state.json`, written at tick end, and never checked it against what
 * the WAL already held. A crash between an append and the next persist left
 * the cursor behind the log; resealing on top of it landed a second event at
 * a seq the file already had, and ClickHouse's `ReplacingMergeTree` — keyed
 * on seq — silently kept the newer, wrong frame over the original.
 */
import { describe, expect, it } from "vitest";
import type { RecorderState } from "../claude-code/recorder";
import { minimalSession } from "../test-helpers";
import { scratchPaths } from "../host/test-support";
import { Wal } from "../host/wal";
import { reconcileRestoredCursor } from "./daemon";

function baseState(overrides: Partial<RecorderState> = {}): RecorderState {
  return {
    cursor: { seq: 0, prevHash: `sha256:${"0".repeat(64)}` },
    turnSeq: 0,
    turnOpen: false,
    started: true,
    stopped: false,
    context: {},
    host: {},
    anthropic: {},
    totals: {},
    children: {},
    ...overrides,
  };
}

/** A chain hash as the cursor's type spells it. */
const digest = (value: string) => value as `sha256:${string}`;
describe("reconcileRestoredCursor", () => {
  it("advances a cursor the WAL has already moved past", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const uuid = events[0]!.session_uuid;
    const last = events[events.length - 1]!;
    // The persisted cursor is stale: it names the seq right after the first
    // event, as if the process died before recording the rest.
    const state = baseState({
      sessionUuid: uuid,
      cursor: { seq: 1, prevHash: digest(events[0]!.hash) },
    });
    const logs: string[] = [];
    reconcileRestoredCursor(state, wal, (line) => logs.push(line));
    expect(state.cursor).toEqual({ seq: last.seq + 1, prevHash: last.hash });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain(uuid);
  });

  it("leaves a cursor untouched when it already stands ahead of the WAL", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const events = minimalSession();
    wal.append(events);
    const uuid = events[0]!.session_uuid;
    const last = events[events.length - 1]!;
    const correct = { seq: last.seq + 1, prevHash: digest(last.hash) };
    const state = baseState({ sessionUuid: uuid, cursor: { ...correct } });
    const logs: string[] = [];
    reconcileRestoredCursor(state, wal, (line) => logs.push(line));
    expect(state.cursor).toEqual(correct);
    expect(logs).toEqual([]);
  });

  it("corrects a subagent chain's cursor recursively, in its own WAL file", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const parentEvents = minimalSession();
    wal.append(parentEvents);
    const childEvents = minimalSession().map((event) => ({
      ...event,
      session_uuid: "22222222-2222-4222-8222-222222222222",
    }));
    wal.append(childEvents);
    const child = childEvents[childEvents.length - 1]!;
    const state = baseState({
      sessionUuid: parentEvents[0]!.session_uuid,
      cursor: {
        seq: parentEvents[parentEvents.length - 1]!.seq + 1,
        prevHash: digest(parentEvents[parentEvents.length - 1]!.hash),
      },
      children: {
        agent_1: {
          state: baseState({
            sessionUuid: child.session_uuid,
            cursor: { seq: 0, prevHash: `sha256:${"0".repeat(64)}` },
          }),
          open: false,
        },
      },
    });
    reconcileRestoredCursor(state, wal, () => {});
    expect(state.children["agent_1"]?.state.cursor).toEqual({
      seq: child.seq + 1,
      prevHash: child.hash,
    });
  });

  it("skips a legacy state with no sessionUuid rather than throwing", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const state = baseState({ sessionUuid: undefined });
    expect(() => reconcileRestoredCursor(state, wal, () => {})).not.toThrow();
    expect(state.cursor).toEqual({
      seq: 0,
      prevHash: `sha256:${"0".repeat(64)}`,
    });
  });

  it("leaves the cursor alone for a session the WAL has never heard of", () => {
    const paths = scratchPaths();
    const wal = new Wal(paths.wal);
    const state = baseState({
      sessionUuid: "33333333-3333-4333-8333-333333333333",
    });
    reconcileRestoredCursor(state, wal, () => {});
    expect(state.cursor).toEqual({
      seq: 0,
      prevHash: `sha256:${"0".repeat(64)}`,
    });
  });
});
