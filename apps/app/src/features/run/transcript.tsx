// The Transcript tab (mockup `pRun`'s transcript; spec §14): the run read at
// one of three zoom levels, derived on the server from the frames and the
// bodies the recorder kept.
//
// Nothing here is stored, and nothing is inferred. An entry whose body was not
// retained says `digest_only` rather than showing an empty bubble, an entry cut
// at the contract's ceiling says it was cut and links to the frame's whole
// body on the Frames tab (`get_run_frame_body`), and a transcript that could
// not carry the whole run says how far it reached. The zoom is a query value,
// so a level is a link and the page keeps one route.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { RunTranscript, TranscriptEntry } from "@/data/contracts/run";
import { TRANSCRIPT_ZOOMS } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Panel } from "./parts";

type Place = { org: string; ws: string; runId: string };

function Entry({ entry, org, ws, runId }: { entry: TranscriptEntry } & Place) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  const locale = useLocale();
  const span =
    entry.seq === entry.endSeq
      ? t("frame", { seq: entry.seq })
      : t("frames", { from: entry.seq, to: entry.endSeq });
  return (
    <li
      data-testid="transcript-entry"
      data-kind={entry.kind}
      className="flex flex-col gap-1.5 border-b border-border py-3 last:border-b-0"
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {t(`kind.${entry.kind}`)}
        </span>
        <span className={mono}>{entry.label}</span>
        <span className={mono}>{span}</span>
        <time dateTime={entry.at}>
          {format.dateTime(new Date(entry.at), { timeStyle: "medium" })}
        </time>
        {entry.cost === null ? null : (
          <span>
            <Money value={entry.cost} precision="exact" />
          </span>
        )}
        <span>{t("folded", { count: formatCount(entry.frames, locale) })}</span>
      </div>
      {entry.text === null ? (
        <p className="text-xs text-muted-foreground">
          {t(entry.fidelity === "digest_only" ? "digestOnly" : "noBody")}
        </p>
      ) : (
        <pre
          className={`${mono} max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs`}
        >
          {entry.text}
        </pre>
      )}
      {entry.truncated ? (
        <p
          data-testid="entry-truncated"
          className="text-xs text-muted-foreground"
        >
          {t("truncated")}{" "}
          <SafeLink
            to={routes.run(org, ws, runId, { tab: "frames", body: entry.seq })}
            className={linkText}
          >
            {t("openFrame", { seq: entry.seq })}
          </SafeLink>
        </p>
      ) : null}
    </li>
  );
}

function ZoomTabs({
  zoom,
  org,
  ws,
  runId,
}: { zoom: RunTranscript["zoom"] } & Place) {
  const t = useTranslations("run.transcript");
  return (
    <nav aria-label={t("zoomLabel")} className="flex flex-wrap gap-1">
      {TRANSCRIPT_ZOOMS.map((level) => (
        <SafeLink
          key={level}
          to={routes.run(org, ws, runId, { tab: "transcript", zoom: level })}
          aria-current={level === zoom ? "true" : undefined}
          className="inline-flex min-h-8 items-center rounded-md border border-border px-3 text-xs font-medium text-muted-foreground hover:text-foreground aria-[current=true]:border-foreground aria-[current=true]:text-foreground"
        >
          {t(`zoom.${level}`)}
        </SafeLink>
      ))}
    </nav>
  );
}

export function TranscriptSection({
  read,
  zoom,
  org,
  ws,
  runId,
}: {
  read: Read<RunTranscript>;
  /** The level the URL asked for; the read answers with the level it used. */
  zoom: RunTranscript["zoom"];
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  return (
    <Panel
      title={t("title")}
      aside={<ZoomTabs zoom={zoom} org={org} ws={ws} runId={runId} />}
    >
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : read.value.entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <>
          <ul className="flex flex-col">
            {read.value.entries.map((entry) => (
              <Entry
                key={`${entry.seq}-${entry.endSeq}`}
                entry={entry}
                org={org}
                ws={ws}
                runId={runId}
              />
            ))}
          </ul>
          <p className="pt-3 text-xs text-muted-foreground">
            {read.value.complete
              ? t("complete", {
                  count: formatCount(read.value.entries.length, locale),
                })
              : t("cut", {
                  count: formatCount(read.value.entries.length, locale),
                })}
          </p>
        </>
      )}
    </Panel>
  );
}
