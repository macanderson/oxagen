// The Frames tab (mockup `pRun`'s player; ARCHITECTURE.md §1.2 Run row): one
// page of the run's recorded events in order, each with its own digest, the
// stage it belongs to, what it cost, and where its body went.
//
// Bodies are never inline (§3.5): a frame carries a digest, where the bytes
// were retained and what was removed before they were written, and
// `get_run_frame_body` reads them on demand. So each row states the fidelity
// the recorder kept and lists the redactions by reason, a `digest_only` frame
// says so rather than showing an empty body, and a frame with retained bytes
// offers to open them. The open body is `?body=<seq>`, read only when the URL
// names it, and drawn above the page it was opened from.
//
// The cursor is the contract's own opaque resume point, carried in the URL, so
// a later page is a link and the run keeps one route. It is a resume point,
// not a promise of more: the pager links onward only when the page came back
// full (`more`), and a page that came back empty keeps its way back.
import { useLocale, useTranslations } from "next-intl";
import type {
  RunFrame,
  RunFrameBody,
  RunFramePage,
} from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount, formatWholeUnits } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { cell, numericCell, Table } from "@/ui/table";
import { Fact, Facts, NoValue, Panel } from "./parts";
import { useFormatter } from "@/ui/formatter";

type Place = { org: string; ws: string; runId: string };

/** What the URL says about the page: the cursor it was read from, and the frame open on it. */
type View = {
  /** `?frames=`, the cursor this page was read from; null is the first page. */
  frames: string | null;
};

function Redactions({
  redactions,
}: {
  redactions: RunFrame["body"]["redactions"];
}) {
  const t = useTranslations("run.frames");
  if (redactions.length === 0) return null;
  return (
    <ul data-testid="frame-redactions" className="flex flex-col gap-0.5">
      {redactions.map((redaction) => (
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

function Body({
  frame,
  frames,
  org,
  ws,
  runId,
}: { frame: RunFrame } & View & Place) {
  const t = useTranslations("run.frames");
  const { body } = frame;
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
      <Redactions redactions={body.redactions} />
      {body.digest === null || body.fidelity !== "full" ? null : (
        <SafeLink
          to={routes.run(org, ws, runId, {
            tab: "actions",
            ...(frames === null ? {} : { frames }),
            body: frame.seq,
          })}
          className={`${linkText} text-xs`}
          data-testid="frame-open-body"
        >
          {t("openBody")}
        </SafeLink>
      )}
    </div>
  );
}

function Pager({
  page,
  frames,
  org,
  ws,
  runId,
}: { page: RunFramePage | null } & View & Place) {
  const t = useTranslations("run.frames");
  const more = page !== null && page.more && page.cursor !== null;
  if (frames === null && !more) return null;
  return (
    <nav aria-label={t("pager")} className="flex gap-4 pt-3 text-sm">
      {frames === null ? null : (
        <SafeLink
          to={routes.run(org, ws, runId, { tab: "actions" })}
          className={linkText}
        >
          {t("first")}
        </SafeLink>
      )}
      {more && page.cursor !== null ? (
        <SafeLink
          to={routes.run(org, ws, runId, {
            tab: "actions",
            frames: page.cursor,
          })}
          className={linkText}
        >
          {t("next")}
        </SafeLink>
      ) : null}
    </nav>
  );
}

function FramesPageView({
  page,
  frames,
  org,
  ws,
  runId,
}: { page: RunFramePage } & View & Place) {
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
    <Table label={t("title")} columns={columns}>
      {page.frames.map((frame) => (
        <tr key={frame.cursor} data-testid="frame-row">
          <td className={`${numericCell} ${mono}`}>
            {formatWholeUnits(frame.seq, locale)}
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
            <Body
              frame={frame}
              frames={frames}
              org={org}
              ws={ws}
              runId={runId}
            />
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
  );
}

/**
 * One frame's body, read by `get_run_frame_body` because the URL named it.
 * The bytes are shown as text when they are text; otherwise the panel says
 * what was retained and how much, and never draws an empty box for it.
 */
function FrameBodyPanel({
  read,
  seq,
  frames,
  org,
  ws,
  runId,
}: { read: Read<RunFrameBody>; seq: string } & View & Place) {
  const t = useTranslations("run.frames.body");
  const locale = useLocale();
  const title = t("title", { seq });
  return (
    <Panel
      title={title}
      aside={
        <SafeLink
          to={routes.run(org, ws, runId, {
            tab: "actions",
            ...(frames === null ? {} : { frames }),
          })}
          className={`${linkText} text-sm`}
          data-testid="frame-body-close"
        >
          {t("close")}
        </SafeLink>
      }
    >
      {!read.ok ? (
        <ReadFailure read={read} section={title} />
      ) : (
        <div data-testid="frame-body" className="flex flex-col gap-3">
          <Facts>
            <Fact label={t("digest")} code>
              {read.value.digest}
            </Fact>
            <Fact label={t("contentType")} code>
              {read.value.contentType ?? <NoValue />}
            </Fact>
            <Fact label={t("size")}>
              {read.value.bytes === null
                ? t("noBytes")
                : t("bytes", {
                    count: formatCount(read.value.bytes, locale),
                  })}
            </Fact>
          </Facts>
          <Redactions redactions={read.value.redactions} />
          {read.value.bytes === null ? (
            <p className="text-sm text-muted-foreground">{t("digestOnly")}</p>
          ) : read.value.text === null ? (
            <p className="text-sm text-muted-foreground">{t("notText")}</p>
          ) : (
            <pre
              className={`${mono} max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs`}
            >
              {read.value.text}
            </pre>
          )}
        </div>
      )}
    </Panel>
  );
}

export function FramesSection({
  read,
  body,
  frames,
  org,
  ws,
  runId,
}: {
  /** The whole detail read: the frames page travels with the header. */
  read: Read<{ frames: RunFramePage }>;
  /** The open frame's body, read only when `?body=` named a frame; null otherwise. */
  body: { seq: string; read: Read<RunFrameBody> } | null;
} & View &
  Place) {
  const t = useTranslations("run.frames");
  const locale = useLocale();
  const place = { org, ws, runId };
  return (
    <div className="flex flex-col gap-4">
      {body === null ? null : (
        <FrameBodyPanel
          read={body.read}
          seq={body.seq}
          frames={frames}
          {...place}
        />
      )}
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
          <>
            <p className="text-sm text-muted-foreground">
              {frames === null ? t("empty") : t("emptyPage")}
            </p>
            <Pager page={null} frames={frames} {...place} />
          </>
        ) : (
          <>
            <FramesPageView
              page={read.value.frames}
              frames={frames}
              {...place}
            />
            <Pager page={read.value.frames} frames={frames} {...place} />
          </>
        )}
      </Panel>
    </div>
  );
}
