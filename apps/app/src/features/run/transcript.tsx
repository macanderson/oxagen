// The Transcript tab (mockup `pRun`'s transcript; spec §14): the run read at
// one of three zoom levels, through the chips it was filtered by, under a
// transport.
//
// Nothing here is stored and nothing is inferred. The zoom and the chips are
// query values, so a level and a filter are links and the run keeps one route;
// the entries, the player and the pagination are the client's, because a
// playhead and an appended page are state a navigation would throw away.
//
// The chips are the contract's own `TranscriptKind` list, not the mockup's.
// The mockup drew a `thinking` chip and a `proof` chip; the contract publishes
// neither, so neither is drawn. A chip that filtered on nothing would promise
// a slice of the record that does not exist.
import { useLocale, useTranslations } from "next-intl";
import type { RunTranscript, TranscriptKind } from "@/data/contracts/run";
import { TRANSCRIPT_KINDS, TRANSCRIPT_ZOOMS } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import type { Place } from "./entry";
import { Panel } from "./parts";
import { RunPlayer } from "./player";

/** The chips as a URL value: `tools,errors`. Order follows the contract's list, so one filter has one URL. */
export function kindsParam(
  kinds: readonly TranscriptKind[],
): string | undefined {
  const picked = TRANSCRIPT_KINDS.filter((kind) => kinds.includes(kind));
  return picked.length === 0 ? undefined : picked.join(",");
}

function ZoomTabs({
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
    <nav aria-label={t("zoomLabel")} className="flex flex-wrap gap-1">
      {TRANSCRIPT_ZOOMS.map((level) => (
        <SafeLink
          key={level}
          to={routes.run(org, ws, runId, {
            tab: "transcript",
            zoom: level,
            kinds: kindsParam(kinds),
          })}
          aria-current={level === zoom ? "true" : undefined}
          className="inline-flex min-h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground aria-[current=true]:border-foreground aria-[current=true]:text-foreground"
        >
          {t(`zoom.${level}`)}
        </SafeLink>
      ))}
    </nav>
  );
}

/**
 * The filter chips. Each is a link that adds or removes its own kind, so a
 * chip can be opened in a new tab and the filter is in the URL a person
 * copies. No chip pressed keeps every entry, which is what the contract does
 * with an empty list.
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
      className="flex flex-wrap items-center gap-1"
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
            // A chip is a link, so its state is `aria-current`, the attribute
            // a link may carry, and not `aria-pressed`, which belongs to a
            // button. The zoom levels above it say the same thing the same way.
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
  live,
  org,
  ws,
  runId,
}: {
  read: Read<RunTranscript>;
  /** The level the URL asked for; the read answers with the level it used. */
  zoom: RunTranscript["zoom"];
  /** The chips the URL pressed; empty keeps every entry. */
  kinds: readonly TranscriptKind[];
  /** True while the run is still recording. */
  live: boolean;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const place = { org, ws, runId };
  return (
    <Panel
      title={t("title")}
      aside={<ZoomTabs zoom={zoom} kinds={kinds} {...place} />}
    >
      <div className="flex flex-col gap-3">
        <KindChips zoom={zoom} kinds={kinds} {...place} />
        {!read.ok ? (
          <ReadFailure read={read} section={t("title")} />
        ) : read.value.entries.length === 0 ? (
          <p
            data-testid="transcript-empty"
            className="max-w-prose text-sm text-muted-foreground"
          >
            {kinds.length === 0
              ? t("empty")
              : t("emptyFiltered", {
                  count: formatCount(kinds.length, locale),
                })}
          </p>
        ) : (
          <RunPlayer
            // The player holds the entries it has appended, so a new zoom or a
            // new filter must build a new one rather than append to the old.
            key={`${read.value.zoom}:${kindsParam(kinds) ?? ""}`}
            first={read.value}
            zoom={read.value.zoom}
            kinds={kinds}
            live={live}
            {...place}
          />
        )}
      </div>
    </Panel>
  );
}
