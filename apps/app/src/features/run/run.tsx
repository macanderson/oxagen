// The Run page (ARCHITECTURE.md §1.2 Run row, WL-35; mockup `pRun`): what this
// run is, then one section chosen by `?tab=`.
//
// `get_run` is always read, because the header is on every tab and the frames
// page travels with it. Every other read belongs to one tab and is made only
// when that tab is open, so opening the page costs one invoke and no tab
// nobody looked at is paid for (§3.5's poll budget).
//
// Four sections have a store behind them: Transcript (`get_run_transcript` at
// one of three zoom levels), Frames (`get_run`'s own page), Cost
// (`get_run_cost`) and Policy (`list_approvals` narrowed to the run, with the
// mandate ledger when a parked call names one).
//
// Three of the mockup's tabs are not drawn here (§3.6: a slice with no backing
// has no read at all):
//   - Proof, and the four-tab set a witness run renders, need `get_run_proof`
//     and the witness vocabulary; #2955 owns them. The header states that a run
//     witnessed another, and links no further.
//   - Chain and seal would need a read that answers the Merkle root, the
//     attestation and the segment reference. No contract reads them: the only
//     capability that produces them is `export_run`, which queues a bundle
//     rather than answering one, so the header carries the seal instant and
//     the replay grade and the Export action queues the rest.
//   - Context was cut (#2954 closed).
import { notFound } from "next/navigation";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { TranscriptZoom } from "@/data/contracts/run";
import type { DataSource } from "@/data/ports";
import type { WsCtx } from "@/server/viewer";
import { routes } from "@/shared/safe-path";
import { panel } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { CostSection } from "./cost";
import { FramesSection } from "./frames";
import { RunHeader } from "./header";
import { PolicySection, readRunApprovals } from "./policy";
import { TranscriptSection } from "./transcript";

const TABS = ["transcript", "frames", "cost", "policy"] as const;
type Tab = (typeof TABS)[number];

type Place = { org: string; ws: string; runId: string };

function Tabs({ selected, org, ws, runId }: { selected: Tab } & Place) {
  const t = useTranslations("run.tabs");
  return (
    <nav aria-label={t("label")} className="border-b border-border">
      <ul className="flex flex-wrap gap-1">
        {TABS.map((tab) => (
          <li key={tab}>
            <SafeLink
              to={routes.run(org, ws, runId, { tab })}
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

export async function Run({
  ctx,
  source,
  runId,
  tab,
  zoom,
  frames,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The run's public id, as the URL names it (`arun_…` or `tse_…`). */
  runId: string;
  /** `?tab=`; anything but a section's name opens Transcript. */
  tab: string | null;
  /** `?zoom=`; anything but a level reads the transcript by steps. */
  zoom: string | null;
  /** `?frames=`, the opaque cursor a later frames page was read from. */
  frames: string | null;
}) {
  const selected = TABS.find((name) => name === tab) ?? "transcript";
  const level = TranscriptZoom.safeParse(zoom);
  const zoomed = level.success ? level.data : "steps";
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
  let body: ReactNode;
  switch (selected) {
    case "transcript":
      body = (
        <TranscriptSection
          read={await source.runs.transcript(ctx, detail.run.id, zoomed)}
          zoom={zoomed}
          {...place}
        />
      );
      break;
    case "frames":
      body = <FramesSection read={read} frames={frames} {...place} />;
      break;
    case "cost":
      body = <CostSection read={await source.runs.cost(ctx, detail.run.id)} />;
      break;
    case "policy":
      body = (
        <PolicySection
          read={await readRunApprovals(ctx, source, detail.run.id)}
          org={place.org}
          ws={place.ws}
        />
      );
      break;
  }
  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        run={detail.run}
        witnessed={detail.witnessed}
        org={place.org}
        ws={place.ws}
      />
      <Tabs selected={selected} {...place} />
      {body}
    </div>
  );
}
