// The entries of the whole-run transcript one chip answers to. The tab strip
// counts them and the Policy and Context tabs list them, from the one read the
// page made, so a count and its list cannot disagree.
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import type { Read } from "@/data/read";

/** The entries that answer to `kind`; null when the read failed, never an empty list. */
export function entriesOf(
  read: Read<RunTranscript>,
  kind: "policy" | "recall",
): TranscriptEntry[] | null {
  return read.ok
    ? read.value.entries.filter((entry) => entry.kinds.includes(kind))
    : null;
}
