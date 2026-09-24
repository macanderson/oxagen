// The Governed actions tab (mockup `pRun`'s player, pages/run.md): the
// timeline, the frame player, the open frame and the frame list.
import { readOk } from "@/data/read";
import { FramesSection } from "./frames";
import type { RunTabProps } from "./tab-props";

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

export async function GovernedActionsTab({
  ctx,
  source,
  run,
  detail,
  view,
  place,
}: RunTabProps) {
  const seq =
    view.body !== null && FRAME_SEQ.test(view.body) ? view.body : null;
  return (
    <FramesSection
      read={readOk(detail)}
      frames={view.frames}
      body={
        seq === null
          ? null
          : { seq, read: await source.runs.frameBody(ctx, run.id, seq) }
      }
      {...place}
    />
  );
}
