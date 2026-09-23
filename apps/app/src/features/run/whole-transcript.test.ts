// `readWholeTranscript` and `isWhole`: the Policy, Context and Cost tabs read
// the run to its end rather than taking the first page as the run.
import { describe, expect, it, vi } from "vitest";
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_DEFAULT,
} from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import { readError, readOk, type Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { runTranscript, transcriptEntry } from "./run.builders";
import {
  isWhole,
  readWholeTranscript,
  WHOLE_TRANSCRIPT_PAGES,
} from "./whole-transcript";

const ctx = {} as WsCtx;

/** A full page of `count` entries named from `from`. */
function page(from: number, count: number, cursor: string | null) {
  return runTranscript({
    entries: Array.from({ length: count }, (_, i) =>
      transcriptEntry({ seq: String(from + i), endSeq: String(from + i) }),
    ),
    cursor,
  });
}

function sourceOf(
  answer: (after: string | null | undefined) => Read<RunTranscript>,
) {
  const transcript = vi.fn(
    (
      _ctx: WsCtx,
      _runId: string,
      _zoom: string,
      q?: { kinds?: string[]; after?: string | null },
    ) => Promise.resolve(answer(q?.after)),
  );
  return {
    source: { runs: { transcript } } as unknown as DataSource,
    transcript,
  };
}

describe("readWholeTranscript", () => {
  it("reads page after page to the end, narrowed to the chip asked for", async () => {
    const full = TRANSCRIPT_ENTRY_DEFAULT;
    const { source, transcript } = sourceOf((after) =>
      after === undefined
        ? readOk(page(0, full, "p2"))
        : readOk(page(full, 3, null)),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "everything", [
      "policy",
    ]);
    expect(read.ok && read.value.entries).toHaveLength(full + 3);
    expect(read.ok && isWhole(read.value)).toBe(true);
    expect(transcript).toHaveBeenCalledTimes(2);
    expect(transcript.mock.calls[1]?.[3]).toEqual({
      kinds: ["policy"],
      after: "p2",
    });
  });

  it("stops at the page bound and says the list is a prefix (negative)", async () => {
    const { source, transcript } = sourceOf(() =>
      readOk(page(0, TRANSCRIPT_ENTRY_DEFAULT, "more")),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps");
    expect(transcript).toHaveBeenCalledTimes(WHOLE_TRANSCRIPT_PAGES);
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  it("keeps what it read when a later page fails, and says it stops short", async () => {
    const { source } = sourceOf((after) =>
      after === undefined
        ? readOk(page(0, TRANSCRIPT_ENTRY_DEFAULT, "p2"))
        : readError("frame_store_unreachable", 502),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "turns");
    expect(read.ok && read.value.entries).toHaveLength(
      TRANSCRIPT_ENTRY_DEFAULT,
    );
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  it("answers a failed first read as the failure", async () => {
    const { source } = sourceOf(() =>
      readError("frame_store_unreachable", 502),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "turns");
    expect(read.ok).toBe(false);
  });

  it("stops on a short page of a live run, which still carries a cursor", async () => {
    const { source, transcript } = sourceOf(() => readOk(page(0, 2, "live")));
    const read = await readWholeTranscript(source, ctx, "tse_1", "everything");
    expect(transcript).toHaveBeenCalledTimes(1);
    // Still recording, so not the whole run.
    expect(read.ok && isWhole(read.value)).toBe(false);
  });
});

describe("isWhole", () => {
  it("is the frame cap and the cursor together", () => {
    expect(isWhole(runTranscript())).toBe(true);
    expect(isWhole(runTranscript({ complete: false }))).toBe(false);
    expect(isWhole(runTranscript({ cursor: "dDoy" }))).toBe(false);
  });
});
