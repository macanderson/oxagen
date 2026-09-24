// The Transcript tab (mockup `pRun`'s transcript; spec §14): every run drawn
// the same way, from the run's start through each turn and its steps to each
// frame's body, with a transport that replays it.
//
// One read serves every zoom level: the transcript at `everything`, one entry
// per frame with the turn it falls in, so the view groups turns and steps
// itself and a change of level opens and closes disclosures rather than
// fetching again. Nothing here is stored, and nothing is inferred: a frame
// whose body was not retained says `digest_only` rather than showing an empty
// bubble, a body cut at the contract's ceiling links to the whole of it on
// the Frames tab, and a transcript that could not carry the whole run pages
// the rest in rather than stopping short of it.
//
// The chips are the filter, and they are links: a filter is a query value, so
// it survives a reload, opens in a new tab, and is in the URL a person copies.
// They are the contract's own `TranscriptKind` list and not the mockup's. The
// mockup drew a `thinking` chip and a `proof` chip that `get_run_transcript`
// publishes no kind for, and a chip that filtered on nothing would promise a
// slice of the record that does not exist.
import { useLocale, useTranslations } from "next-intl";
import type { RunTranscript, TranscriptKind } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS } from "@/data/contracts/run";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";
import { isNonEmpty } from "./transcript-model";
import { TranscriptView } from "./transcript-view";
import { LiveEmptyFollow } from "./live-empty-follow";
import type { RunTabProps } from "./tab-props";

type Place = { org: string; ws: string; runId: string };

/**
 * The chips as a URL value: `tools,errors`. The order follows the contract's
 * own list rather than the order they were pressed, so one filter has one URL
 * and two people who pressed the same chips share a link.
 */
export function kindsParam(
  kinds: readonly TranscriptKind[],
): string | undefined {
  const picked = TRANSCRIPT_KINDS.filter((kind) => kinds.includes(kind));
  return picked.length === 0 ? undefined : picked.join(",");
}

/**
 * The filter chips. Each is a link that adds or removes its own kind. No chip
 * pressed keeps every entry, which is what the contract does with an empty
 * list, so there is no "all" chip to get out of step with the others.
 */
function KindChips({
  zoom,
  kinds,
  org,
  ws,
  runId,
}: {
  zoom: RunTranscript["zoom"];
  kinds: readonly TranscriptKind[];
} & Place) {
  const t = useTranslations("run.transcript");
  return (
    <nav
      aria-label={t("chipsLabel")}
      data-testid="transcript-chips"
      className="flex flex-wrap items-center gap-1 pb-3"
    >
      {TRANSCRIPT_KINDS.map((kind) => {
        const on = kinds.includes(kind);
        const next = on
          ? kinds.filter((held) => held !== kind)
          : [...kinds, kind];
        return (
          <SafeLink
            key={kind}
            to={routes.run(org, ws, runId, {
              tab: "transcript",
              zoom,
              kinds: kindsParam(next),
            })}
            data-testid={`chip-${kind}`}
            data-on={on ? "true" : "false"}
            // A chip is a link, so its state is `aria-current`, which a link
            // may carry, and not `aria-pressed`, which belongs to a button.
            aria-current={on ? "true" : undefined}
            className="inline-flex min-h-8 items-center rounded-full border border-border px-3 text-xs text-muted-foreground hover:text-foreground aria-[current=true]:border-foreground aria-[current=true]:text-foreground"
          >
            {t(`chip.${kind}`)}
          </SafeLink>
        );
      })}
      {kinds.length === 0 ? null : (
        <SafeLink
          to={routes.run(org, ws, runId, { tab: "transcript", zoom })}
          data-testid="chip-clear"
          className="inline-flex min-h-8 items-center px-2 text-xs underline underline-offset-4"
        >
          {t("chipsClear")}
        </SafeLink>
      )}
    </nav>
  );
}

export function TranscriptSection({
  read,
  zoom,
  kinds,
  run,
  org,
  ws,
  runId,
}: {
  /** The transcript at `everything`: one entry per frame. */
  read: Read<RunTranscript>;
  /** The level the URL asked for: which disclosures start open. */
  zoom: RunTranscript["zoom"];
  /** The chips the URL pressed; empty keeps every entry. */
  kinds: readonly TranscriptKind[];
  run: Pick<RunRow, "status" | "replayGrade">;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const place = { org, ws, runId };
  const chips = <KindChips zoom={zoom} kinds={kinds} {...place} />;
  if (!read.ok) {
    return (
      <Panel title={t("title")}>
        {chips}
        <ReadFailure read={read} section={t("title")} />
      </Panel>
    );
  }
  const { entries } = read.value;
  if (!isNonEmpty(entries)) {
    return (
      <Panel title={t("title")}>
        {chips}
        <p
          data-testid="transcript-empty"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {kinds.length === 0
            ? t("empty")
            : t("emptyFiltered", { count: formatCount(kinds.length, locale) })}
        </p>
        {run.status === "live" ? (
          <LiveEmptyFollow org={org} ws={ws} runId={runId} />
        ) : null}
      </Panel>
    );
  }
  return (
    <div className="flex flex-col">
      {chips}
      <TranscriptView
        // The view holds the pages it has appended, so a new filter must build
        // a new one rather than append a filtered page to an unfiltered one.
        key={kindsParam(kinds) ?? ""}
        transcript={read.value}
        entries={entries}
        kinds={kinds}
        zoom={zoom}
        status={run.status}
        replayGrade={run.replayGrade}
        org={org}
        ws={ws}
        runId={runId}
      />
    </div>
  );
}

/**
 * The Transcript tab over the page's bundle: the whole-run transcript the
 * page already read, or, with chips pressed, the run narrowed to them.
 */
export async function TranscriptTab(props: RunTabProps) {
  const { ctx, source, run, view, place, everything } = props;
  const read =
    view.kinds.length === 0
      ? everything
      : await source.runs.transcript(ctx, run.id, "everything", {
          kinds: [...view.kinds],
        });
  return (
    <TranscriptSection
      read={read}
      zoom={view.zoom}
      kinds={view.kinds}
      run={run}
      {...place}
    />
  );
}
