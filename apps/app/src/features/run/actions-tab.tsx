// The Governed actions tab (mockup `pRun`'s player, pages/run.md "Governed
// actions"): the Timeline, the frame player bar, then the open frame beside
// the frame list. The tab reads "Player" on a run with no policy decision;
// the tab strip names it, and this draws the same thing either way.
//
// The open frame is `?body=<seq>`, the first frame shown when the URL names
// none. `GovernedActionsTab` makes the tab's own reads (the open frame's body,
// the approvals recorded on the run, and the mandate ledger when a parked call
// names a mandate) and returns the view; the page calls it as a function, so
// it calls no hook itself and every component it returns is synchronous.
import type {
  ApprovalItem,
  ApprovalQueue,
  ResolvedApprovalItem,
  ResolvedApprovals,
} from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import type { RunFrameBody, TranscriptEntry } from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { FrameList, FramePanel, FramesEmpty, FramesPager } from "./frames";
import { PlayerBar } from "./player-bar";
import {
  entriesBySeq,
  isApprovalFrame,
  markOf,
  matchApprovals,
  type OpenFrame,
  openFrameOf,
  playbackGaps,
  runStateOf,
  stepsOf,
  tickPositions,
  timelineMarks,
  turnBands,
  decisionOf,
} from "./player-model";
import { ParkedElsewhere, ParkedHere } from "./parked-calls";
import { DecidedApprovals } from "./resolved-approvals";
import type { RunTabProps } from "./tab-props";
import { RunTimeline } from "./timeline";

/**
 * The approvals recorded on the run, the mandates their cards draw a bar
 * from, and the instant their clocks count from.
 *
 * The ledger is read only when a parked call names a mandate, the rule Fleet's
 * drawer follows, so a run whose parked calls drew on none makes no ledger
 * read, and a viewer who may not read the ledger sees the cards without their
 * bars. `Date.now()` lives here, in a read function, because a component's
 * render must be pure. `fixed` is how a test pins the clock.
 */
async function readApprovals(
  source: DataSource,
  ctx: WsCtx,
  runId: string,
  fixed: number | undefined,
) {
  const [pending, resolved] = await Promise.all([
    source.approvals.pending(ctx, { runId }),
    source.approvals.resolved(ctx, { runId }),
  ]);
  const mandates = new Map<string, MandateRow>();
  if (
    pending.ok &&
    pending.value.items.some((item) => item.mandateId !== null)
  ) {
    const read = await source.mandates.list(ctx, { agentId: null });
    if (read.ok)
      for (const mandate of read.value.mandates)
        mandates.set(mandate.id, mandate);
  }
  return { pending, resolved, mandates, now: fixed ?? Date.now() };
}

/**
 * The open frame's body, read on demand: when the URL names the frame, and the
 * frame retained bytes or this page does not hold its envelope. The first
 * frame shown opens with no read, and a frame that kept its digest alone has
 * nothing to read.
 */
async function readBody(
  source: DataSource,
  ctx: WsCtx,
  runId: string,
  open: OpenFrame | null,
): Promise<Read<RunFrameBody> | null> {
  if (open === null || !open.named) return null;
  const { frame } = open;
  const retained =
    frame === null ||
    (frame.body.digest !== null && frame.body.fidelity === "full");
  return retained ? source.runs.frameBody(ctx, runId, open.seq) : null;
}

export async function GovernedActionsTab(props: RunTabProps) {
  const { ctx, source, run, detail, view, now } = props;
  const open = openFrameOf(detail.frames.frames, view.body);
  const [body, approvals] = await Promise.all([
    readBody(source, ctx, run.id, open),
    readApprovals(source, ctx, run.id, now),
  ]);
  return (
    <GovernedActions
      props={props}
      open={open}
      body={body}
      pending={approvals.pending}
      resolved={approvals.resolved}
      mandates={approvals.mandates}
      now={approvals.now}
    />
  );
}

type Approval = ApprovalItem | ResolvedApprovalItem;

function isDecided(item: Approval): item is ResolvedApprovalItem {
  return "resolvedAt" in item;
}

function GovernedActions({
  props,
  open,
  body,
  pending,
  resolved,
  mandates,
  now,
}: {
  props: RunTabProps;
  open: OpenFrame | null;
  body: Read<RunFrameBody> | null;
  pending: Read<ApprovalQueue>;
  resolved: Read<ResolvedApprovals>;
  mandates: ReadonlyMap<string, MandateRow>;
  now: number;
}) {
  const { run, detail, view, place, everything, metrics } = props;
  const page = detail.frames;
  const frames = page.frames;
  const cursor = view.frames;
  const hrefOf = (seq: string): SafePath =>
    routes.run(place.org, place.ws, place.runId, {
      tab: "actions",
      ...(cursor === null ? {} : { frames: cursor }),
      body: seq,
    });
  const pager = (
    <FramesPager
      page={page}
      cursor={cursor}
      first={routes.run(place.org, place.ws, place.runId, { tab: "actions" })}
      later={(next) =>
        routes.run(place.org, place.ws, place.runId, {
          tab: "actions",
          frames: next,
        })
      }
    />
  );

  // Every approval on the run, pending and decided, matched to the frames on
  // the page as one set, so a frame is never claimed by two approvals.
  const pendingItems = pending.ok ? pending.value.items : [];
  const decidedItems = resolved.ok ? resolved.value.items : [];
  const matches = matchApprovals<Approval>(frames, [
    ...pendingItems,
    ...decidedItems,
  ]);
  const hereItem = open === null ? undefined : matches.byFrame.get(open.seq);
  const parkedHere =
    hereItem === undefined || isDecided(hereItem) ? null : hereItem;
  const unmatched = pendingItems.filter(
    (item) => !matches.matched.has(item.id),
  );
  const elsewhere = [...matches.byFrame.entries()].flatMap(([seq, item]) =>
    seq === open?.seq || isDecided(item) ? [] : [{ item, seq }],
  );
  const cards = { mandates, now, org: place.org, ws: place.ws };
  const parkedElsewhere = (
    <ParkedElsewhere
      pending={pending}
      unmatched={unmatched}
      elsewhere={elsewhere}
      cardShown={parkedHere !== null}
      hrefOf={hrefOf}
      {...cards}
    />
  );

  if (open === null)
    return (
      <>
        {parkedElsewhere}
        <FramesEmpty cursor={cursor} pager={pager} />
      </>
    );

  const entries = entriesBySeq(everything);
  const entry: TranscriptEntry | undefined = entries.get(open.seq);
  const xs = tickPositions(frames);
  const steps = stepsOf(frames, open);
  const target = (seq: string | null) => (seq === null ? null : hrefOf(seq));
  const approvalFrame = open.frame !== null && isApprovalFrame(open.frame.type);

  return (
    <>
      <RunTimeline
        frames={frames}
        xs={xs}
        bands={turnBands(frames, xs, entries)}
        marks={timelineMarks(frames, xs, entries)}
        entries={entries}
        total={run.frames}
        openSeq={open.seq}
        hrefOf={hrefOf}
        live={run.status === "live"}
        pager={pager}
      />
      <PlayerBar
        frames={frames}
        open={open}
        steps={{
          first: target(steps.first),
          prev: target(steps.prev),
          next: target(steps.next),
          last: target(steps.last),
        }}
        hrefs={frames.map((frame) => hrefOf(frame.seq))}
        gaps={playbackGaps(frames)}
        marks={frames.map((frame) =>
          markOf(frame.type, decisionOf(entries.get(frame.seq))),
        )}
        spent={entry?.cumulativeCost ?? null}
        total={metrics.cost}
        at={open.frame?.observedAt ?? entry?.at ?? null}
      />
      {/* `.split { grid-template-columns:minmax(0,1fr) 340px; gap:14px; align-items:start }`, one column under 1080px */}
      <div className="grid grid-cols-1 items-start gap-3.5 min-[67.5rem]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3.5">
          {parkedElsewhere}
          <FramePanel
            open={open}
            entry={entry}
            tier={run.enforcementTier}
            body={body}
            approvals={
              parkedHere !== null ? (
                <ParkedHere item={parkedHere} {...cards} />
              ) : approvalFrame ? (
                <DecidedApprovals
                  read={resolved}
                  here={
                    hereItem !== undefined && isDecided(hereItem)
                      ? hereItem
                      : null
                  }
                  others={decidedItems.filter(
                    (item) => !matches.matched.has(item.id),
                  )}
                />
              ) : null
            }
            steps={steps}
            hrefOf={hrefOf}
            shown={frames.length}
            total={run.frames}
          />
        </div>
        <FrameList
          frames={frames}
          entries={entries}
          openSeq={open.seq}
          hrefOf={hrefOf}
          state={runStateOf(run)}
        />
      </div>
    </>
  );
}
