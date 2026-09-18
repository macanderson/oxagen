"use client";
// One entry of the transcript, and the two halves of the exchange it records
// (spec §14, Appendix F page 2).
//
// A tool step shows the tool, what it was called with and what it returned. A
// model exchange shows what was sent and what came back. Both halves are
// folded shut, because a run carries hundreds of them and an open page of
// bodies is unreadable; opening one is one click and costs no read, because
// the body travelled with the entry.
//
// Nothing here fills a gap. A half whose bytes were not retained says the body
// was not recorded and why, an entry with neither half says so, a half the
// contract cut at its ceiling says it was cut and links to the whole body on
// the Frames tab, and every removal the redactor made is listed with its
// reason. An empty box pretending to be content is the one thing this file
// exists to prevent.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { TranscriptBody, TranscriptEntry } from "@/data/contracts/run";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatDuration } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";

export type Place = { org: string; ws: string; runId: string };

function Redactions({ half }: { half: TranscriptBody }) {
  const t = useTranslations("run.transcript");
  if (half.redactions.length === 0) return null;
  return (
    <ul data-testid="entry-redactions" className="flex flex-col gap-0.5">
      {half.redactions.map((redaction) => (
        <li
          key={redaction.originalDigest}
          className="text-[11px] text-muted-foreground"
        >
          {t("redacted", { path: redaction.path, reason: redaction.reason })}
        </li>
      ))}
    </ul>
  );
}

/**
 * One half of the exchange: what went out, or what came back. Folded shut, and
 * the summary line says what is inside before it is opened, so a half with no
 * body can be read without opening anything.
 */
function Half({
  half,
  label,
  org,
  ws,
  runId,
}: { half: TranscriptBody; label: string } & Place) {
  const t = useTranslations("run.transcript");
  const missing = half.text === null;
  return (
    <details
      data-testid="transcript-half"
      data-half={label}
      className="rounded-md border border-border"
    >
      <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2 text-xs">
        <span className="font-medium">{label}</span>
        <span className="text-muted-foreground">
          {t(`fidelity.${half.fidelity}`)}
        </span>
        <span className={`${mono} break-all text-[11px] text-muted-foreground`}>
          {half.digest ?? t("noDigest")}
        </span>
      </summary>
      <div className="flex flex-col gap-1.5 border-t border-border px-3 py-2">
        {missing ? (
          <p
            data-testid="entry-no-body"
            className="max-w-prose text-xs text-muted-foreground"
          >
            {t(half.fidelity === "digest_only" ? "digestOnly" : "noBody")}
          </p>
        ) : (
          <pre
            className={`${mono} max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs`}
          >
            {half.text}
          </pre>
        )}
        <Redactions half={half} />
        {half.truncated ? (
          <p
            data-testid="entry-truncated"
            className="text-xs text-muted-foreground"
          >
            {t("truncated")}{" "}
            <SafeLink
              to={routes.run(org, ws, runId, { tab: "frames", body: half.seq })}
              className={linkText}
            >
              {t("openFrame", { seq: half.seq })}
            </SafeLink>
          </p>
        ) : null}
      </div>
    </details>
  );
}

export function Entry({
  entry,
  current,
  org,
  ws,
  runId,
}: {
  entry: TranscriptEntry;
  /** True when the playhead stands on this entry. */
  current: boolean;
} & Place) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  const locale = useLocale();
  const span =
    entry.seq === entry.endSeq
      ? t("frame", { seq: entry.seq })
      : t("frames", { from: entry.seq, to: entry.endSeq });
  // A tool call was called with its input and returned its output; every other
  // kind sent and received. The words differ because the actions differ.
  const sent = entry.kind === "tool_call" ? t("calledWith") : t("request");
  // Held in a local so the renderer closes over a value the compiler has
  // already narrowed, rather than re-reading a nullable field inside it.
  const running = entry.cumulativeCost;
  return (
    <li
      data-testid="transcript-entry"
      data-kind={entry.kind}
      data-seq={entry.seq}
      data-current={current ? "true" : undefined}
      aria-current={current ? "step" : undefined}
      className={`flex flex-col gap-1.5 border-l-2 py-3 pl-3 ${
        current ? "border-l-foreground bg-muted/40" : "border-l-transparent"
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">
          {t(`kind.${entry.kind}`)}
        </span>
        <span className={`${mono} break-all`}>{entry.label}</span>
        <span className={mono}>{span}</span>
        <time dateTime={entry.at}>
          {format.dateTime(new Date(entry.at), { timeStyle: "medium" })}
        </time>
        <span data-testid="entry-elapsed">
          {t("elapsed", { elapsed: formatDuration(entry.elapsedMs, locale) })}
        </span>
        {entry.cost === null ? null : (
          <span>
            <Money value={entry.cost} precision="exact" />
          </span>
        )}
        {running === null ? null : (
          <span data-testid="entry-cumulative">
            {t.rich("cumulative", {
              cost: () => <Money value={running} precision="exact" />,
            })}
          </span>
        )}
        <span>{t("folded", { count: formatCount(entry.frames, locale) })}</span>
      </div>
      {entry.decision === null ? null : (
        <p
          data-testid="entry-decision"
          className="text-xs text-muted-foreground"
        >
          {t("decision", {
            decision: entry.decision.decision,
            seq: entry.decision.seq,
          })}
        </p>
      )}
      {entry.request === null && entry.response === null ? (
        <p
          data-testid="entry-no-halves"
          className="text-xs text-muted-foreground"
        >
          {t("noHalves")}
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {entry.request === null ? null : (
            <Half
              half={entry.request}
              label={sent}
              org={org}
              ws={ws}
              runId={runId}
            />
          )}
          {entry.response === null ? null : (
            <Half
              half={entry.response}
              label={t("response")}
              org={org}
              ws={ws}
              runId={runId}
            />
          )}
        </div>
      )}
    </li>
  );
}
