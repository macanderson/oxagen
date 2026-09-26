// The open frame and the frame list of the Governed actions tab (mockup
// `pRun`'s player split: "Frame N" with `frameDetail` beside the "Timeline"
// list; ARCHITECTURE.md §1.2 Run row).
//
// Bodies are never inline (§3.5): a frame carries a digest, where the bytes
// were retained and what was removed before they were written, and
// `get_run_frame_body` reads them on demand, for the open frame only. So the
// detail states the fidelity the recorder kept and lists the redactions by
// reason, a `digest_only` frame says so rather than showing an empty body, and
// a frame with retained bytes shows them as text when they are text.
//
// The page of frames is the contract's own, with its opaque cursor carried in
// the URL, so a later page is a link and the run keeps one route. The cursor
// is a resume point, not a promise of more: the pager links onward only when
// the page came back full (`more`), and a page that came back empty keeps its
// way back.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  RunFrame,
  RunFrameBody,
  RunFramePage,
  TranscriptEntry,
} from "@/data/contracts/run";
import type { EnforcementTier } from "@/data/contracts/runs";
import type { Read } from "@/data/read";
import type { SafePath } from "@/shared/safe-path";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  eyebrowQuiet,
  linkText,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { EnforcementTierBadge } from "@/ui/enforcement-tier";
import { useFormatter } from "@/ui/formatter";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { ReadFailure } from "@/ui/read-failure";
import { frameKey } from "./frame-link";
import { FrameListBox } from "./frame-player";
import { Fact, Facts, NoValue } from "./parts";
import { StepLink } from "./player-bar";
import { MARK_HUE } from "./player-hues";
import {
  decisionOf,
  markOf,
  type OpenFrame,
  presentedType,
  type RunState,
  type Steps,
} from "./player-model";

/** `.btn.sm { padding:4px 9px; font-size:12px; border-radius:7px }` over `.btn`. A phone keeps the 44px target. */
const smallButton =
  "inline-flex items-center gap-1.5 rounded-[7px] border border-button-default-border bg-button-default-bg px-[9px] py-1 text-xs font-medium text-button-default-fg transition-colors hover:border-rule hover:bg-button-default-hover-bg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11";

/**
 * `.navitem { display:flex; align-items:center; gap:10px; padding:7px 9px;
 * border-radius:8px; color:var(--muted); font-weight:500 }` at `.fp-item`'s
 * 12px, `:hover { background:var(--hl); color:var(--fg) }`.
 */
const listItem =
  "flex w-full items-center gap-2.5 rounded-lg px-[9px] py-[7px] text-xs font-medium text-muted-foreground no-underline transition-colors hover:bg-hl hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring";
/** The open frame: `background:var(--hl); box-shadow:inset 2px 0 0 var(--gold); color:var(--fg)`. */
const listItemOn = "bg-hl text-foreground shadow-[inset_2px_0_0_var(--gold)]";
/** `.navitem .ct { margin-left:auto; font-family:var(--mono); font-size:10.5px; color:var(--dim); background:var(--panel); border:1px solid var(--border); border-radius:5px; padding:0 5px }` */
const costChip =
  "ml-auto whitespace-nowrap rounded-[5px] border border-border bg-card px-[5px] font-mono text-[10.5px] text-dim";

const DECISION_TONE: Record<string, BadgeTone> = {
  allow: "allowed",
  deny: "denied",
  ask: "approval",
  defer: "approval",
};

/** The frames whose record is a decision, so a missing one reads "not recorded". */
const DECIDES: ReadonlySet<string> = new Set([
  "policy_decision",
  "approval_decision",
]);

/** A frame's key (`frameKey`) as the one link that opens the frame. */
type HrefOf = (key: string) => SafePath;

function Redactions({
  redactions,
}: {
  redactions: RunFrame["body"]["redactions"];
}) {
  const t = useTranslations("run.frames");
  if (redactions.length === 0) return null;
  return (
    <ul
      data-testid="frame-redactions"
      className="m-0 flex list-none flex-col gap-0.5 p-0"
    >
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

/** The envelope the page holds for the frame: when, where, what it cost, and what the recorder kept. */
function FrameFacts({
  frame,
  entry,
  chainRef,
}: {
  frame: RunFrame | null;
  entry: TranscriptEntry | undefined;
  /** The subagent chain the frame was recorded on; absent on the run's own. */
  chainRef: string | undefined;
}) {
  const t = useTranslations("run.frames");
  const format = useFormatter();
  const at = frame?.observedAt ?? entry?.at ?? null;
  const cost = frame === null ? (entry?.cost ?? null) : frame.cost;
  const decision = decisionOf(entry);
  const type = frame?.type ?? entry?.type ?? null;
  return (
    <Facts>
      <Fact label={t("recorded")}>
        {at === null ? (
          <NoValue />
        ) : (
          <time dateTime={at}>
            {format.dateTime(new Date(at), {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </time>
        )}
      </Fact>
      {chainRef === undefined ? null : (
        <Fact label={t("chain")} code>
          {chainRef}
        </Fact>
      )}
      {frame === null ? null : (
        <Fact label={t("stage")} code>
          {frame.stage}
        </Fact>
      )}
      <Fact label={t("turn")}>
        {entry === undefined ? (
          <NoValue />
        ) : entry.turn === null ? (
          t("beforeTurns")
        ) : (
          t("turnValue", { turn: entry.turn })
        )}
      </Fact>
      {decision === null && (type === null || !DECIDES.has(type)) ? null : (
        <Fact label={t("decision")}>
          {decision === null ? (
            <NoValue />
          ) : (
            <Badge tone={DECISION_TONE[decision] ?? "quiet"}>{decision}</Badge>
          )}
        </Fact>
      )}
      <Fact label={t("cost")}>
        {cost === null ? (
          <NoValue />
        ) : (
          <span data-testid="frame-cost">
            <Money value={cost} precision="exact" />{" "}
            <span className="text-muted-foreground">
              {cost.basis ?? t("basisNotRecorded")}
            </span>
          </span>
        )}
      </Fact>
      {frame === null ? null : (
        <>
          <Fact label={t("digest")} code>
            {frame.digest}
          </Fact>
          <Fact label={t("body")}>
            {frame.body.digest === null
              ? t("noContent")
              : t(`fidelity.${frame.body.fidelity}`)}
          </Fact>
          {frame.body.digest === null ? null : (
            <Fact label={t("bodyDigest")} code>
              {frame.body.digest}
            </Fact>
          )}
          {frame.body.bytesRef === null ? null : (
            <Fact label={t("retainedAt")} code>
              {frame.body.bytesRef}
            </Fact>
          )}
        </>
      )}
    </Facts>
  );
}

/**
 * The open frame's body, read by `get_run_frame_body`. The bytes are shown as
 * text when they are text; otherwise the block says what was retained and how
 * much, and never draws an empty box for it.
 */
function FrameBody({
  frame,
  seq,
  read,
  open,
}: {
  frame: RunFrame | null;
  seq: string;
  /** Null when nothing was read: the URL did not name the frame, or it retained no bytes. */
  read: Read<RunFrameBody> | null;
  /** The link that names the frame, which reads its body. */
  open: SafePath;
}) {
  const t = useTranslations("run.frames.read");
  const locale = useLocale();
  if (read === null) {
    if (frame === null || frame.body.digest === null) return null;
    if (frame.body.fidelity === "full")
      return (
        <SafeLink
          to={open}
          data-testid="frame-open-body"
          className={`${linkText} self-start text-[12.5px]`}
        >
          {t("open")}
        </SafeLink>
      );
    return (
      <p
        data-testid="frame-body"
        className="m-0 text-[12.5px] text-muted-foreground"
      >
        {t("digestOnly")}
      </p>
    );
  }
  const title = t("title", { seq });
  if (!read.ok) return <ReadFailure read={read} section={title} />;
  const body = read.value;
  return (
    <div data-testid="frame-body" className="flex min-w-0 flex-col gap-2">
      <p className={`${eyebrowQuiet} m-0`}>{t("heading")}</p>
      <p className="m-0 flex flex-wrap gap-x-3 text-[11.5px] text-muted-foreground">
        <span className={mono}>{body.contentType ?? t("noType")}</span>
        <span>
          {body.bytes === null
            ? t("noBytes")
            : t("bytes", { count: formatCount(body.bytes, locale) })}
        </span>
        <span className={`${mono} break-all`}>{body.digest}</span>
      </p>
      <Redactions redactions={body.redactions} />
      {body.bytes === null ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("digestOnly")}
        </p>
      ) : body.text === null ? (
        <p className="m-0 text-[12.5px] text-muted-foreground">
          {t("notText")}
        </p>
      ) : (
        <pre
          className={`${mono} m-0 max-h-[26rem] overflow-auto whitespace-pre-wrap break-words rounded-md bg-code-bg p-3 text-xs`}
        >
          {body.text}
        </pre>
      )}
    </div>
  );
}

/**
 * "Frame N" and its kind, the run's recorded tier and the frame's instant,
 * the summary, the detail, and ◀ Previous and Next ▶ with where the frame
 * sits among those shown.
 */
export function FramePanel({
  open,
  entry,
  tier,
  body,
  approvals,
  control = null,
  steps,
  hrefOf,
  shown,
  total,
}: {
  open: OpenFrame;
  entry: TranscriptEntry | undefined;
  /** The run's recorded enforcement tier: every frame of the run was recorded under it. */
  tier: EnforcementTier;
  body: Read<RunFrameBody> | null;
  /** The parked call or the decision this frame records, when it is an approval frame. */
  approvals: ReactNode;
  /** The operator's command this frame records, when it is a command frame (#2953). */
  control?: ReactNode;
  steps: Steps;
  hrefOf: HrefOf;
  shown: number;
  total: number;
}) {
  const t = useTranslations("run.frames");
  const locale = useLocale();
  const format = useFormatter();
  const { frame } = open;
  const recorded = frame?.type ?? entry?.type ?? null;
  // An operator's command reads as `control.<command>` (ADR-056).
  const type = recorded === null ? null : presentedType(recorded, entry);
  const at = frame?.observedAt ?? entry?.at ?? null;
  const summary = frame?.summary ?? entry?.label ?? null;
  return (
    <section
      aria-labelledby="run-frame-title"
      data-testid="frame-open"
      data-seq={open.seq}
      className={panel}
    >
      <div className={panelHeader}>
        <h3 id="run-frame-title" className={panelTitle}>
          {t("title", { seq: open.seq })}
          {type === null ? null : (
            <>
              {" "}
              <span className={mono}>{type}</span>
            </>
          )}
        </h3>
        <div className="ml-auto flex min-w-0 flex-wrap items-center gap-[7px]">
          <EnforcementTierBadge tier={tier} />
          {at === null ? null : (
            <time dateTime={at} className={`${mono} text-[11px] text-dim`}>
              {format.dateTime(new Date(at), {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                fractionalSecondDigits: 3,
                hourCycle: "h23",
              })}
            </time>
          )}
        </div>
      </div>
      <div className={`${panelBody} flex flex-col gap-3.5`}>
        {frame === null ? (
          <p
            data-testid="frame-off-page"
            className="m-0 text-[12.5px] text-muted-foreground"
          >
            {open.chainRef === undefined
              ? t("offPage", { seq: open.seq })
              : t("chainOffPage", { seq: open.seq })}
          </p>
        ) : null}
        {summary === null ? null : (
          <p className="m-0 break-words text-[13.5px] text-foreground">
            {summary}
          </p>
        )}
        {approvals}
        {control}
        <FrameFacts frame={frame} entry={entry} chainRef={open.chainRef} />
        {frame === null || (body !== null && body.ok) ? null : (
          // The body read lists its own redactions; without it, the envelope's.
          <Redactions redactions={frame.body.redactions} />
        )}
        <FrameBody
          frame={frame}
          seq={open.seq}
          read={body}
          open={hrefOf(frameKey(open))}
        />
        {/* `.row` with `margin-top:16px; border-top:1px solid var(--border); padding-top:13px` */}
        <div className="mt-0.5 flex flex-wrap items-center gap-[9px] border-t border-border pt-[13px]">
          <StepLink
            to={steps.prev === null ? null : hrefOf(steps.prev)}
            className={smallButton}
            testId="frame-previous"
          >
            <span aria-hidden="true">◀</span> {t("previous")}
          </StepLink>
          <StepLink
            to={steps.next === null ? null : hrefOf(steps.next)}
            className={smallButton}
            testId="frame-next"
          >
            {t("next")} <span aria-hidden="true">▶</span>
          </StepLink>
          <span
            data-testid="frame-position"
            className={`${mono} ml-auto text-[11px] text-dim`}
          >
            {open.index < 0
              ? t("positionOff", {
                  shown: formatCount(shown, locale),
                  total: formatCount(total, locale),
                })
              : t("position", {
                  index: formatCount(open.index + 1, locale),
                  shown: formatCount(shown, locale),
                  total: formatCount(total, locale),
                })}
          </span>
        </div>
      </div>
    </section>
  );
}

/**
 * The "Timeline" list beside the open frame: every frame on the page with its
 * seq, the hue of how it went, its type and its recorded cost, and whether
 * the run is live, paused, sealed or halted.
 */
export function FrameList({
  frames,
  entries,
  openSeq,
  hrefOf,
  state,
}: {
  frames: readonly RunFrame[];
  entries: ReadonlyMap<string, TranscriptEntry>;
  /** The open frame's seq; null when the open frame is on a subagent's chain, which the page does not list. */
  openSeq: string | null;
  hrefOf: HrefOf;
  state: RunState;
}) {
  const t = useTranslations("run.frames.list");
  return (
    // Not a landmark: the page already has a "Timeline" region above it.
    <div data-testid="frame-list" className={panel}>
      <div className={panelHeader}>
        <h3 className={panelTitle}>{t("title")}</h3>
        <span
          data-testid="frame-list-state"
          className="ml-auto text-[11px] text-dim"
        >
          {t(`state.${state}`)}
        </span>
      </div>
      <FrameListBox label={t("label")}>
        <ol className="m-0 flex list-none flex-col gap-px p-0">
          {frames.map((frame) => {
            const mark = markOf(
              frame.type,
              decisionOf(entries.get(frame.seq)),
              frame.toolStatus,
            );
            const on = frame.seq === openSeq;
            return (
              <li key={frame.cursor}>
                <SafeLink
                  to={hrefOf(frame.seq)}
                  data-testid="frame-row"
                  aria-current={on ? "true" : undefined}
                  className={`${listItem} ${on ? listItemOn : ""}`}
                >
                  <span className="min-w-[22px] flex-none text-right font-mono text-dim">
                    {frame.seq}
                  </span>
                  {/* `.fp-dot { width:6px; height:6px; border-radius:50% }` */}
                  <span
                    aria-hidden="true"
                    className={`size-1.5 flex-none rounded-full ${mark === null ? "bg-transparent" : MARK_HUE[mark]}`}
                  />
                  <span className="min-w-0 truncate">
                    {presentedType(frame.type, entries.get(frame.seq))}
                  </span>
                  {frame.cost === null ? null : (
                    <span
                      className={costChip}
                      title={frame.cost.basis ?? t("basisNotRecorded")}
                    >
                      <Money value={frame.cost} precision="exact" />
                    </span>
                  )}
                </SafeLink>
              </li>
            );
          })}
        </ol>
      </FrameListBox>
    </div>
  );
}

/** "First frames" and "Later frames", when there is another page to reach. */
export function FramesPager({
  page,
  cursor,
  first,
  later,
}: {
  page: RunFramePage;
  /** `?frames=`, the cursor this page was read from; null is the first page. */
  cursor: string | null;
  first: SafePath;
  later: (cursor: string) => SafePath;
}) {
  const t = useTranslations("run.frames");
  const more = page.more && page.cursor !== null;
  if (cursor === null && !more) return null;
  return (
    <nav aria-label={t("pager")} className="flex gap-3">
      {cursor === null ? null : (
        <SafeLink to={first} className={linkText}>
          {t("first")}
        </SafeLink>
      )}
      {more && page.cursor !== null ? (
        <SafeLink to={later(page.cursor)} className={linkText}>
          {t("later")}
        </SafeLink>
      ) : null}
    </nav>
  );
}

/**
 * A page with no frames on it: the run has recorded none yet, or the page the
 * URL resumed from lies past the last one. The way back stays either way.
 */
export function FramesEmpty({
  cursor,
  pager,
}: {
  /** `?frames=`, the cursor this page was read from; null is the first page. */
  cursor: string | null;
  pager: ReactNode;
}) {
  const t = useTranslations("run.frames");
  return (
    <section aria-labelledby="run-frames-empty" className={panel}>
      <div className={panelHeader}>
        <h3 id="run-frames-empty" className={panelTitle}>
          {t("emptyTitle")}
        </h3>
      </div>
      <div className={`${panelBody} flex flex-col gap-2 text-sm`}>
        <p data-testid="frames-empty" className="m-0 text-muted-foreground">
          {cursor === null ? t("empty") : t("emptyPage")}
        </p>
        {pager}
      </div>
    </section>
  );
}
