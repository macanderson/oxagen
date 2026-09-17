/**
 * The per-seal archive segment (Mission Control spec §13.3): the frame
 * envelopes as NDJSON, one JCS line per frame in sequence order, compressed
 * with zstd and written once to the object store at seal time. The segment is
 * the same bytes the hot store indexed, and a compacted run is read from it.
 *
 * The Merkle root commits to the frames' own digests, never to the segment
 * bytes, so a verifier can recompute it from the lines alone; the segment
 * digest is over the compressed bytes exactly as stored, which is what the
 * attestation names.
 */
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";
import { digestBytes, jcs, type JsonValue, type Sha256Digest } from "../digest";
import { merkleRoot } from "./merkle";

export const ARCHIVE_SEGMENT_CONTENT_TYPE = "application/zstd";

export interface ArchiveFrame {
  /** The frame's own digest (`event_digest` on the ledger, `hash` on tacho). */
  digest: Sha256Digest;
  /** The envelope as it will be written; the bytes are not part of it. */
  envelope: JsonValue;
}

interface ArchiveSegment {
  bytes: Uint8Array;
  /** sha256 over `bytes` as stored. */
  segmentDigest: Sha256Digest;
  /** RFC 6962 root over the frame digests in order. */
  merkleRoot: Sha256Digest;
  frameCount: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function buildArchiveSegment(
  frames: readonly ArchiveFrame[],
): ArchiveSegment {
  const ndjson = frames.map((frame) => jcs(frame.envelope)).join("\n");
  const bytes = new Uint8Array(zstdCompressSync(encoder.encode(ndjson)));
  return {
    bytes,
    segmentDigest: digestBytes(bytes),
    merkleRoot: merkleRoot(frames.map((frame) => frame.digest)),
    frameCount: frames.length,
  };
}

/** The envelopes back out of a segment, in the order they were written. */
export function readArchiveSegment(bytes: Uint8Array): JsonValue[] {
  const text = decoder.decode(zstdDecompressSync(bytes));
  if (text.length === 0) return [];
  return text.split("\n").map((line) => JSON.parse(line) as JsonValue);
}
