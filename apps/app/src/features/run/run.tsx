import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, type ReactNode } from "react";
import { TranscriptZoom } from "@/data/contracts/run";
import type { TranscriptKind } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { ApprovalQueue } from "@/data/contracts/approvals";
import type { RunCost, RunTranscript } from "@/data/contracts/run";
import type { RunWork } from "@/data/contracts/run-work";
import type { RunRow } from "@/data/contracts/runs";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, type Read, readError } from "@/data/read";
import {
  RunOutcomesConsent,
  RunIssueConnections,
} from "@/features/run-outcomes";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { Money } from "@/ui/money";
import { SafeLink } from "@/ui/navigation";
import { ChainSection } from "./chain";
import { CostSection } from "./cost";
import { EnrichmentSwitch } from "./enrichment-switch";
import { GovernedActionsSection } from "./frames";
import { type AgentFigures, RunHeader } from "./header";
import { interjectionOf, RunInterjection } from "./interjection";
import { issueCount, IssuesSection } from "./issues";
import { OutputsSpine } from "./outputs";
import { ExportAction } from "./record-actions";
import { ReplayActions } from "./replay-actions";
import { ResolvedApprovalsPanel } from "./resolved-approvals";
import {
  ContextSection,
  entriesOf,
  manifestSeq,
  PolicySection,
} from "./sections";
import { StatRow, SummaryPanel } from "./stats";
import { RunEmpty, RunReadFailure } from "./states";
import { KINDS_NONE, kindsParam, TranscriptSection } from "./transcript";
import { ChangesPanel, SpendByArea } from "./work";
import { isWhole, readWholeTranscript } from "./whole-transcript";
import { checkoutOf, readRunWork, WithWork, workOf } from "./work-ci";

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
}: Counted): Partial<Record<Tab, ReactNode>> {
  const t = useTranslations("run.tabs");
  // The page's whole-run read is one page of entries. Past that page, or past
  // the read's frame cap, a count is a floor.
  const floor = (count: number) =>
    everything.ok && !isWhole(everything.value)
      ? t("atLeast", { count })
      : String(count);
  const policy = entriesOf(everything, "policy");
  const recall = entriesOf(everything, "recall");
  const runCost = cost.ok ? (cost.value.rollup?.cost ?? run.cost) : run.cost;
  return {
    transcript: everything.ok
      ? floor(everything.value.entries.length)
      : undefined,
    issues: String(issueCount(run)),
    // A run with no policy decision names the tab by its player and counts
    // the frames it plays (spec: "Player" with the frame count).
    actions:
      policy === null
        ? undefined
        : policy.length === 0
          ? String(run.frames)
          : floor(policy.length),
    cost: runCost === null ? undefined : <Money value={runCost} />,
    policy: policy === null ? undefined : floor(policy.length),
    context: recall === null ? undefined : floor(recall.length),
    chain: t(`status.${run.status}`),
  };
}

/** The first prompt entry's text and instant, when the recorder kept its body. */
function firstPrompt(
  read: Read<RunTranscript>,
): { text: string; at: string } | null {
  if (!read.ok) return null;
  const entry = read.value.entries.find((item) =>
    item.kinds.includes("prompt"),
  );
  const text = entry?.request?.text ?? entry?.response?.text ?? null;
  return entry === undefined || text === null ? null : { text, at: entry.at };
}

/** True when the run recorded no policy decision: the Governed actions tab reads "Player". */
function isPlayer(everything: Read<RunTranscript>): boolean {
  const policy = entriesOf(everything, "policy");
  return policy !== null && policy.length === 0;
}

/**
 * `github.com/a-intel/edge-proxy@e7c41a9`: the repository the first recorded
 * checkout named and the commit it was at. Null when the collector recorded
 * no checkout, no repository or no commit, so the meta line says the remote
 * was not captured rather than guessing one.
 */
function remoteOf(work: RunWork | null): string | null {
  const checkout = checkoutOf(work);
  const repository = checkout?.repository ?? null;
  if (checkout === null || repository === null || checkout.headSha === null)
    return null;
  return `${repository.host}/${repository.owner}/${repository.name}@${checkout.headSha.slice(0, 7)}`;
}

/** A call parked on this run: the dot the Governed actions and Policy tabs carry. */
function isParked(pending: Read<ApprovalQueue>): boolean {
  return pending.ok && pending.value.items.length > 0;
}

/**
 * The Chain and seal tab's three actions (spec): Fork replay from frame N,
 * Bisect against another run, and Export the bundle. The same dialogs the
 * header opens, under the tab's longer names.
 */
function ChainActions({
  run,
  lastSeq,
  orgRole,
  org,
  ws,
}: {
  run: RunRow;
  lastSeq: string | null;
  orgRole: WsCtx["orgRole"];
} & Place) {
  const t = useTranslations("run.chain.actions");
  return (
    <ReplayActions
      org={org}
      ws={ws}
      run={run}
      prefix="chain"
      labels={{
        fork: lastSeq === null ? t("forkNoSeq") : t("fork", { seq: lastSeq }),
        bisect: t("bisect"),
      }}
      after={
        <ExportAction
          org={org}
          ws={ws}
          runId={run.id}
          sealed={run.status !== "live"}
          orgRole={orgRole}
          prefix="chain"
          label={t("export")}
        />
      }
    />
  );
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
          {tab === "actions" && isPlayer(counts.everything)
            ? t("player")
            : t(tab)}
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
 * The run's parked calls, which put the dot on the Governed actions and
 * Policy tabs, and the instant the page reads its clocks against.
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
  return { approvals, at: fixed ?? Date.now() };
}

/** How many `list_agents` pages the header walks looking for the run's agent. */
const AGENT_PAGES = 4;

/**
 * The agent's last 30 days, from its `list_agents` row: the runs and the spend
 * the compact agent card prints. `list_agents` has no filter, so this walks at
 * most `AGENT_PAGES` pages; an agent it does not reach, or a read that fails,
 * leaves the card with its harness alone rather than a guessed figure.
 */
async function readAgentFigures(
  source: DataSource,
  ctx: WsCtx,
  slug: string | null,
): Promise<AgentFigures | null> {
  if (slug === null) return null;
  let cursor: string | null = null;
  try {
    for (let page = 0; page < AGENT_PAGES; page += 1) {
      const read = await source.agents.list(ctx, { cursor });
      if (!read.ok) return null;
      const row = read.value.agents.find((agent) => agent.slug === slug);
      if (row !== undefined)
        return { runs30d: row.runs30d, spend30d: row.spend30d };
      cursor = read.value.nextCursor;
      if (cursor === null) return null;
    }
  } catch {
    return null;
  }
  return null;
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
  viewerName = null,
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
  /** The signed-in person's name, which the denied state prints; null when none is recorded. */
  viewerName?: string | null;
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
        viewerName={viewerName}
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
  // A run whose loop Oxagen stopped on an interjection is drawn as the three
  // panes of pages/run-interjection.md rather than the ordinary run page.
  const interject = interjectionOf(detail);
  if (interject !== null) {
    // The agent's pane opens on the operator's first message, which is the
    // transcript's first prompt entry.
    const [prompts, work] = await Promise.all([
      source.runs.transcript(ctx, run.id, "everything", {
        kinds: ["prompt"],
      }),
      readRunWork(ctx, source, run.id),
    ]);
    return (
      <RunInterjection
        detail={detail}
        interject={interject}
        prompt={firstPrompt(prompts)}
        remote={remoteOf(workOf(work))}
        ws={place.ws}
      />
    );
  }
  // The header, the stat row, the side column and the tab counts all read
  // from these, whichever tab is open, so they are read together rather than
  // one after another. The whole-run transcript serves the Prompts figure,
  // the Policy and Context tabs and their counts, and the Transcript tab too
  // when no chip is pressed.
  const agentSlug = run.agentKey?.split(".").at(-1) ?? null;
  const [outputs, everything, cost, pending, agent, figures] =
    await Promise.all([
      // A thrown outputs read folds to the Run page's own read error, so
      // the spine says the read failed rather than the page throwing.
      source.runs
        .outputs(ctx, run.id)
        .catch(() =>
          readError(
            PAGE_FAILURES.run.error.code,
            PAGE_FAILURES.run.error.status,
          ),
        ),
      source.runs.transcript(ctx, run.id, "everything"),
      source.runs.cost(ctx, run.id),
      readApprovals(source, ctx, run.id, now),
      agentSlug === null ? null : source.agents.get(ctx, agentSlug),
      readAgentFigures(source, ctx, agentSlug),
    ]);
  // Started, never awaited here: provider latency (GitHub pull requests,
  // checks, diffs) streams inside the Suspense boundaries of the checkout
  // strip and the Changes panel, and cannot hold the rest of the page.
  const work = readRunWork(ctx, source, run.id);
  const canManageOutcomes = ctx.orgRole === "owner" || ctx.orgRole === "admin";
  let section: ReactNode;
  switch (selected) {
    case "transcript":
      section = (
        <TranscriptSection
          none={kinds === KINDS_NONE}
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
          all={everything}
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
            canManage={canManageOutcomes}
          />
          <RunIssueConnections
            at={place}
            runId={run.id}
            enabled={outcomesPolicy.ok && outcomesPolicy.value.effectiveEnabled}
            canManage={canManageOutcomes}
          />
          {/* The workspace's switch for generated run names and summaries
              sits with the organization's follow-through setting: both say
              whether a model reads this run's turns. */}
          <EnrichmentSwitch
            org={place.org}
            ws={place.ws}
            enabled={run.enrichmentEnabled !== false}
            canEdit={
              ["owner", "admin"].includes(ctx.orgRole) ||
              ["owner", "admin"].includes(ctx.wsRole)
            }
          />
        </IssuesSection>
      );
      break;
    }
    case "actions": {
      const seq = body !== null && FRAME_SEQ.test(body) ? body : null;
      section = (
        <GovernedActionsSection
          read={read}
          frames={frames}
          run={run}
          body={
            seq === null
              ? null
              : { seq, read: await source.runs.frameBody(ctx, run.id, seq) }
          }
          {...place}
        />
      );
      break;
    }
    case "cost": {
      // The waterfall is the run's own per-turn ledger: the turns carry the
      // bars and their running totals, the steps carry what sits inside each
      // one. Both are the transcript, so the figures on this tab and the
      // figures on the Transcript tab come from one derivation.
      // Both read to the end: a run with more steps than one page used to
      // draw its later turns with no steps inside them.
      const [turns, steps] = await Promise.all([
        readWholeTranscript(source, ctx, run.id, "turns"),
        readWholeTranscript(source, ctx, run.id, "steps"),
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
    // Each reads only its own entries, to the end of the run. The page's
    // whole-run read is its first page, which listed a long run's first
    // decisions as if they were all of them.
    case "policy":
      // The calls a rule or a person already decided sit under the policy
      // decisions, because the rule that auto-approved a call is a policy
      // record (#3153). Parked calls live in the approvals drawer.
      section = (
        <div className="flex flex-col gap-4">
          <PolicySection
            read={
              await readWholeTranscript(source, ctx, run.id, "everything", [
                "policy",
              ])
            }
            place={place}
          />
          <ResolvedApprovalsPanel
            approvals={await source.approvals.resolved(ctx, { runId: run.id })}
          />
        </div>
      );
      break;
    case "context": {
      // The steering manifest is the body of the frame the session sealed it
      // under, read only when this tab is open and the run sealed one. The
      // session seals it at its start, so the page's first page holds it.
      const seq = manifestSeq(everything);
      section = (
        <ContextSection
          run={run}
          read={
            await readWholeTranscript(source, ctx, run.id, "everything", [
              "recall",
            ])
          }
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
      section = (
        <ChainSection
          read={await source.runs.chain(ctx, run.id)}
          actions={(lastSeq) => (
            <ChainActions
              run={run}
              lastSeq={lastSeq}
              orgRole={ctx.orgRole}
              {...place}
            />
          )}
        />
      );
      break;
  }
  return (
    <div className="flex flex-col gap-5">
      <RunHeader
        run={run}
        agent={agent}
        figures={figures}
        parked={isParked(pending.approvals)}
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
