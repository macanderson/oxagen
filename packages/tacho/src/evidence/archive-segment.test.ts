import { describe, expect, it } from "vitest";
import { digestBytes, digestJcs } from "../digest";
import { buildArchiveSegment, readArchiveSegment } from "./archive-segment";
import { merkleRoot } from "./merkle";

const frame = (seq: number) => {
  const envelope = { seq, kind: "tool_call", b: { z: 1, a: [seq] } };
  return { digest: digestJcs(envelope), envelope };
};

describe("buildArchiveSegment", () => {
  it("round-trips frames in order through zstd NDJSON", () => {
    const frames = [frame(0), frame(1), frame(2)];
    const segment = buildArchiveSegment(frames);
    expect(segment.frameCount).toBe(3);
    expect(readArchiveSegment(segment.bytes)).toEqual(
      frames.map((f) => f.envelope),
    );
  });

  it("commits to the frame digests, not the bytes", () => {
    const frames = [frame(0), frame(1)];
    const segment = buildArchiveSegment(frames);
    expect(segment.merkleRoot).toBe(merkleRoot(frames.map((f) => f.digest)));
    expect(segment.segmentDigest).toBe(digestBytes(segment.bytes));
  });

  it("writes canonical lines so the same frames give the same bytes", () => {
    const a = buildArchiveSegment([frame(0)]);
    const b = buildArchiveSegment([
      {
        digest: frame(0).digest,
        envelope: { b: { a: [0], z: 1 }, kind: "tool_call", seq: 0 },
      },
    ]);
    expect(a.segmentDigest).toBe(b.segmentDigest);
  });

  it("handles an empty stream", () => {
    const segment = buildArchiveSegment([]);
    expect(segment.frameCount).toBe(0);
    expect(readArchiveSegment(segment.bytes)).toEqual([]);
  });
});
