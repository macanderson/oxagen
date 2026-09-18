// The Run page (ARCHITECTURE.md §1.2 Run row, WL-35; mockup `pRun`): what this
// run is, then one section chosen by `?tab=`.
//
// `get_run` is always read, because the header is on every tab and the frames
// page travels with it. Every other read belongs to one tab and is made only
// when that tab is open, so opening the page costs one invoke and no tab
// nobody looked at is paid for (§3.5's poll budget).
//
// Three sections have a store behind them: Transcript (`get_run_transcript` at
// `everything`, grouped into turns and steps in the view, with `?zoom=` naming
// which disclosures start open), Frames (`get_run`'s own page, plus one frame's
// bytes from `get_run_frame_body` when `?body=` names it) and Cost
// (`get_run_cost`).
//
// Four of the mockup's tabs are not drawn here (§3.6: a slice with no backing
// has no read at all):
//   - Policy would be `list_approvals` narrowed to the run, but no approval
//     row records a run (`agent.approval_requests` carries `message_id`,
//     `execution_step_id` and `tool_call_id`, none naming `agent_runs` or
//     `tacho_sessions`; the contract header says so), so the handler answers
//     every run filter with an empty page. A tab that can only ever say "no
//     parked calls" is a lie about the record, so it is not drawn until the
//     linkage exists.
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
import { TranscriptSection } from "./transcript";

const TABS = ["transcript", "frames", "cost"] as const;
type Tab = (typeof TABS)[number];

/** A frame's position as the contract spells it (`frameSeqSchema`): decimal, at most 19 digits. */
const FRAME_SEQ = /^\d{1,19}$/;

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
  body,
}: {
  ctx: WsCtx;
  source: DataSource;
  /** The run's public id, as the URL names it (`arun_…` or `tse_…`). */
  runId: string;
  /** `?tab=`; anything but a section's name opens Transcript. */
  tab: string | null;
  /** `?zoom=`; anything but a level opens the transcript at steps. */
  zoom: string | null;
  /** `?frames=`, the opaque cursor a later frames page was read from. */
  frames: string | null;
  /** `?body=`, the seq of the frame whose body is open; anything but a seq opens none. */
  body: string | null;
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
  let section: ReactNode;
  switch (selected) {
    case "transcript":
      section = (
        <TranscriptSection
          read={await source.runs.transcript(ctx, detail.run.id, "everything")}
          zoom={zoomed}
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
    case "cost":
      section = (
        <CostSection read={await source.runs.cost(ctx, detail.run.id)} />
      );
      break;
  }
  return (
    <div className="flex flex-col gap-6">
      <RunHeader
        run={detail.run}
        witnessed={detail.witnessed}
        orgRole={ctx.orgRole}
        wsRole={ctx.wsRole}
        org={place.org}
        ws={place.ws}
      />
      <Tabs selected={selected} {...place} />
      {section}
    </div>
  );
}
