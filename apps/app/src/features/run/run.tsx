import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, type ReactNode } from "react";
import { TranscriptZoom } from "@/data/contracts/run";
import type { TranscriptKind } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import type { MandateRow } from "@/data/contracts/mandates";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import { ApprovalsPanel } from "@/features/fleet";
import { RunOutcomesConsent } from "@/features/run-outcomes";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { Money } from "@/ui/money";
import { SafeLink } from "@/ui/navigation";
import { ChainSection } from "./chain";
import { CostSection } from "./cost";
import { FramesSection } from "./frames";
import { RunHeader } from "./header";
import { IssuesSection } from "./issues";
import { OutputsSpine } from "./outputs";
import { ResolvedApprovalsPanel } from "./resolved-approvals";
import {
  ContextSection,
  entriesOf,
  manifestSeq,
  PolicySection,
} from "./sections";
import { StatRow, SummaryPanel } from "./stats";
import { RunEmpty, RunReadFailure } from "./states";
import { kindsParam, TranscriptSection } from "./transcript";
import { ChangesPanel, SpendByArea } from "./work";
import { readRunWork, WithWork } from "./work-ci";

/** The seven tabs, in the spec's order (pages/run.md). */
const TABS = [
  "transcript",
  "issues",
  "actions",
  "cost",
  "policy",
  "context",
  "chain",
] as const;
type Tab = (typeof TABS)[number];

/**
 * Tab names an older link may still carry. Frames and Approvals became one
 * Governed actions tab, so a bookmark to either opens it.
 */
const TAB_ALIASES: Record<string, Tab> = {
  frames: "actions",
  approvals: "actions",
  // The proof, definition-of-done and ladder tabs are gone; the spec lands
  // their old links on Cost.
  proof: "cost",
  dod: "cost",
  ladder: "cost",
};

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

type Place = { org: string; ws: string; runId: string };

/** `?kinds=tools,errors` as the contract's own list; an unknown word is dropped, not refused. */
function parseKinds(raw: string | null): TranscriptKind[] {
  if (raw === null) return [];
  const asked = new Set(raw.split(","));
  return TRANSCRIPT_KINDS.filter((kind) => asked.has(kind));
}

type Counted = {
  run: RunRow;
  everything: Read<RunTranscript>;
  cost: Read<RunCost>;
  pending: Read<ApprovalQueue>;
};

/**
 * What each tab holds, beside its name (spec: counts are live). A count read
 * from a transcript that stopped short is a floor and says so with a plus; a
 * tab whose read failed shows no count rather than a zero.
 */
function useTabCounts({
  run,
  everything,
  cost,
  pending,
}: Counted): Partial<Record<Tab, ReactNode>> {
  const t = useTranslations("run.tabs");
  const floor = (count: number) =>
    everything.ok && !everything.value.complete
      ? t("atLeast", { count })
      : String(count);
  const policy = entriesOf(everything, "policy");
  const recall = entriesOf(everything, "recall");
  const runCost = cost.ok ? (cost.value.rollup?.cost ?? run.cost) : run.cost;
  return {
    transcript: everything.ok
      ? floor(everything.value.entries.length)
      : undefined,
    issues: run.taskRef === null ? "0" : "1",
    actions: policy === null ? undefined : floor(policy.length),
    cost: runCost === null ? undefined : <Money value={runCost} />,
    policy: policy === null ? undefined : floor(policy.length),
    context: recall === null ? undefined : floor(recall.length),
    chain: t(`status.${run.status}`),
  };
}

/** A call parked on this run: the dot the Governed actions and Policy tabs carry. */
function isParked(pending: Read<ApprovalQueue>): boolean {
  return pending.ok && pending.value.items.length > 0;
}

/** The side column: what the run changed, what it produced, and where it spent. */
function Work({ children }: { children: ReactNode }) {
  const t = useTranslations("run.work");
  return (
    <aside aria-label={t("label")} className="flex min-w-0 flex-col gap-4">
      {children}
    </aside>
  );
}

function Tabs({
  selected,
  zoom,
  kinds,
  counts,
  org,
  ws,
  runId,
}: {
  selected: Tab;
  zoom: TranscriptZoom;
  kinds: readonly TranscriptKind[];
  /** The reads each tab's count comes from. */
  counts: Counted;
} & Place) {
  const t = useTranslations("run.tabs");
  const shown = useTabCounts(counts);
  const parked = isParked(counts.pending);
  return (
    <div
      role="tablist"
      aria-label={t("label")}
      className="flex overflow-x-auto border-b border-border"
    >
      {TABS.map((tab) => (
        <SafeLink
          key={tab}
          role="tab"
          aria-selected={tab === selected}
          aria-controls="run-tab-panel"
          // The Transcript tab keeps the zoom and the chips a person chose,
          // so leaving it for the chain and coming back does not reset the
          // view they built.
          to={routes.run(
            org,
            ws,
            runId,
            tab === "transcript"
              ? { tab, zoom, kinds: kindsParam(kinds) }
              : { tab },
          )}
          aria-current={tab === selected ? "page" : undefined}
          className="inline-flex min-h-11 shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 border-transparent px-3 text-[13px] font-medium text-muted-foreground hover:text-foreground aria-selected:border-accent aria-selected:text-foreground"
        >
          {t(tab)}
          {shown[tab] === undefined ? null : (
            <span
              data-testid={`run-tab-count-${tab}`}
              className="text-[11px] tabular-nums text-dim"
            >
              {shown[tab]}
            </span>
          )}
          {parked && (tab === "actions" || tab === "policy") ? (
            <span
              data-testid={`run-tab-parked-${tab}`}
              className="size-1.5 rounded-full bg-info"
            >
              <span className="sr-only">{t("parked")}</span>
            </span>
          ) : null}
        </SafeLink>
      ))}
    </div>
  );
}

/**
 * The run's pending approvals, the mandates their cards draw a bar from, and
 * the instant their clocks start from.
 *
 * The ledger is read only when a parked call names a mandate, the same rule
 * `readFleet` follows, so a run whose approvals drew on none makes one read and
 * a viewer who may not read the ledger sees the cards without their bars.
 *
 * `Date.now()` lives here rather than in the page or the component body: a
 * component's render must be pure, and the route's render is a render too, so
 * the React compiler's rule refuses the call in either place. An async read
 * function is neither, and the clock belongs beside the read anyway. The same
 * instant is the one a live run's wall clock is read against.
 *
 * `fixed` is how a test pins the clock.
 */
async function readApprovals(
  source: DataSource,
  ctx: WsCtx,
  runId: string,
  fixed: number | undefined,
) {
  const approvals = await source.approvals.pending(ctx, { runId });
  const named =
    approvals.ok &&
    approvals.value.items.some((item) => item.mandateId !== null);
  const mandates = new Map<string, MandateRow>();
  if (named) {
    const read = await source.mandates.list(ctx, { agentId: null });
    if (read.ok)
      for (const mandate of read.value.mandates)
        mandates.set(mandate.id, mandate);
  }
  return { approvals, mandates, at: fixed ?? Date.now() };
}

/** The run's header read, and the instant it answered: the error state names that instant. */
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
  zoom,
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
  /** `?tab=`; anything but a section's name opens Transcript. */
  tab: string | null;
  /** `?zoom=`; anything but a level opens the transcript at steps. */
  zoom: string | null;
  /** `?kinds=`, the chips pressed, comma-separated; an unknown word is dropped. */
  kinds: string | null;
  /** `?frames=`, the opaque cursor a later frames page was read from. */
  frames: string | null;
  /** `?body=`, the seq of the frame whose body is open; anything but a seq opens none. */
  body: string | null;
  /** `?reads=hide` folds the spine's read marks away. */
  reads: string | null;
  /** `?spine=`, the spine groups a person opened, comma-separated. */
  spine: string | null;
  /**
   * Pins the clock the page reads. Only a test passes it; the page leaves it
   * out and the read helpers take the clock beside their reads.
   */
  now?: number;
}) {
  const selected =
    TABS.find((name) => name === tab) ??
    (tab === null ? undefined : TAB_ALIASES[tab]) ??
    "transcript";
  const level = TranscriptZoom.safeParse(zoom);
  const zoomed = level.success ? level.data : "steps";
  const chips = parseKinds(kinds);
  const { read, at: readAt } = await readRun(source, ctx, runId, frames, now);
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    // A failed read replaces the page body and never the shell.
    return (
      <RunReadFailure
        read={read}
        org={ctx.orgSlug}
        ws={ctx.wsSlug}
        orgName={ctx.orgName}
        wsSlug={ctx.wsSlug}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        retry={routes.run(ctx.orgSlug, ctx.wsSlug, runId)}
        readAt={readAt}
      />
    );
  }
  const detail = read.value;
  const run = detail.run;
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug, runId: run.id };
  // A run token was minted and nothing has been recorded under it yet.
  if (run.frames === 0) return <RunEmpty org={place.org} ws={place.ws} />;
  // The header, the stat row, the side column and the tab counts all read
  // from these, whichever tab is open, so they are read together rather than
  // one after another. The whole-run transcript serves the Prompts figure,
  // the Policy and Context tabs and their counts, and the Transcript tab too
  // when no chip is pressed.
  const agentSlug = run.agentKey?.split(".").at(-1) ?? null;
  const [outputs, everything, cost, pending, agent] = await Promise.all([
    // A thrown outputs read folds to the Run page's own read error, so
    // the spine says the read failed rather than the page throwing.
    source.runs
      .outputs(ctx, run.id)
      .catch(() =>
        readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
      ),
    source.runs.transcript(ctx, run.id, "everything"),
    source.runs.cost(ctx, run.id),
    readApprovals(source, ctx, run.id, now),
    agentSlug === null ? null : source.agents.get(ctx, agentSlug),
  ]);
  // Started, never awaited here: provider latency (GitHub pull requests,
  // checks, diffs) streams inside the Suspense boundaries of the checkout
  // strip and the Changes panel, and cannot hold the rest of the page.
  const work = readRunWork(ctx, source, run.id);
  let section: ReactNode;
  switch (selected) {
    case "transcript":
      section = (
        <TranscriptSection
          read={
            chips.length === 0
              ? everything
              : await source.runs.transcript(ctx, run.id, "everything", {
                  kinds: chips,
                })
          }
          zoom={zoomed}
          kinds={chips}
          run={run}
          {...place}
        />
      );
      break;
    case "issues": {
      // The tab reads the work evidence for Linked work and the
      // organization's follow-through setting beside it, so both wait only
      // when this tab is open.
      const [settled, outcomesPolicy] = await Promise.all([
        work,
        source.runs
          .outcomesSettings(ctx)
          .catch(() =>
            readError(
              PAGE_FAILURES.run.error.code,
              PAGE_FAILURES.run.error.status,
            ),
          ),
      ]);
      section = (
        <IssuesSection run={run} outputs={outputs} work={settled} place={place}>
          <RunOutcomesConsent
            at={place}
            policy={outcomesPolicy}
            canManage={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
          />
        </IssuesSection>
      );
      break;
    }
    case "actions": {
      const seq = body !== null && FRAME_SEQ.test(body) ? body : null;
      const resolved = await source.approvals.resolved(ctx, {
        runId: run.id,
      });
      section = (
        <div className="flex flex-col gap-4">
          <FramesSection
            read={read}
            frames={frames}
            body={
              seq === null
                ? null
                : { seq, read: await source.runs.frameBody(ctx, run.id, seq) }
            }
            {...place}
          />
          <ApprovalsPanel
            approvals={pending.approvals}
            mandates={pending.mandates}
            now={pending.at}
            on="run"
            org={place.org}
            ws={place.ws}
          />
          <ResolvedApprovalsPanel approvals={resolved} />
        </div>
      );
      break;
    }
    case "cost": {
      // The waterfall is the run's own per-turn ledger: the turns carry the
      // bars and their running totals, the steps carry what sits inside each
      // one. Both are the transcript, so the figures on this tab and the
      // figures on the Transcript tab come from one derivation.
      const [turns, steps] = await Promise.all([
        source.runs.transcript(ctx, run.id, "turns"),
        source.runs.transcript(ctx, run.id, "steps"),
      ]);
      section = (
        <CostSection
          run={run}
          read={cost}
          turns={turns}
          steps={steps}
          at={pending.at}
          place={place}
        />
      );
      break;
    }
    case "policy":
      section = <PolicySection read={everything} place={place} />;
      break;
    case "context": {
      // The steering manifest is the body of the frame the session sealed it
      // under, read only when this tab is open and the run sealed one.
      const seq = manifestSeq(everything);
      section = (
        <ContextSection
          run={run}
          read={everything}
          manifest={
            seq === null
              ? null
              : { seq, read: await source.runs.frameBody(ctx, run.id, seq) }
          }
          place={place}
        />
      );
      break;
    }
    case "chain":
      section = <ChainSection read={await source.runs.chain(ctx, run.id)} />;
      break;
  }
  return (
    <div className="flex flex-col gap-5">
      <RunHeader
        run={run}
        agent={agent}
        pulls={
          outputs.ok
            ? outputs.value.nodes.filter((node) => node.kind === "pr")
            : null
        }
        work={work}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        org={place.org}
        ws={place.ws}
      />
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="flex min-w-0 flex-col gap-4 lg:col-span-2">
          <SummaryPanel
            run={run}
            agent={agent}
            org={place.org}
            ws={place.ws}
            orgRole={ctx.orgRole}
            wsRole={ctx.wsRole}
          />
          <StatRow
            run={run}
            cost={cost}
            transcript={everything}
            at={pending.at}
          />
          <Tabs
            selected={selected}
            zoom={zoomed}
            kinds={chips}
            counts={{ run, everything, cost, pending: pending.approvals }}
            {...place}
          />
          <div id="run-tab-panel" role="tabpanel">
            {section}
          </div>
        </div>
        <Work>
          <Suspense fallback={<ChangesPanel read={outputs} place={place} />}>
            <WithWork read={work}>
              {(settled) => (
                <ChangesPanel read={outputs} work={settled} place={place} />
              )}
            </WithWork>
          </Suspense>
          <OutputsSpine read={outputs} reads={reads} spine={spine} {...place} />
          <SpendByArea read={cost} place={place} />
        </Work>
      </div>
    </div>
  );
}
