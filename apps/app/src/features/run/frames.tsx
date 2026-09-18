// The Frames tab (mockup `pRun`'s player; ARCHITECTURE.md §1.2 Run row): one
// page of the run's recorded events in order, each with its own digest, the
// stage it belongs to, what it cost, and where its body went.
//
// Bodies are never inline (§3.5): a frame carries a digest, where the bytes
// were retained and what was removed before they were written, and
// `get_run_frame_body` reads them on demand. So each row states the fidelity
// the recorder kept and lists the redactions by reason, and a `digest_only`
// frame says so rather than showing an empty body.
//
// The cursor is the contract's own opaque resume point, carried in the URL, so
// a later page is a link and the run keeps one route.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import type { RunFrame, RunFramePage } from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { NoValue, Panel } from "./parts";

type Place = { org: string; ws: string; runId: string };

function Body({ body }: { body: RunFrame["body"] }) {
  const t = useTranslations("run.frames");
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">
        {t(`fidelity.${body.fidelity}`)}
      </span>
      {body.digest === null ? (
        <span className="text-xs text-muted-foreground">{t("noContent")}</span>
      ) : (
        <span className={`${mono} break-all text-[11px]`}>{body.digest}</span>
      )}
      {body.bytesRef === null ? null : (
        <span className={`${mono} break-all text-[11px] text-muted-foreground`}>
          {body.bytesRef}
        </span>
      )}
      {body.redactions.length === 0 ? null : (
        <ul data-testid="frame-redactions" className="flex flex-col gap-0.5">
          {body.redactions.map((redaction) => (
            <li
              key={redaction.originalDigest}
              className="text-[11px] text-muted-foreground"
            >
              {t("redacted", {
                path: redaction.path,
                reason: redaction.reason,
              })}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FramesPageView({
  page,
  frames,
  org,
  ws,
  runId,
}: {
  page: RunFramePage;
  /** `?frames=`, the cursor this page was read from; null is the first page. */
  frames: string | null;
} & Place) {
  const t = useTranslations("run.frames");
  const format = useFormatter();
  const locale = useLocale();
  const columns = [
    { label: t("columns.seq"), numeric: true },
    { label: t("columns.type") },
    { label: t("columns.observed") },
    { label: t("columns.body") },
    { label: t("columns.cost"), numeric: true },
  ];
  return (
    <>
      <Table label={t("title")} columns={columns}>
        {page.frames.map((frame) => (
          <tr key={frame.cursor} data-testid="frame-row">
            <td className={`${numericCell} ${mono}`}>
              {formatCount(Number(frame.seq), locale)}
            </td>
            <td className={cell}>
              <span className={`${mono} break-all font-medium`}>
                {frame.type}
              </span>
              <span className="block text-xs text-muted-foreground">
                {frame.summary}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("stage", { stage: frame.stage })}
              </span>
              <span
                className={`${mono} block break-all text-[11px] text-muted-foreground`}
              >
                {frame.digest}
              </span>
            </td>
            <td className={cell}>
              <time dateTime={frame.observedAt}>
                {format.dateTime(new Date(frame.observedAt), {
                  timeStyle: "medium",
                })}
              </time>
            </td>
            <td className={cell}>
              <Body body={frame.body} />
            </td>
            <td className={numericCell}>
              {frame.cost === null ? (
                <NoValue />
              ) : (
                <Money value={frame.cost} precision="exact" />
              )}
            </td>
          </tr>
        ))}
      </Table>
      {page.cursor === null && frames === null ? null : (
        <nav aria-label={t("pager")} className="flex gap-4 pt-3 text-sm">
          {frames === null ? null : (
            <SafeLink
              to={routes.run(org, ws, runId, { tab: "frames" })}
              className={linkText}
            >
              {t("first")}
            </SafeLink>
          )}
          {page.cursor === null ? null : (
            <SafeLink
              to={routes.run(org, ws, runId, {
                tab: "frames",
                frames: page.cursor,
              })}
              className={linkText}
            >
              {t("next")}
            </SafeLink>
          )}
        </nav>
      )}
    </>
  );
}

export function FramesSection({
  read,
  frames,
  org,
  ws,
  runId,
}: {
  /** The whole detail read: the frames page travels with the header. */
  read: Read<{ frames: RunFramePage }>;
  frames: string | null;
} & Place) {
  const t = useTranslations("run.frames");
  const locale = useLocale();
  return (
    <Panel
      title={t("title")}
      aside={
        read.ok ? (
          <span className="text-xs text-muted-foreground">
            {t("onThisPage", {
              count: formatCount(read.value.frames.frames.length, locale),
            })}
          </span>
        ) : undefined
      }
    >
      {!read.ok ? (
        <ReadFailure read={read} section={t("title")} />
      ) : read.value.frames.frames.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {frames === null ? t("empty") : t("emptyPage")}
        </p>
      ) : (
        <FramesPageView
          page={read.value.frames}
          frames={frames}
          org={org}
          ws={ws}
          runId={runId}
        />
      )}
    </Panel>
  );
}
