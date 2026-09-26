// `readWholeTranscript` and `isWhole`: the Transcript tab, Policy and Context
// read the run to its end rather than taking the first page as the run, at the
// largest page the contract allows, with each entry once, and the counts and
// figures the server sent with the last page.
import { describe, expect, it, vi } from "vitest";
import { type RunTranscript, TRANSCRIPT_ENTRY_MAX } from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import { readError, readOk, type Read } from "@/data/read";
import { WsCtx } from "@/server/viewer";
import { unsafeMint } from "@/server/viewer.testing";
import { runTranscript, transcriptEntry } from "./run.builders";
import { isWhole, readWholeTranscript } from "./whole-transcript";

const ctx = unsafeMint(WsCtx, {
  userId: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

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
  const transcript = vi.fn<DataSource["runs"]["transcript"]>(
    (_ctx, _runId, _zoom, q) => Promise.resolve(answer(q?.after)),
  );
  return { source: { runs: { transcript } }, transcript };
}

describe("readWholeTranscript", () => {
  it("asks every page for the bodies the caller wants, and keeps the last page's counts and figures", async () => {
    const full = TRANSCRIPT_ENTRY_MAX;
    const counted = (entries: number) => ({
      kinds: {
        prompt: 1,
        responses: 0,
        thinking: 0,
        tools: 0,
        policy: 0,
        usage: 0,
        recall: 0,
        seal: 0,
        errors: 0,
      },
      entries,
      errors: 0,
      policy: 0,
      frames: null,
    });
    const { source, transcript } = sourceOf((after) =>
      after === undefined
        ? readOk({ ...page(0, full, "p2"), counts: counted(full) })
        : readOk({ ...page(full, 3, null), counts: counted(full + 3) }),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps", {
      text: "full",
    });
    expect(transcript.mock.calls.map((call) => call[3])).toEqual([
      { kinds: [], limit: 500, text: "full" },
      { kinds: [], limit: 500, text: "full", after: "p2" },
    ]);
    // A live run's later page counts what was recorded since the first.
    expect(read.ok && read.value.counts?.entries).toBe(full + 3);
  });

  it("reads page after page to the end, narrowed to the chip asked for", async () => {
    const full = TRANSCRIPT_ENTRY_MAX;
    const { source, transcript } = sourceOf((after) =>
      after === undefined
        ? readOk(page(0, full, "p2"))
        : readOk(page(full, 3, null)),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "everything", {
      kinds: ["policy"],
    });
    expect(read.ok && read.value.entries).toHaveLength(full + 3);
    expect(read.ok && isWhole(read.value)).toBe(true);
    expect(transcript).toHaveBeenCalledTimes(2);
    expect(transcript.mock.calls[0]?.[3]).toEqual({
      kinds: ["policy"],
      limit: 500,
    });
    expect(transcript.mock.calls[1]?.[3]).toEqual({
      kinds: ["policy"],
      after: "p2",
      limit: 500,
    });
  });

  it("keeps an entry a later page sends again once, in its place, as the later page has it", async () => {
    const full = TRANSCRIPT_ENTRY_MAX;
    const first = page(0, full, "p2");
    const grown = transcriptEntry({ seq: "5", endSeq: "900", frames: 9 });
    const { source } = sourceOf((after) =>
      after === undefined
        ? readOk(first)
        : readOk(
            runTranscript({
              entries: [
                grown,
                transcriptEntry({ seq: String(full), endSeq: String(full) }),
              ],
              cursor: null,
            }),
          ),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps");
    if (!read.ok) throw new Error("the read answers");
    expect(read.value.entries).toHaveLength(full + 1);
    expect(read.value.entries[5]).toEqual(grown);
    expect(read.value.entries.at(-1)?.seq).toBe(String(full));
  });

  it("stops at the page bound and says the list is a prefix (negative)", async () => {
    const { source, transcript } = sourceOf(() =>
      readOk(page(0, TRANSCRIPT_ENTRY_MAX, "more")),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps");
    // The reader's page bound: the contract's 10,000-frame cap at the largest
    // page it allows.
    expect(transcript).toHaveBeenCalledTimes(20);
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  it("keeps what it read when a later page fails, and says it stops short", async () => {
    const { source } = sourceOf((after) =>
      after === undefined
        ? readOk(page(0, TRANSCRIPT_ENTRY_MAX, "p2"))
        : readError("frame_store_unreachable", 502),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "turns");
    expect(read.ok && read.value.entries).toHaveLength(TRANSCRIPT_ENTRY_MAX);
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  // #4343 review: every page answers the head of the run's fold, so a read
  // that stopped short handed the stream the head, and on a quiet live run
  // nothing paged the missing tail in.
  it("answers no frame cursor when it stops short, so the stream replays and pages the rest in", async () => {
    const withHead = (read: RunTranscript) => ({ ...read, frameCursor: "f9" });
    const failed = await readWholeTranscript(
      sourceOf((after) =>
        after === undefined
          ? readOk(withHead(page(0, TRANSCRIPT_ENTRY_MAX, "p2")))
          : readError("frame_store_unreachable", 502),
      ).source,
      ctx,
      "tse_1",
      "steps",
    );
    expect(failed.ok && failed.value.frameCursor).toBeNull();
    const bounded = await readWholeTranscript(
      sourceOf(() => readOk(withHead(page(0, TRANSCRIPT_ENTRY_MAX, "more"))))
        .source,
      ctx,
      "tse_1",
      "steps",
    );
    expect(bounded.ok && bounded.value.frameCursor).toBeNull();
  });

  it("keeps the frame cursor when it read to the head, a live run's short page included (negative)", async () => {
    const live = await readWholeTranscript(
      sourceOf((after) =>
        after === undefined
          ? readOk({
              ...page(0, TRANSCRIPT_ENTRY_MAX, "p2"),
              frameCursor: "f9",
            })
          : readOk({
              ...page(TRANSCRIPT_ENTRY_MAX, 2, "live"),
              frameCursor: "f9",
            }),
      ).source,
      ctx,
      "tse_1",
      "steps",
    );
    expect(live.ok && live.value.frameCursor).toBe("f9");
    const ended = await readWholeTranscript(
      sourceOf(() => readOk({ ...page(0, 3, null), frameCursor: "f2" })).source,
      ctx,
      "tse_1",
      "steps",
    );
    expect(ended.ok && ended.value.frameCursor).toBe("f2");
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
