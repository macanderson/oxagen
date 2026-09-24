// The Governed actions tab (spec pages/run.md, Governed actions; mockup
// `pRun`'s player): the Timeline, the frame player and the Timeline list over
// one page of the run's recorded frames, drawn by `FramePlayer`.
//
// Bodies are never inline (§3.5): a frame carries a digest, where the bytes
// were retained and what was removed before they were written, and
// `get_run_frame_body` reads them on demand. The open body is `?body=<seq>`,
// read only when the URL names it, drawn above the player, and the player
// opens on the same frame.
//
// The cursor is the contract's own opaque resume point, carried in the URL, so
// a later page is a link and the run keeps one route. It is a resume point,
// not a promise of more: the pager links onward only when the page came back
// full (`more`), and a page that came back empty keeps its way back.
//
// Approvals are not drawn here. The approvals drawer owns them on every page.
import { useLocale, useTranslations } from "next-intl";
import type {
  RunFrame,
  RunFrameBody,
  RunFramePage,
} from "@/data/contracts/run";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { RunRow } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { Fact, Facts, NoValue, Panel } from "./parts";
import { FramePlayer } from "./player";

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

export function GovernedActionsSection({
  read,
  body,
  frames,
  run,
  waiting = null,
  at = 0,
  org,
  ws,
  runId,
}: {
  /** The whole detail read: the frames page travels with the header. */
  read: Read<{ frames: RunFramePage }>;
  /** The open frame's body, read only when `?body=` named a frame; null otherwise. */
  body: { seq: string; read: Read<RunFrameBody> } | null;
  /** The run the frames belong to: its frame total, status and cost. */
  run: Pick<RunRow, "frames" | "status" | "cost">;
  /**
   * The calls on this run waiting on a person (`list_approvals` narrowed to
   * the run); null when that read failed. The parked frame's card prints the
   * one it is waiting on.
   */
  waiting?: readonly ApprovalItem[] | null;
  /** The instant "waited" is read against. */
  at?: number;
} & View &
  Place) {
  const t = useTranslations("run.frames");
  const place = { org, ws, runId };
  if (!read.ok) return <ReadFailure read={read} section={t("title")} />;
  const page = read.value.frames;
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
      {page.frames.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {frames === null ? t("empty") : t("emptyPage")}
        </p>
      ) : (
        <FramePlayer
          frames={page.frames}
          total={run.frames}
          status={run.status}
          runCost={run.cost}
          waiting={waiting}
          at={at}
          openSeq={body?.seq ?? null}
          place={{ ...place, frames }}
        />
      )}
      <Pager
        page={page.frames.length === 0 ? null : page}
        frames={frames}
        {...place}
      />
    </div>
  );
}
