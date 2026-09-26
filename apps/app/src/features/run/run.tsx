// The Run page (mockup `pRun`, pages/run.md in the roadmap repository): the
// header, then two columns. The main column, two thirds wide, holds the
// generated summary, the six figures and the tabs with Transcript open; the
// side column, "The work", holds the Changes panel and the Outputs spine.
//
// The page makes the reads every part shares (the run, the whole-run
// transcript at `steps`, the cost rollup, the outputs, the work, the agent
// and the approvals parked on the run), shapes the figures once
// (`runMetrics`), and hands the open tab the whole bundle. The transcript is
// folded and counted on the server (ADR-182): the tab counts are its
// `counts`, and the figures its `figures`. The run at `everything`, one entry
// per frame, is read to its end only for a tab that lists frames. The badges
// of those tabs count frames, and the `steps` read carries those counts too
// (`counts.frames`), so no other tab reads the run a second time. A tab's own
// heavy read (the chain, a frame body) happens only when that tab is open.
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, type ReactNode } from "react";
import type { DataSource } from "@/data/ports";
import type { TranscriptCounts } from "@/data/contracts/run";
import { PAGE_FAILURES, readError } from "@/data/read";
import { PageRecord } from "@/features/shell";
import type { WsCtx } from "@/server/viewer";
import { Money } from "@/ui/money";
import { GovernedActionsTab } from "./actions-tab";
import { ChainTab } from "./chain";
import { CostTab } from "./cost";
import { RunHeader } from "./header";
import { IssuesCount } from "./issues-tab";
import { runMetrics } from "./metrics";
import { OutputsSpine } from "./outputs";
import { ContextTab, IssuesTab, PolicyTab } from "./sections";
import { RunDenied, RunEmpty, RunError, RunPending } from "./states";
import { StatRow, SummaryPanel } from "./stats";
import type { FrameTabProps, RunTabProps } from "./tab-props";
import {
  RUN_TAB_PANEL,
  RunTabs,
  runTabId,
  type Tab,
  type TabFigure,
  tabOf,
} from "./tabs";
import { parseKinds, TranscriptTab } from "./transcript";
import { readWholeTranscript } from "./whole-transcript";
import { ChangesLoading, ChangesPanel } from "./work";
import { readRunWork } from "./work-ci";

/** The tab strip, with what each tab carries beside its name, from the reads the page already made. */
function Tabs({
  props,
  parked,
  selected,
}: {
  props: RunTabProps;
  /** A call is parked for approval on this run. */
  parked: boolean;
  selected: Tab;
}) {
  const t = useTranslations("run.tabs");
  const { run, transcript, metrics, view, place } = props;
  // The server counts over every frame a read folded. A read that stopped at
  // its frame cap counted a prefix of the run, so its count is a floor.
  const countOf = (
    pick: (counts: TranscriptCounts) => number | null,
  ): string | undefined => {
    if (!transcript.ok || transcript.value.counts === null) return undefined;
    const count = pick(transcript.value.counts);
    if (count === null) return undefined;
    return transcript.value.complete ? String(count) : t("atLeast", { count });
  };
  // The tabs that list frames count frames, which the `steps` read carries
  // as `counts.frames`.
  const decisions = transcript.ok
    ? (transcript.value.counts?.frames?.kinds.policy ?? null)
    : null;
  // A run with no policy decision has nothing governed to list: the tab is
  // the frame player, and it counts the frames.
  const governed = decisions !== null && decisions > 0;
  const figures: Record<Tab, TabFigure> = {
    // The entries the Transcript tab draws, which its header line counts
    // too, so the tab and the line cannot disagree.
    transcript: { count: countOf((counts) => counts.entries) },
    // The task reference now, and the issues the run's pull requests close
    // once GitHub answers; the table under the tab counts the same rows.
    issues: {
      count: (
        <Suspense
          fallback={t("atLeast", { count: run.taskRef === null ? 0 : 1 })}
        >
          <IssuesCount run={run} work={props.work} />
        </Suspense>
      ),
    },
    actions: governed
      ? {
          count: countOf((counts) => counts.frames?.kinds.policy ?? null),
          parked,
        }
      : { label: t("player"), count: String(run.frames), parked },
    cost: {
      count: metrics.cost === null ? undefined : <Money value={metrics.cost} />,
      money: true,
    },
    // The rows the Policy table lists: the harness's own checks fold below
    // it and are not counted here.
    policy: {
      count: countOf((counts) => counts.frames?.policy ?? null),
      parked,
    },
    context: {
      count: countOf((counts) => counts.frames?.kinds.recall ?? null),
    },
    chain: { count: t(`status.${run.sealedAt === null ? "live" : "sealed"}`) },
  };
  return (
    <RunTabs
      selected={selected}
      figures={figures}
      kinds={view.kinds}
      place={place}
    />
  );
}

/**
 * The open tab's body. Each tab is a function the page awaits, not an
 * element it renders: a tab makes its own reads and answers the tree of
 * synchronous components those reads fill, so the page renders the same way
 * on the server and in a test.
 */
function sectionOf(
  tab: Tab,
  props: RunTabProps,
): Promise<ReactNode> | ReactNode {
  switch (tab) {
    case "transcript":
      return TranscriptTab(props);
    case "issues":
      return IssuesTab(props);
    case "actions":
      return withFrames(props).then(GovernedActionsTab);
    case "cost":
      return CostTab(props);
    case "policy":
      return withFrames(props).then(PolicyTab);
    case "context":
      return withFrames(props).then(ContextTab);
    case "chain":
      return ChainTab(props);
  }
}

/**
 * The props with the run at `everything`, for a tab that lists frames. The
 * page reads it with its other reads when such a tab is open, so this reads
 * it only for a caller that did not.
 */
async function withFrames(props: RunTabProps): Promise<FrameTabProps> {
  const everything =
    props.everything ??
    (await readWholeTranscript(
      props.source,
      props.ctx,
      props.run.id,
      "everything",
    ));
  return { ...props, everything };
}

/**
 * `get_run`, and the instant it answered. `Date.now()` lives here rather
 * than in the component: a component's render must be pure, and an async
 * read function is not a render. The error state prints the instant. `fixed`
 * is how a test pins it.
 */
async function readRun(
  source: DataSource,
  ctx: WsCtx,
  runId: string,
  frames: string | null,
  fixed: number | undefined,
) {
  const read = await source.runs.get(ctx, runId, { framesAfter: frames });
  return { read, at: fixed ?? Date.now() };
}

export async function Run({
  ctx,
  source,
  runId,
  tab,
  kinds,
  frames,
  body,
  reads,
  spine,
  now,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The run's public id, as the URL names it (`arun_…` or `tse_…`). */
  runId: string;
  /** `?tab=`; anything but a tab's name or an old alias opens Transcript. */
  tab: string | null;
  /** `?kinds=`, the chips a link opens with, comma-separated, or `none`; an unknown word is dropped. */
  kinds: string | null;
  /** `?frames=`, the opaque cursor a later frames page was read from. */
  frames: string | null;
  /**
   * `?body=`, the frame whose body is open: its seq, or `<chain>:<seq>` for a
   * subagent's frame. Anything else opens none.
   */
  body: string | null;
  /** `?reads=hide` folds the spine's read marks away. */
  reads: string | null;
  /** `?spine=`, the spine groups a person opened, comma-separated. */
  spine: string | null;
  /** Pins the instant a clock counts from. Only a test passes it. */
  now?: number;
}) {
  const selected = tabOf(tab);
  const view = {
    kinds: parseKinds(kinds),
    frames,
    body,
  };
  const { read, at } = await readRun(source, ctx, runId, frames, now);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    if (read.reason === "denied")
      return <RunDenied permission={read.permission} ctx={ctx} />;
    if (read.reason === "pending_approval")
      return <RunPending accessRequestId={read.accessRequestId} />;
    return (
      <RunError
        code={read.code}
        status={read.status}
        ws={ctx.wsSlug}
        readAt={at}
      />
    );
  }
  const detail = read.value;
  const run = detail.run;
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug, runId: run.id };
  // The run the assistant is asked about, by the id the URL names and the
  // title the header prints (`When`): its name, else its task reference.
  const record = (
    <PageRecord route="runs" id={runId} label={run.name ?? run.taskRef} />
  );
  if (run.frames === 0)
    return (
      <>
        {record}
        <RunEmpty run={run} org={place.org} ws={place.ws} />
      </>
    );
  const agentSlug = run.agentKey?.split(".").at(-1) ?? null;
  // Started, never awaited here: provider latency (GitHub pull requests,
  // checks, diffs) streams inside the boundaries that draw it and cannot hold
  // the rest of the page.
  const work = readRunWork(ctx, source, run.id);
  // The tabs that list the run's frames read them to their end. Every other
  // tab needs only their counts, which the `steps` read carries.
  const listsFrames =
    selected === "actions" || selected === "policy" || selected === "context";
  const [outputs, transcript, everything, cost, pending, agent, roster] =
    await Promise.all([
      // A thrown outputs read folds to the Run page's own read error, so the
      // spine says the read failed rather than the page throwing.
      source.runs
        .outputs(ctx, run.id)
        .catch(() =>
          readError(
            PAGE_FAILURES.run.error.code,
            PAGE_FAILURES.run.error.status,
          ),
        ),
      readWholeTranscript(source, ctx, run.id, "steps", { text: "full" }),
      listsFrames
        ? readWholeTranscript(source, ctx, run.id, "everything")
        : null,
      source.runs.cost(ctx, run.id),
      source.approvals.pending(ctx, { runId: run.id }),
      agentSlug === null ? null : source.agents.get(ctx, agentSlug),
      // The agent card's 30-day runs and spend are the Agents table's row. An
      // agent past the first page, or a refused read, draws the card without
      // them rather than a figure nobody read.
      run.agentKey === null
        ? null
        : source.agents
            .list(ctx, { cursor: null })
            .then((answer) =>
              answer.ok
                ? (answer.value.agents.find(
                    (row) => row.agentKey === run.agentKey,
                  ) ?? null)
                : null,
            )
            .catch(() => null),
    ]);
  const metrics = runMetrics({ run, cost, transcript, now: at });
  const props: RunTabProps = {
    ctx,
    source,
    run,
    detail,
    place,
    view,
    metrics,
    transcript,
    everything,
    cost,
    outputs,
    work,
    agent,
    now,
  };
  const parked = pending.ok && pending.value.items.length > 0;
  const section = await sectionOf(selected, props);
  return (
    <div data-testid="run-page" className="flex flex-col">
      {record}
      <RunHeader
        run={run}
        agent={agent}
        roster={roster}
        work={work}
        pulls={
          outputs.ok
            ? outputs.value.nodes.filter((node) => node.kind === "pr")
            : null
        }
        metrics={metrics}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        place={place}
        parked={parked}
      />
      <div className="grid grid-cols-1 items-start gap-3.5 min-[67.5rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col">
          <SummaryPanel
            run={run}
            agent={agent}
            place={place}
            orgRole={ctx.orgRole}
            canEditEnrichment={
              ["owner", "admin"].includes(ctx.orgRole) ||
              ["owner", "admin"].includes(ctx.wsRole)
            }
          />
          <StatRow run={run} metrics={metrics} />
          <Tabs props={props} parked={parked} selected={selected} />
          <div
            id={RUN_TAB_PANEL}
            role="tabpanel"
            aria-labelledby={runTabId(selected)}
            data-testid={`run-tab-${selected}`}
            className="flex flex-col gap-3.5"
          >
            {section}
          </div>
        </div>
        <RunSide>
          <Suspense fallback={<ChangesLoading />}>
            <ChangesPanel
              work={work}
              outputs={outputs}
              run={run}
              place={place}
            />
          </Suspense>
          <OutputsSpine
            read={outputs}
            reads={reads}
            spine={spine}
            live={run.status === "live"}
            {...place}
          />
        </RunSide>
      </div>
    </div>
  );
}

/** `.run-side`: the work the run touched, beside the main column. */
function RunSide({ children }: { children: ReactNode }) {
  const t = useTranslations("run.work");
  return (
    <aside aria-label={t("label")} className="grid min-w-0 gap-3">
      {children}
    </aside>
  );
}
