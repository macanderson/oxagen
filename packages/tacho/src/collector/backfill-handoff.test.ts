/**
 * A backfilled session that resumes live (#4028, ADR-161): the registry
 * continues the chain the backfill sealed, and the tailer reads the
 * transcript on from where the backfill stopped, so the session keeps one
 * chain and no line is sealed twice.
 */
import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ClaudeCodeContext } from "../claude-code/context";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { TEST_ENROLLMENT } from "../host/test-support";
import { sessionUuid } from "../ids";
import { SessionRegistry } from "./registry";
import { type TailedSession, TranscriptTailer } from "./transcript-tailer";

const SESSION = "0b1f0000-0000-4000-8000-00000000b001";
const CONTEXT: ClaudeCodeContext = {
  agent: {
    agent_key: "acme.core.cc-laptop",
    fleet_id: "wrk_1",
    runtime: "claude-code",
    harness: "claude-code",
    wrapper_version: "2.1.1",
    host_enrollment_id: TEST_ENROLLMENT,
  },
};

/** A tailed session whose recorder remembers the lines it was handed. */
function fakeSession(path: string) {
  const lines: string[] = [];
  const session: TailedSession & { lines: string[] } = {
    harnessSessionId: SESSION,
    transcriptPath: path,
    sealed: false,
    lines,
    recorder: {
      ingestTranscriptLine(line: string): TachoEvent[] {
        lines.push(line);
        return [];
      },
      takeBodies(): FrameBody[] {
        return [];
      },
      markChain() {
        return {} as ReturnType<TailedSession["recorder"]["markChain"]>;
      },
      rollbackChain() {},
      sealCollectorEvent() {
        return {} as TachoEvent;
      },
    },
  };
  return session;
}

describe("a backfilled session that resumes live", () => {
  it("is read on from where the backfill stopped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-handoff-"));
    const path = join(dir, `${SESSION}.jsonl`);
    const backfilled = '{"type":"user","n":1}\n{"type":"user","n":2}\n';
    writeFileSync(path, `${backfilled}{"type":"user","n":3}\n`);
    const session = fakeSession(path);
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => {},
      adoptedCursor: (id, at) =>
        id === SESSION && at === path
          ? {
              offset: Buffer.byteLength(backfilled),
              ino: statSync(path).ino,
              head: Buffer.from(backfilled.slice(0, 64)).toString("base64"),
              subagents: [],
            }
          : undefined,
    });
    expect(tailer.holdsCursor(SESSION)).toBe(false);
    await tailer.tick();
    expect(session.lines).toEqual(['{"type":"user","n":3}']);
    expect(tailer.holdsCursor(SESSION)).toBe(true);
  });

  it("is read from byte 0 when the file was replaced since the backfill", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-handoff-"));
    const path = join(dir, `${SESSION}.jsonl`);
    writeFileSync(path, '{"type":"user","n":"a"}\n{"type":"user","n":"b"}\n');
    const session = fakeSession(path);
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => {},
      adoptedCursor: () => ({
        offset: 10,
        ino: statSync(path).ino,
        // The head of a different file.
        head: Buffer.from('{"type":"assistant"}').toString("base64"),
        subagents: [],
      }),
    });
    await tailer.tick();
    expect(session.lines).toEqual([
      '{"type":"user","n":"a"}',
      '{"type":"user","n":"b"}',
    ]);
  });

  it("continues the backfilled chain at the next seq", () => {
    const head = {
      cursor: { seq: 42, prevHash: `sha256:${"a".repeat(64)}` as const },
      turnSeq: 3,
    };
    const uuid = sessionUuid(TEST_ENROLLMENT, SESSION);
    const asked: string[] = [];
    const registry = new SessionRegistry({
      context: CONTEXT,
      scope: TEST_ENROLLMENT,
      now: () => Date.parse("2026-10-02T12:00:00.000Z"),
      adoptedChain: (sessionUuidValue) => {
        asked.push(sessionUuidValue);
        return sessionUuidValue === uuid ? head : undefined;
      },
    });
    expect(registry.holdsChain(SESSION)).toBe(false);
    const { record } = registry.ensure(SESSION, {});
    expect(asked).toEqual([uuid]);
    expect(record.recorder.sessionUuid).toBe(uuid);
    expect(record.recorder.chainCursor).toEqual(head.cursor);
    expect(record.recorder.turnCount).toBe(3);
    expect(registry.holdsChain(SESSION)).toBe(true);
    // A session the backfill never sealed starts at genesis, as before.
    const other = registry.ensure("11111111-2222-4333-8444-555555555555", {});
    expect(other.record.recorder.chainCursor.seq).toBe(0);
  });
});
