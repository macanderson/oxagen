"use client";
// The empty-Transcript follower. It carries JSX, so it sits beside the hook
// rather than inside it: `use-run-stream.ts` has no JSX and stays a `.ts`
// module, which is what it was before this follower gained a refusal line.
import { useTranslations } from "next-intl";
import { useNavigate } from "@/ui/navigation";
import { useRunStream } from "./use-run-stream";
import { useStaleRefresh } from "./use-stale-refresh";

/**
 * Keep a live run's empty Transcript tab subscribed to the stream. Without
 * this, an empty filter (or a run with no frames yet) renders a static panel
 * and never mounts the player that opens EventSource, so later matching
 * frames never appear. A frame landing re-reads the page so the first
 * matching entry can mount the full player. The stream opens after `after`,
 * the last frame the page's read folded, so frames the chips hid are not
 * sent again. When the row the stream opens with reads stale and the page
 * does not, or the other way round, the page is read again.
 */
export function LiveEmptyFollow({
  org,
  ws,
  runId,
  after = null,
  stale = false,
}: {
  org: string;
  ws: string;
  runId: string;
  /** The transcript's `frameCursor`; null opens at the run's first frame. */
  after?: string | null;
  /** Whether the page reads the run stale (`isStale`). */
  stale?: boolean;
}) {
  const navigate = useNavigate();
  const t = useTranslations("run.transcript");
  const staleRefresh = useStaleRefresh(stale);
  const stream = useRunStream({
    url: `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(
      ws,
    )}/runs/${encodeURIComponent(runId)}/stream`,
    after,
    enabled: true,
    onFrames: () => {
      navigate.refresh();
    },
    onRun: staleRefresh.onRun,
  });
  if (stream !== "denied" && stream !== "lost") return null;
  return (
    <p role="alert" className="mt-2 text-sm text-muted-foreground">
      {t(stream === "denied" ? "followDenied" : "followLost")}
    </p>
  );
}
