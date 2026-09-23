import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, type ReactNode } from "react";
import { TranscriptZoom } from "@/data/contracts/run";
import type { TranscriptKind } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { MandateRow } from "@/data/contracts/mandates";
import type { DataSource } from "@/data/ports";
import { PAGE_FAILURES, readError } from "@/data/read";
import { RunOutcomesConsent } from "@/features/run-outcomes";
import { ApprovalsPanel } from "@/features/fleet";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { CostSection } from "./cost";
import { FramesSection } from "./frames";
import { RunSummary } from "./summary";
import { RunHeader } from "./header";
import { RunWork, RunWorkLoading } from "./work";
import { OutputsSpine } from "./outputs";
import { ResolvedApprovalsPanel } from "./resolved-approvals";
import { kindsParam, TranscriptSection } from "./transcript";

const TABS = ["transcript", "cost", "frames", "approvals"] as const;
type Tab = (typeof TABS)[number];

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

type Place = { org: string; ws: string; runId: string };

/** `?kinds=tools,errors` as the contract's own list; an unknown word is dropped, not refused. */
function parseKinds(raw: string | null): TranscriptKind[] {
  if (raw === null) return [];
  const asked = new Set(raw.split(","));
  return TRANSCRIPT_KINDS.filter((kind) => asked.has(kind));
}

function Tabs({
  selected,
  zoom,
  kinds,
  org,
  ws,
  runId,
}: {
  selected: Tab;
  zoom: TranscriptZoom;
  kinds: readonly TranscriptKind[];
} & Place) {
  const t = useTranslations("run.tabs");
  return (
    <nav aria-label={t("label")} className="border-b border-border">
      <ul className="flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <li key={tab}>
            <SafeLink
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
              className="inline-flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-muted-foreground hover:text-foreground aria-[current=page]:border-foreground aria-[current=page]:text-foreground"
            >
              {t(tab)}
            </SafeLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/**
 * The run's pending approvals, the mandates their cards draw a bar from, and
 * the instant their clocks start from.
 *
 * The ledger is read only when a parked call names a mandate, the same rule
 * `readFleet` follows, so a run whose approvals drew on none makes one read and
 * a viewer who may not read the ledger sees the cards without their bars. It
 * used to pass an empty map here, which made every card on this page say the
 * mandate could not be read: the card showed a mandate id and no authority, on
 * the one page where the call's own run is in front of you.
 *
 * `Date.now()` lives here rather than in the page or the component body: a
 * component's render must be pure, and the route's render is a render too, so
 * the React compiler's rule refuses the call in either place. An async read
 * function is neither, and the clock belongs beside the read anyway. This is
 * the same shape `readFleet` uses in features/fleet.
 *
 * `fixed` is how a test pins the countdown.
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
   * Pins the instant the approvals strip counts down from. Only a test passes
   * it; the page leaves it out and `readApprovals` reads the clock beside the
   * read it belongs to.
   */
  now?: number;
}) {
  const selected = TABS.find((name) => name === tab) ?? "transcript";
  const level = TranscriptZoom.safeParse(zoom);
  const zoomed = level.success ? level.data : "steps";
  const chips = parseKinds(kinds);
  const read = await source.runs.get(ctx, runId, { framesAfter: frames });
  if (!read.ok) {
    if (read.reason === "error" && read.status === 404) notFound();
    return (
      <div className={`${panel} p-4`}>
        <ReadFailure read={read} section={runId} />
      </div>
    );
  }
  const detail = read.value;
  const place = { org: ctx.orgSlug, ws: ctx.wsSlug, runId: detail.run.id };
  // Read with the page and not with a tab, because the spine is what the page
  // is for. Started here and awaited after the section, so the two reads
  // overlap rather than queue: the spine costs the page no extra round trip.
  // A section read that throws would leave this promise's rejection with no
  // listener, so a thrown outputs read folds to the Run page's own read
  // error and the spine says the read failed.
  const outputs = source.runs
    .outputs(ctx, detail.run.id)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  const outcomesPolicy = source.runs
    .outcomesSettings(ctx)
    .catch(() =>
      readError(PAGE_FAILURES.run.error.code, PAGE_FAILURES.run.error.status),
    );
  let section: ReactNode;
  switch (selected) {
    case "transcript":
      section = (
        <TranscriptSection
          read={
            await source.runs.transcript(ctx, detail.run.id, "everything", {
              kinds: chips,
            })
          }
          zoom={zoomed}
          kinds={chips}
          run={detail.run}
          {...place}
        />
      );
      break;
    case "frames": {
      const seq = body !== null && FRAME_SEQ.test(body) ? body : null;
      section = (
        <FramesSection
          read={read}
          frames={frames}
          body={
            seq === null
              ? null
              : {
                  seq,
                  read: await source.runs.frameBody(ctx, detail.run.id, seq),
                }
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
      const [cost, turns, steps] = await Promise.all([
        source.runs.cost(ctx, detail.run.id),
        source.runs.transcript(ctx, detail.run.id, "turns"),
        source.runs.transcript(ctx, detail.run.id, "steps"),
      ]);
      section = <CostSection read={cost} turns={turns} steps={steps} />;
      break;
    }
    case "approvals": {
      const { approvals, mandates, at } = await readApprovals(
        source,
        ctx,
        detail.run.id,
        now,
      );
      const resolvedApprovals = await source.approvals.resolved(ctx, {
        runId: detail.run.id,
      });
      section = (
        <div className="flex flex-col gap-6">
          <ApprovalsPanel
            approvals={approvals}
            mandates={mandates}
            now={at}
            on="run"
            org={place.org}
            ws={place.ws}
          />
          <ResolvedApprovalsPanel approvals={resolvedApprovals} />
        </div>
      );
      break;
    }
  }
  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        run={detail.run}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        org={place.org}
        ws={place.ws}
      />
      <Suspense fallback={<RunWorkLoading />}>
        <RunWork ctx={ctx} source={source} {...place} />
      </Suspense>
      <RunOutcomesConsent
        at={place}
        policy={await outcomesPolicy}
        canManage={ctx.orgRole === "owner" || ctx.orgRole === "admin"}
      />
      <div className="grid min-w-0 gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <RunSummary run={detail.run} org={place.org} ws={place.ws} />
          <Tabs selected={selected} zoom={zoomed} kinds={chips} {...place} />
          {section}
        </div>
        <aside className="min-w-0" data-testid="run-output-sidebar">
          <OutputsSpine
            read={await outputs}
            reads={reads}
            spine={spine}
            {...place}
          />
        </aside>
      </div>
    </div>
  );
}
