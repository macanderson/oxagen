// `readWholeTranscript` and `isWhole`: the Policy, Context and Cost tabs read
// the run to its end rather than taking the first page as the run.
import { describe, expect, it, vi } from "vitest";
import {
  type RunTranscript,
  TRANSCRIPT_ENTRY_DEFAULT,
} from "@/data/contracts/run";
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
    // Every page is new and names a new cursor, so only the bound stops it.
    let n = 0;
    const { source, transcript } = sourceOf(() => {
      n += 1;
      return readOk(page(n * TRANSCRIPT_ENTRY_DEFAULT, TRANSCRIPT_ENTRY_DEFAULT, `more-${String(n)}`));
    });
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps");
    // The reader's page bound: the contract's 10,000-frame cap at the default
    // page size.
    expect(transcript).toHaveBeenCalledTimes(50);
    expect(read.ok && read.value.entries).toHaveLength(50 * TRANSCRIPT_ENTRY_DEFAULT);
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  it("stops when the server answers a cursor it answered before", async () => {
    // A full page that names the same cursor every time would read the same
    // page fifty times and list its entries fifty times over.
    const { source, transcript } = sourceOf(() =>
      readOk(page(0, TRANSCRIPT_ENTRY_DEFAULT, "same")),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "steps");
    expect(transcript).toHaveBeenCalledTimes(2);
    expect(read.ok && read.value.entries).toHaveLength(TRANSCRIPT_ENTRY_DEFAULT);
    expect(read.ok && isWhole(read.value)).toBe(false);
  });

  it("lists an entry the server sent again once, as its grown copy, where it stood", async () => {
    const full = TRANSCRIPT_ENTRY_DEFAULT;
    const grown = transcriptEntry({ seq: "5", endSeq: String(full + 1), label: "Bash ok" });
    const { source } = sourceOf((after) =>
      after === undefined
        ? readOk(page(0, full, "p2"))
        : readOk(
            runTranscript({
              entries: [grown, transcriptEntry({ seq: String(full), endSeq: String(full) })],
              cursor: null,
            }),
          ),
    );
    const read = await readWholeTranscript(source, ctx, "tse_1", "everything");
    if (!read.ok) throw new Error("expected a read");
    expect(read.value.entries).toHaveLength(full + 1);
    expect(read.value.entries[5]).toEqual(grown);
    expect(read.value.entries.filter((entry) => entry.seq === "5")).toHaveLength(1);
    expect(read.value.entries.at(-1)?.seq).toBe(String(full));
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
