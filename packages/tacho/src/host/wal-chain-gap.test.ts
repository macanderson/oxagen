/**
 * The WAL reports a write that skips a seq, at the moment it is written,
 * instead of leaving the gap for the control plane to find after upload.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import { Wal, type WalChainGap } from "./wal";

const SESSION = "11111111-2222-3333-4444-555555555555";
const dirs: string[] = [];

function event(seq: number, kind = "tool_call"): TachoEvent {
  return {
    session_uuid: SESSION,
    seq,
    kind,
    ts: "2026-09-22T00:00:00.000Z",
  } as unknown as TachoEvent;
}

function wal(gaps: WalChainGap[]): Wal {
  const dir = mkdtempSync(join(tmpdir(), "wal-gap-"));
  dirs.push(dir);
  return new Wal(
    dir,
    () => undefined,
    (gap) => gaps.push(gap),
  );
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("the WAL chain gap report", () => {
  it("stays quiet on a dense chain", () => {
    const gaps: WalChainGap[] = [];
    const log = wal(gaps);
    log.append([event(0)]);
    log.append([event(1), event(2)]);
    expect(gaps).toEqual([]);
  });

  it("names the event that skips a seq", () => {
    const gaps: WalChainGap[] = [];
    const log = wal(gaps);
    log.append([event(0), event(1)]);
    log.append([event(2)]);
    log.append([event(4, "turn_start")]);
    expect(gaps).toEqual([
      { session_uuid: SESSION, after_seq: 2, seq: 4, kind: "turn_start" },
    ]);
  });

  it("catches a gap inside the batch that creates the session", () => {
    const gaps: WalChainGap[] = [];
    const log = wal(gaps);
    log.append([event(0), event(2)]);
    expect(gaps).toEqual([
      { session_uuid: SESSION, after_seq: 0, seq: 2, kind: "tool_call" },
    ]);
  });
});
