/**
 * A resumed session reopens its drained transcript cursor. The registry
 * reopens a sealed chain when the harness resumes it under the same id, and
 * a cursor left drained read nothing more, so every model call of the
 * resumed session was lost. The cursor picks up where it stopped; one that
 * never read its file stays final.
 */
import {
  appendFileSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { sessionMapKey } from "./registry";
import { type TailedSession, TranscriptTailer } from "./transcript-tailer";

/** A session whose recorder remembers the lines it was handed. */
function resumedSession(id: string, transcriptPath: string) {
  const lines: string[] = [];
  const recorder = {
    ingestTranscriptLine(line: string): TachoEvent[] {
      lines.push(line);
      return [];
    },
    takeBodies(): FrameBody[] {
      return [];
    },
    markChain: () => ({}),
    rollbackChain: () => undefined,
    sealCollectorEvent: () => ({ kind: "telemetry_gap" }) as unknown,
  };
  const session: TailedSession = {
    harnessSessionId: id,
    transcriptPath,
    // Reopened by the resume: the registry holds it open again.
    sealed: false,
    recorder: recorder as unknown as TailedSession["recorder"],
  };
  return { session, lines };
}

describe("a resumed session's transcript cursor", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  /** A transcript and a tail state that holds its drained cursor. */
  function drainedAt(options: { read: boolean }) {
    const dir = mkdtempSync(join(tmpdir(), "tacho-tail-reopen-"));
    dirs.push(dir);
    const transcript = join(dir, "s1.jsonl");
    const before = '{"n":1}\n{"n":2}\n';
    writeFileSync(transcript, before);
    const statePath = join(dir, "transcript-tail.json");
    writeFileSync(
      statePath,
      JSON.stringify({
        schema: "tacho.transcript-tail.v1",
        cursors: {
          [sessionMapKey("s1")]: {
            path: transcript,
            ...(options.read
              ? {
                  offset: Buffer.byteLength(before),
                  ino: statSync(transcript).ino,
                }
              : { offset: 0 }),
            subagents: [],
            drained: true,
          },
        },
      }),
    );
    return { transcript, statePath };
  }

  it("reads what the resumed session writes, from where the cursor stopped", async () => {
    const { transcript, statePath } = drainedAt({ read: true });
    const { session, lines } = resumedSession("s1", transcript);
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => undefined,
      statePath,
    });
    appendFileSync(transcript, '{"n":3}\n');
    await tailer.tick();
    expect(lines).toEqual(['{"n":3}']);
    const cursor = tailer.state().cursors[sessionMapKey("s1")];
    expect(cursor?.drained).toBeUndefined();
    expect(cursor?.offset).toBe(statSync(transcript).size);
  });

  it("reads the resumed turn when a Stop drains it before any tick", async () => {
    const { transcript, statePath } = drainedAt({ read: true });
    const { session, lines } = resumedSession("s1", transcript);
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => undefined,
      statePath,
    });
    appendFileSync(transcript, '{"n":3}\n');
    await tailer.drain("s1");
    expect(lines).toEqual(['{"n":3}']);
  });

  it("keeps a cursor that never read its file final", async () => {
    const { transcript, statePath } = drainedAt({ read: false });
    const { session, lines } = resumedSession("s1", transcript);
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => undefined,
      statePath,
    });
    appendFileSync(transcript, '{"n":3}\n');
    await tailer.tick();
    expect(lines).toEqual([]);
    expect(tailer.state().cursors[sessionMapKey("s1")]?.drained).toBe(true);
  });

  it("leaves a sealed session's drained cursor alone", async () => {
    const { transcript, statePath } = drainedAt({ read: true });
    const { session, lines } = resumedSession("s1", transcript);
    session.sealed = true;
    const tailer = new TranscriptTailer({
      sessions: () => [session],
      session: () => session,
      record: () => undefined,
      statePath,
    });
    appendFileSync(transcript, '{"n":3}\n');
    await tailer.tick();
    expect(lines).toEqual([]);
    expect(tailer.state().cursors[sessionMapKey("s1")]?.drained).toBe(true);
  });
});
