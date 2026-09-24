/**
 * The tailer against real files in a scratch directory: a line lands once
 * its newline does, an append is picked up where the last tick left off, a
 * truncated file is read from the start again, a subagent transcript is fed
 * once and only once, a tick reads no more than its budget, and the cursors
 * survive a restart.
 */
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { sessionMapKey } from "./registry";
import {
  completeLines,
  type TailedSession,
  TranscriptTailer,
} from "./transcript-tailer";

/** A recorder that only remembers the lines it was handed. */
function fakeSession(
  id: string,
  transcriptPath?: string,
  identity: Pick<TailedSession, "harness" | "customAgent"> = {},
) {
  const lines: Array<{ line: string; subagentId?: string }> = [];
  const session: TailedSession & { lines: typeof lines } = {
    harnessSessionId: id,
    ...identity,
    ...(transcriptPath !== undefined ? { transcriptPath } : {}),
    sealed: false,
    lines,
    recorder: {
      ingestTranscriptLine(line: string, subagentId?: string): TachoEvent[] {
        lines.push(subagentId !== undefined ? { line, subagentId } : { line });
        return [{ kind: "line" } as unknown as TachoEvent];
      },
      takeBodies(): FrameBody[] {
        return [];
      },
      // A chain mark/rollback pair the tests never exercise a rollback
      // through: nothing here ever throws, so recording the count is enough
      // to satisfy the recorder shape `feedLine` needs.
      markChain() {
        return { lines: lines.length } as unknown as ReturnType<
          TailedSession["recorder"]["markChain"]
        >;
      },
      rollbackChain(mark: unknown) {
        lines.length = (mark as { lines: number }).lines;
      },
      sealCollectorEvent(kind: string): TachoEvent {
        return { kind } as unknown as TachoEvent;
      },
    },
  };
  return session;
}

/** The cursor map key the tailer uses for a default (Claude Code) session. */
function cursorId(harnessSessionId: string): string {
  return sessionMapKey(harnessSessionId, {});
}

describe("TranscriptTailer", () => {
  const dirs: string[] = [];
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), "tacho-tail-"));
    dirs.push(dir);
    return dir;
  }
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  function tailer(
    sessions: TailedSession[],
    options: {
      statePath?: string;
      budgetBytes?: number;
      now?: () => number;
      sealedIdleMs?: number;
    } = {},
  ) {
    const recorded: TachoEvent[] = [];
    const log: string[] = [];
    const instance = new TranscriptTailer({
      sessions: () => sessions,
      session: (id) => sessions.find((s) => s.harnessSessionId === id),
      record: (events) => recorded.push(...events),
      log: (line) => log.push(line),
      ...options,
    });
    return { instance, recorded, log };
  }

  it("splits a chunk at its last newline and keeps the partial tail on disk", async () => {
    expect(completeLines(Buffer.from("a\nb\nc"))).toEqual({
      lines: ["a", "b"],
      consumed: 4,
    });
    expect(completeLines(Buffer.from("no newline"))).toEqual({
      lines: [],
      consumed: 0,
    });
    // A multibyte character straddling the read is never split: the newline
    // byte cannot occur inside one.
    expect(completeLines(Buffer.from("héllo\nwörld"))).toEqual({
      lines: ["héllo"],
      consumed: Buffer.byteLength("héllo\n"),
    });
  });

  it("feeds complete lines, waits for a partial one, and continues from where it stopped", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    const { instance, recorded } = tailer([session]);

    // Nothing to read until the harness creates the file.
    await instance.tick();
    expect(session.lines).toEqual([]);

    writeFileSync(path, '{"a":1}\n{"b":2}\n{"c":');
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual(['{"a":1}', '{"b":2}']);
    expect(recorded).toHaveLength(2);

    // The partial line completes and another follows it.
    appendFileSync(path, '3}\n{"d":4}\n');
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual([
      '{"a":1}',
      '{"b":2}',
      '{"c":3}',
      '{"d":4}',
    ]);

    // Nothing new: nothing fed.
    await instance.tick();
    expect(session.lines).toHaveLength(4);
    expect(instance.state().cursors[cursorId("s1")]?.offset).toBe(
      Buffer.byteLength('{"a":1}\n{"b":2}\n{"c":3}\n{"d":4}\n'),
    );
  });

  it("reads a truncated or replaced file from the start again", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    const { instance } = tailer([session]);
    writeFileSync(path, "one\ntwo\nthree\n");
    await instance.tick();
    expect(session.lines).toHaveLength(3);

    writeFileSync(path, "x\n");
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual([
      "one",
      "two",
      "three",
      "x",
    ]);

    // A new inode at the same path, even one longer than the old cursor.
    unlinkSync(path);
    writeFileSync(path, "fresh-1\nfresh-2\n");
    await instance.tick();
    expect(session.lines.slice(-2).map((l) => l.line)).toEqual([
      "fresh-1",
      "fresh-2",
    ]);
  });

  it("reads at most the budget per tick and finishes on later ticks", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    const line = `${"x".repeat(99)}\n`;
    writeFileSync(path, line.repeat(10));
    const { instance } = tailer([session], { budgetBytes: 250 });
    await instance.tick();
    // 250 bytes hold two whole 100-byte lines; the third waits.
    expect(session.lines).toHaveLength(2);
    await instance.tick();
    expect(session.lines).toHaveLength(4);
    for (let i = 0; i < 3; i += 1) await instance.tick();
    expect(session.lines).toHaveLength(10);
  });

  it("gets past a line longer than the budget without stalling, and seals a gap", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    writeFileSync(path, `${"y".repeat(1000)}\nafter\n`);
    const { instance, recorded, log } = tailer([session], { budgetBytes: 100 });
    await instance.tick();
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual(["after"]);
    // The line the budget could not hold is not silent: a gap frame stands
    // in for it, so a reader sees the loss on the chain, not only in a log.
    expect(recorded.some((event) => event.kind === "telemetry_gap")).toBe(true);
    expect(log.some((l) => l.includes("transcript_line_too_long"))).toBe(true);
  });

  it("rolls back and seals a gap for one refused line, and still feeds the rest", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    writeFileSync(path, "a\nBAD\nc\n");
    // A line the envelope refuses (an out-of-bounds field, an unanticipated
    // shape): the recorder throws instead of sealing it.
    const originalIngest = session.recorder.ingestTranscriptLine;
    session.recorder.ingestTranscriptLine = (line, subagentId) => {
      if (line === "BAD") throw new Error("envelope refused this line");
      return originalIngest(line, subagentId);
    };
    const { instance, recorded, log } = tailer([session]);
    await instance.tick();
    // The line before and after the refused one are still fed; the tailer
    // does not stall or drop them for one bad line in the middle.
    expect(session.lines.map((l) => l.line)).toEqual(["a", "c"]);
    expect(recorded.some((event) => event.kind === "telemetry_gap")).toBe(true);
    expect(log.some((l) => l.includes("transcript_line_refused"))).toBe(true);
    // A later tick reads nothing new: the offset moved past the refused
    // line, not just the ones on either side of it.
    await instance.tick();
    expect(session.lines).toHaveLength(2);
  });

  it("keeps tailing one session when another's recorder is broken beyond a gap frame", async () => {
    const dir = scratch();
    const pathA = join(dir, "a.jsonl");
    const pathB = join(dir, "b.jsonl");
    writeFileSync(pathA, "a1\n");
    writeFileSync(pathB, "b1\n");
    const sessionA = fakeSession("a", pathA);
    const sessionB = fakeSession("b", pathB);
    // A recorder broken deeply enough that it cannot even seal the gap
    // frame `feedLine` falls back to: every call to `takeBodies` throws, so
    // the throw that follows the rollback escapes `feedLine` itself. This
    // must still not cost session A its tick.
    sessionB.recorder.takeBodies = () => {
      throw new Error("wal broken");
    };
    const { instance, log } = tailer([sessionA, sessionB]);
    await expect(instance.tick()).resolves.toBeUndefined();
    expect(sessionA.lines.map((l) => l.line)).toEqual(["a1"]);
    expect(
      log.some((l) => l.includes("transcript tail for b failed this tick")),
    ).toBe(true);
  });

  it("feeds a subagent transcript once, with the subagent id, and never twice", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const agentPath = join(dir, "agent-a1.jsonl");
    const session = fakeSession("s1", path);
    writeFileSync(agentPath, "sub-1\nsub-2\n");
    const { instance } = tailer([session]);
    expect(await instance.ingestSubagentTranscript("s1", "a1", agentPath)).toBe(
      2,
    );
    expect(session.lines).toEqual([
      { line: "sub-1", subagentId: "a1" },
      { line: "sub-2", subagentId: "a1" },
    ]);
    // A replayed SubagentStop for the same agent feeds nothing.
    expect(await instance.ingestSubagentTranscript("s1", "a1", agentPath)).toBe(
      0,
    );
    expect(session.lines).toHaveLength(2);
    // A path that is not there is reported, not thrown.
    expect(
      await instance.ingestSubagentTranscript("s1", "a2", join(dir, "missing")),
    ).toBeUndefined();
    // An unknown session is ignored.
    expect(
      await instance.ingestSubagentTranscript("nope", "a1", agentPath),
    ).toBeUndefined();
  });

  it("keeps tailing a sealed session while it still grows, and drains it only once idle", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const session = fakeSession("s1", path);
    writeFileSync(path, "a\n");
    let clock = 1_000_000;
    const { instance } = tailer([session], {
      now: () => clock,
      sealedIdleMs: 1_000,
    });
    await instance.tick();
    expect(session.lines).toHaveLength(1);
    // SessionEnd: the hook path drains, the harness flushes one last line.
    appendFileSync(path, "b\n");
    await instance.drain("s1");
    expect(session.lines).toHaveLength(2);

    session.sealed = true;
    // A trailing write after `agent_stop` still lands: sealing does not cut
    // reading off after one pass any more.
    appendFileSync(path, "cost-state\n");
    clock += 100;
    await instance.tick();
    expect(session.lines).toHaveLength(3);
    expect(instance.state().cursors[cursorId("s1")]?.drained).toBeUndefined();

    // Growth after sealing resets the quiet clock.
    appendFileSync(path, "late\n");
    clock += 900;
    await instance.tick();
    expect(session.lines).toHaveLength(4);
    expect(instance.state().cursors[cursorId("s1")]?.drained).toBeUndefined();

    // Now genuinely quiet: one tick starts the idle clock, and a later one
    // past `sealedIdleMs` with still nothing new drains the cursor.
    clock += 100;
    await instance.tick();
    expect(instance.state().cursors[cursorId("s1")]?.drained).toBeUndefined();
    clock += 1_500;
    await instance.tick();
    expect(instance.state().cursors[cursorId("s1")]?.drained).toBe(true);

    // The tombstone stays; nothing is read again, however long it waits.
    appendFileSync(path, "too-late\n");
    clock += 100_000;
    for (let i = 0; i < 4; i += 1) await instance.tick();
    await instance.drain("s1");
    expect(session.lines).toHaveLength(4);
    expect(instance.state().cursors[cursorId("s1")]?.drained).toBe(true);

    // Once the registry forgets the session, the tombstone goes too.
    const sessions = [session];
    const second = tailer(sessions, { now: () => clock });
    await second.instance.tick();
    expect(second.instance.state().cursors[cursorId("s1")]).toBeDefined();
    sessions.length = 0;
    await second.instance.tick();
    expect(second.instance.state().cursors[cursorId("s1")]).toBeUndefined();
  });

  it("does not let one agent's drained tombstone block another sharing the raw id", async () => {
    const dir = scratch();
    const pathA = join(dir, "a.jsonl");
    const pathB = join(dir, "b.jsonl");
    const sharedId = "shared-session";
    writeFileSync(pathA, "agent-a-1\n");
    writeFileSync(pathB, "agent-b-1\nagent-b-2\n");
    const agentA = fakeSession(sharedId, pathA);
    const agentB = fakeSession(sharedId, pathB, { customAgent: "reviewer" });
    const sessions = [agentA, agentB];
    let clock = 1_000_000;
    const { instance } = tailer(sessions, {
      now: () => clock,
      sealedIdleMs: 0,
    });

    await instance.tick();
    expect(agentA.lines.map((l) => l.line)).toEqual(["agent-a-1"]);
    expect(agentB.lines.map((l) => l.line)).toEqual(["agent-b-1", "agent-b-2"]);

    // Agent A seals and drains once its transcript has sat idle; its
    // tombstone must not key on the raw id.
    agentA.sealed = true;
    await instance.tick();
    clock += 1;
    await instance.tick();
    const keyA = sessionMapKey(sharedId, {});
    const keyB = sessionMapKey(sharedId, { customAgent: "reviewer" });
    expect(instance.state().cursors[keyA]?.drained).toBe(true);
    expect(instance.state().cursors[keyB]?.drained).toBeUndefined();
    expect(keyA).not.toBe(keyB);

    // Agent B keeps growing: the tombstone for A must not skip B's reads.
    appendFileSync(pathB, "agent-b-3\n");
    await instance.tick();
    expect(agentB.lines.map((l) => l.line)).toEqual([
      "agent-b-1",
      "agent-b-2",
      "agent-b-3",
    ]);
    expect(instance.state().cursors[keyA]?.drained).toBe(true);
  });

  it("does not read a sealed session that has no cursor", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const statePath = join(dir, "state", "transcript-tail.json");
    writeFileSync(path, "one\ntwo\n");
    // A daemon before the tombstone dropped this cursor; the registry still
    // lists the session, sealed.
    const session = fakeSession("s1", path);
    session.sealed = true;
    const first = tailer([session], { statePath });
    await first.instance.tick();
    await first.instance.tick();
    expect(session.lines).toEqual([]);
    expect(first.instance.state().cursors[cursorId("s1")]?.drained).toBe(true);
    // The tombstone survives a restart.
    const second = tailer([session], { statePath });
    await second.instance.tick();
    expect(session.lines).toEqual([]);
  });

  it("persists cursors so a restart does not re-read the transcript", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const statePath = join(dir, "state", "transcript-tail.json");
    const session = fakeSession("s1", path);
    writeFileSync(path, "one\ntwo\n");
    const first = tailer([session], { statePath });
    await first.instance.tick();
    expect(session.lines).toHaveLength(2);
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as {
      schema: string;
      cursors: Record<string, { offset: number }>;
    };
    expect(persisted.schema).toBe("tacho.transcript-tail.v1");
    expect(persisted.cursors[cursorId("s1")]?.offset).toBe(8);

    const again = fakeSession("s1", path);
    appendFileSync(path, "three\n");
    const restarted = tailer([again], { statePath });
    await restarted.instance.tick();
    expect(again.lines.map((l) => l.line)).toEqual(["three"]);
  });

  it("starts over on a new transcript path for the same session", async () => {
    const dir = scratch();
    const first = join(dir, "a.jsonl");
    const second = join(dir, "b.jsonl");
    writeFileSync(first, "a1\n");
    writeFileSync(second, "b1\nb2\n");
    const session = fakeSession("s1", first);
    const { instance } = tailer([session]);
    await instance.tick();
    session.transcriptPath = second;
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual(["a1", "b1", "b2"]);
  });

  it("never tails a transcript for a harness transcript.ts cannot normalize", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    // Codex's hook payload can carry a transcript_path, but its shape is not
    // Claude Code's JSONL, which is the only shape `transcript.ts` reads.
    writeFileSync(path, "not claude code jsonl\n");
    const session = fakeSession("s1", path, { harness: "codex" });
    const { instance, recorded } = tailer([session]);
    await instance.tick();
    await instance.tick();
    expect(session.lines).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("still tails a session with no harness recorded (Claude Code's own default)", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    writeFileSync(path, "a\n");
    const session = fakeSession("s1", path);
    const { instance } = tailer([session]);
    await instance.tick();
    expect(session.lines.map((l) => l.line)).toEqual(["a"]);
  });

  it("skips drain and subagent ingestion for a harness with no normalizer too", async () => {
    const dir = scratch();
    const path = join(dir, "s.jsonl");
    const subPath = join(dir, "sub.jsonl");
    writeFileSync(path, "a\n");
    writeFileSync(subPath, "b\n");
    const session = fakeSession("s1", path, { harness: "cursor" });
    const { instance } = tailer([session]);
    await instance.drain("s1");
    expect(session.lines).toEqual([]);
    const fed = await instance.ingestSubagentTranscript("s1", "child", subPath);
    expect(fed).toBeUndefined();
    expect(session.lines).toEqual([]);
  });
});
