// The Governed actions tab (mockup `pRun`'s player, pages/run.md "Governed
// actions"): the Timeline, the frame player bar, then the open frame beside
// the frame list. The tab reads "Player" on a run with no policy decision;
// the tab strip names it, and this draws the same thing either way.
//
// The open frame is `?body=<seq>`, or `?body=<chain>:<seq>` for a subagent's
// frame (#3823), and the first frame shown when the URL names none.
// `GovernedActionsTab` makes the tab's own reads (the open frame's body,
// the approvals recorded on the run, the mandate ledger when a parked call
// names a mandate, and the delivery report when the open frame records an
// operator's command) and returns the view; the page calls it as a function,
// so it calls no hook itself and every component it returns is synchronous.
import type {
  ApprovalItem,
  ApprovalQueue,
  ResolvedApprovalItem,
  ResolvedApprovals,
} from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import type { RunFrameBody, TranscriptEntry } from "@/data/contracts/run";
import type { CommandReport } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { WsCtx } from "@/server/viewer";
import { routes, type SafePath } from "@/shared/safe-path";
import { ControlInspector } from "./control-inspector";
import { frameKey } from "./frame-link";
import { FrameList, FramePanel, FramesEmpty, FramesPager } from "./frames";
import { PlayerBar } from "./player-bar";
import {
  type ControlCommand,
  controlOf,
  entriesBySeq,
  isApprovalFrame,
  kindOf,
  markOf,
  matchApprovals,
  type OpenFrame,
  openFrameOf,
  runStateOf,
  stepsOf,
  tickPositions,
  timelineMarks,
  turnBands,
  decisionOf,
} from "./player-model";
import { ParkedElsewhere, ParkedHere } from "./parked-calls";
import { DecidedApprovals } from "./resolved-approvals";
import type { FrameTabProps } from "./tab-props";
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
 * nothing to read. A subagent's frame is read by its chain and seq.
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
  if (!retained) return null;
  return open.chainRef === undefined
    ? source.runs.frameBody(ctx, runId, open.seq)
    : source.runs.frameBody(ctx, runId, open.seq, open.chainRef);
}

/**
 * The operator's command the open frame records, or null for any other frame
 * (`controlOf`). A frame off this page is read by the type its transcript
 * entry carries.
 */
function openCommand(
  open: OpenFrame | null,
  entries: ReadonlyMap<string, TranscriptEntry>,
): ControlCommand | null {
  if (open === null) return null;
  const entry = entries.get(open.seq);
  const type = open.frame?.type ?? entry?.type ?? null;
  return type === null ? null : controlOf(type, entry);
}

/**
 * The delivery report, read only while the open frame records an operator's
 * command, so its inspector can say how that command was asked for and how it
 * was carried (#2953). Every other frame makes no read.
 */
function readCommands(
  source: DataSource,
  ctx: WsCtx,
  runId: string,
  command: ControlCommand | null,
): Promise<Read<CommandReport> | null> {
  return command === null
    ? Promise.resolve(null)
    : source.runs.commands(ctx, { runId });
}

export async function GovernedActionsTab(props: FrameTabProps) {
  const { ctx, source, run, detail, view, now, everything } = props;
  const open = openFrameOf(detail.frames.frames, view.body);
  const command = openCommand(open, entriesBySeq(everything));
  const [body, approvals, commands] = await Promise.all([
    readBody(source, ctx, run.id, open),
    readApprovals(source, ctx, run.id, now),
    readCommands(source, ctx, run.id, command),
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
      command={command}
      commands={commands}
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
  command,
  commands,
}: {
  props: FrameTabProps;
  open: OpenFrame | null;
  body: Read<RunFrameBody> | null;
  pending: Read<ApprovalQueue>;
  resolved: Read<ResolvedApprovals>;
  mandates: ReadonlyMap<string, MandateRow>;
  now: number;
  /** The operator's command the open frame records; null for any other frame. */
  command: ControlCommand | null;
  /** The delivery report, read only when `command` is set. */
  commands: Read<CommandReport> | null;
}) {
  const { run, detail, view, place, everything, metrics } = props;
  const page = detail.frames;
  const frames = page.frames;
  const cursor = view.frames;
  // A frame's key: its seq on the run's own chain, which every frame of the
  // page is on, and `<chain>:<seq>` on a subagent's.
  const hrefOf = (key: string): SafePath =>
    routes.run(place.org, place.ws, place.runId, {
      tab: "actions",
      ...(cursor === null ? {} : { frames: cursor }),
      body: key,
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
  // The open frame's seq on the page's own chain. A subagent's frame shares
  // its seq with a different frame here, so it matches no approval and marks
  // no tick or row as open.
  const openSeq =
    open === null || open.chainRef !== undefined ? null : open.seq;
  const hereItem = openSeq === null ? undefined : matches.byFrame.get(openSeq);
  const parkedHere =
    hereItem === undefined || isDecided(hereItem) ? null : hereItem;
  const unmatched = pendingItems.filter(
    (item) => !matches.matched.has(item.id),
  );
  const elsewhere = [...matches.byFrame.entries()].flatMap(([seq, item]) =>
    seq === openSeq || isDecided(item) ? [] : [{ item, seq }],
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
  const entry: TranscriptEntry | undefined = entries.get(frameKey(open));
  const xs = tickPositions(frames);
  const steps = stepsOf(frames, open);
  const target = (seq: string | null) => (seq === null ? null : hrefOf(seq));
  const approvalFrame =
    open.frame !== null &&
    isApprovalFrame(open.frame.type, open.frame.toolStatus);
  // The model frame after a steer on this page: the call that carried it.
  const carrierFrame =
    open.index < 0
      ? undefined
      : frames
          .slice(open.index + 1)
          .find((frame) => kindOf(frame.type) === "model");

  return (
    <>
      <RunTimeline
        frames={frames}
        xs={xs}
        bands={turnBands(frames, xs, entries)}
        marks={timelineMarks(frames, xs, entries)}
        entries={entries}
        total={run.frames}
        openSeq={openSeq}
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
        marks={frames.map((frame) =>
          markOf(
            frame.type,
            decisionOf(entries.get(frame.seq)),
            frame.toolStatus,
          ),
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
            control={
              command === null || commands === null ? null : (
                <ControlInspector
                  command={command}
                  seq={open.seq}
                  read={commands}
                  carrier={
                    carrierFrame === undefined
                      ? null
                      : {
                          seq: carrierFrame.seq,
                          href: hrefOf(carrierFrame.seq),
                        }
                  }
                  org={place.org}
                  ws={place.ws}
                  runId={place.runId}
                />
              )
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
          openSeq={openSeq}
          hrefOf={hrefOf}
          state={runStateOf(run)}
        />
      </div>
    </>
  );
}
