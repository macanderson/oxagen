// How the Run page names one frame of a run: in `?body=`, which opens the
// frame on the Governed actions tab, and in the map the tab reads each
// frame's transcript entry from.
//
// A run's own frame is its seq. A subagent records on a chain of its own,
// numbered from 0 like the run's, so a subagent's seq also names a different
// frame of the run. Its frame is `<chain>:<seq>`, the key the transcript
// gives it (`TranscriptEntry.key`), and `get_run_frame_body` reads it by the
// chain and the seq together (#3823).
import { routes, type SafePath } from "@/shared/safe-path";
import type { Place } from "./tab-props";

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

/** A chain's session uuid, as `get_run_transcript` names it. */
const CHAIN_REF =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One frame of a run: its seq, and the subagent chain it was recorded on.
 * `chainRef` is absent or null on the run's own chain.
 */
export type FrameAt = { seq: string; chainRef?: string | null };

/** The frame's key: its seq on the run's own chain, `<chain>:<seq>` on a subagent's. */
export function frameKey(frame: FrameAt): string {
  return frame.chainRef === undefined || frame.chainRef === null
    ? frame.seq
    : `${frame.chainRef}:${frame.seq}`;
}

/**
 * The frame a `?body=` value names, or null for anything else: a decimal
 * seq, or a chain's session uuid and a seq joined by a colon.
 */
export function parseFrameKey(
  value: string | null,
): { seq: string; chainRef?: string } | null {
  if (value === null) return null;
  const colon = value.lastIndexOf(":");
  if (colon < 0) return FRAME_SEQ.test(value) ? { seq: value } : null;
  const chainRef = value.slice(0, colon).toLowerCase();
  const seq = value.slice(colon + 1);
  return CHAIN_REF.test(chainRef) && FRAME_SEQ.test(seq)
    ? { seq, chainRef }
    : null;
}

/** The link that opens the frame on the Governed actions tab. */
export function frameHref(place: Place, frame: FrameAt): SafePath {
  return routes.run(place.org, place.ws, place.runId, {
    tab: "actions",
    body: frameKey(frame),
  });
}
