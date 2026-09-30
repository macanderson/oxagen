/**
 * A tick reads a transcript outside the session's queue and seals what it
 * read inside it (ADR-231). A host task queued ahead of the seal can replace
 * the session's record: `registry.restore` builds a new record and recorder
 * for every session it restores. A seal through the old recorder would write
 * past the chain the new one holds, and the WAL would refuse every later seal
 * on that chain. The tick seals only through a record the registry still
 * lists, and the next tick reads the same lines through the new one.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TachoEvent } from "../envelope";
import type { FrameBody } from "../evidence/frame-body";
import { type TailedSession, TranscriptTailer } from "./transcript-tailer";

/** A recorder that only remembers the lines it was handed. */
function fakeSession(id: string, transcriptPath: string) {
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
    sealed: false,
    recorder: recorder as unknown as TailedSession["recorder"],
  };
  return { session, lines };
}

describe("a record the registry replaced while the tick read", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
  });

  it("seals nothing through the old record, and the next tick seals through the new one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tacho-tail-replaced-"));
    dirs.push(dir);
    const transcript = join(dir, "s1.jsonl");
    writeFileSync(transcript, '{"n":1}\n');
    const old = fakeSession("s1", transcript);
    const fresh = fakeSession("s1", transcript);
    const listed: TailedSession[] = [old.session];
    const tailer = new TranscriptTailer({
      sessions: () => listed,
      session: (id) => listed.find((s) => s.harnessSessionId === id),
      record: () => undefined,
      // The host task queued ahead of the seal restores the registry, which
      // swaps in a new record for the same session.
      exclusive: async (_session, apply) => {
        listed[0] = fresh.session;
        return apply();
      },
    });

    await tailer.tick();
    expect(old.lines).toEqual([]);
    expect(fresh.lines).toEqual([]);

    await tailer.tick();
    expect(fresh.lines).toEqual(['{"n":1}']);
    expect(old.lines).toEqual([]);
  });
});
