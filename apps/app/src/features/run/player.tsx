"use client";
// The Governed actions tab's timeline and frame player (spec pages/run.md,
// Governed actions; mockup `pRun`'s player): the Timeline at the top with one
// tick per frame, the player bar, then the open frame beside the Timeline
// list.
//
// Everything here reads the frames `get_run` returned, in their recorded
// order. A frame's family (model call, tool call, governance, context,
// operator, lifecycle) is read from its recorded type and stage and nothing
// else. A turn band starts at each operator frame, because a turn is what a
// prompt starts. The player moves the viewer, never the run: stepping,
// scrubbing and replay change which frame is open and nothing on the server.
//
// A frame's bytes are not inline (§3.5). The open frame links to its body,
// which the page reads on demand as `?body=<seq>`, and that seq opens the
// player on the same frame.
import { useLocale, useTranslations } from "next-intl";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import type { ApprovalItem } from "@/data/contracts/approvals";
import { type Money as MoneyValue, sumMoney } from "@/data/contracts/money";
import type { RunFrame } from "@/data/contracts/run";
import type { RunStatus } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, linkText, mono, panel } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { useFormatter } from "@/ui/formatter";
import { formatCount, formatDuration } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";

export const FRAME_FAMILIES = [
  "model",
  "tool",
  "governance",
  "context",
  "operator",
  "lifecycle",
] as const;
export type FrameFamily = (typeof FRAME_FAMILIES)[number];

const GOVERNANCE = /polic|approv|decision|token_issued|grant|gate|verdict/i;
const OPERATOR = /prompt|steer|interject|answer|command|operator|message/i;

/**
 * The family a frame belongs to, from its recorded type and stage. A type
 * that names a decision or a person wins over the stage it was written in,
 * because a policy decision on a tool call is governance and a steer is the
 * operator speaking, whatever stage the recorder filed it under.
 */
export function frameFamily(
  frame: Pick<RunFrame, "type" | "stage">,
): FrameFamily {
  if (GOVERNANCE.test(frame.type)) return "governance";
  if (OPERATOR.test(frame.type)) return "operator";
  if (frame.stage === "model" || /model|llm/i.test(frame.type)) return "model";
  if (frame.stage === "tool" || /tool/i.test(frame.type)) return "tool";
  if (
    frame.stage === "context" ||
    /context|steering|recall|memory/i.test(frame.type)
  )
    return "context";
  return "lifecycle";
}

/** The ink each family's tick, dot and legend swatch is drawn in. */
const FAMILY_INK: Record<FrameFamily, string> = {
  model: "bg-info",
  tool: "bg-warning",
  governance: "bg-success",
  context: "bg-violet-500",
  operator: "bg-chart-4",
  lifecycle: "bg-muted-foreground",
};

/** A frame's recorded instant as a time of day, to the second. */
function useTimeOfDay() {
  const format = useFormatter();
  return (at: string) => format.dateTime(new Date(at), { timeStyle: "medium" });
}

/** A tick drawn taller: a frame that needs a person (an approval or the operator). */
function needsPerson(frame: RunFrame, family: FrameFamily): boolean {
  return family === "operator" || /approv/i.test(frame.type);
}

/** A frame that asked for a person's answer: an approval or a call blocked on one. */
const ASKS = /approv|blocked_on_user/i;

/**
 * The frame the run is parked on: the last frame that asked for an answer,
 * while the approvals read says a call on this run is still waiting. Null when
 * nothing is parked or no frame on this page asked.
 */
export function parkedIndex(
  frames: readonly RunFrame[],
  parked: boolean,
): number | null {
  if (!parked) return null;
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    if (ASKS.test(frames[index]?.type ?? "")) return index;
  }
  return null;
}

/**
 * The turn each frame sits in. The first frame opens turn 1, and every
 * operator frame after the first opens the next turn.
 */
export function turnsOf(frames: readonly RunFrame[]): number[] {
  let turn = 1;
  return frames.map((frame, index) => {
    if (index > 0 && frameFamily(frame) === "operator") turn += 1;
    return turn;
  });
}

/**
 * Sum of the priced frames up to and including `index`, with the basis the
 * frames were priced on; null when none of them is priced.
 */
function costBy(
  frames: readonly RunFrame[],
  index: number,
): { value: MoneyValue; basis: string | null } | null {
  const priced = frames
    .slice(0, index + 1)
    .flatMap((frame) => (frame.cost === null ? [] : [frame.cost]));
  const [first] = priced;
  if (first === undefined) return null;
  // Frames priced in more than one currency have no one total to show.
  const total = sumMoney(
    priced.map((cost) => ({ micros: cost.micros, currency: cost.currency })),
  );
  return total === null ? null : { value: total, basis: first.basis };
}

const SPEEDS = [1, 4, 16] as const;

type Place = {
  org: string;
  ws: string;
  runId: string;
  /** `?frames=`, the page these frames were read from; null is the first page. */
  frames: string | null;
};

function Legend({ frames }: { frames: readonly RunFrame[] }) {
  const t = useTranslations("run.player");
  const locale = useLocale();
  const counts = new Map<FrameFamily, number>();
  for (const frame of frames) {
    const family = frameFamily(frame);
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  return (
    <ul
      aria-label={t("legend")}
      data-testid="player-legend"
      className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
    >
      {FRAME_FAMILIES.map((family) => (
        <li key={family} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className={`size-2 rounded-sm ${FAMILY_INK[family]}`}
          />
          {t(`family.${family}`)}
          <span className="font-semibold tabular-nums text-foreground">
            {formatCount(counts.get(family) ?? 0, locale)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function Timeline({
  frames,
  total,
  status,
  position,
  parkedAt,
  onPick,
}: {
  frames: readonly RunFrame[];
  total: number;
  status: RunStatus;
  position: number;
  /** The frame the run is parked on, which carries the "parked · approval" mark. */
  parkedAt: number | null;
  onPick: (index: number) => void;
}) {
  const t = useTranslations("run.player");
  const locale = useLocale();
  const clock = useTimeOfDay();
  const turns = turnsOf(frames);
  const bands: { turn: number; from: number; to: number; steer: boolean }[] =
    [];
  turns.forEach((turn, index) => {
    const last = bands.at(-1);
    if (last?.turn === turn) last.to = index;
    else
      bands.push({
        turn,
        from: index,
        to: index,
        steer: index > 0 && /steer/i.test(frames[index]?.type ?? ""),
      });
  });
  const first = frames[0];
  const end = frames.at(-1);
  const elapsed =
    first === undefined || end === undefined
      ? 0
      : new Date(end.observedAt).getTime() -
        new Date(first.observedAt).getTime();
  return (
    <section
      aria-labelledby="run-player-timeline"
      data-testid="player-timeline"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex flex-wrap items-baseline gap-2">
          <h3 id="run-player-timeline" className="text-base font-semibold">
            {t("timeline")}
          </h3>
          <span
            data-testid="player-shown"
            className="text-xs text-muted-foreground"
          >
            {t("shown", {
              shown: formatCount(frames.length, locale),
              total: formatCount(total, locale),
            })}
          </span>
        </span>
        <Legend frames={frames} />
      </div>
      <div className="flex gap-1 overflow-x-auto pb-1">
        {bands.map((band) => (
          <div
            key={band.turn}
            data-testid="player-band"
            className="flex min-w-0 flex-1 flex-col gap-1"
            style={{ flexGrow: band.to - band.from + 1 }}
          >
            <span className={`${mono} text-[10.5px] uppercase text-dim`}>
              {band.steer
                ? t("turnAfterSteer", { turn: band.turn })
                : t("turn", { turn: band.turn })}
            </span>
            <div className="flex h-12 items-end gap-[3px] rounded-md border border-border bg-muted/40 px-1.5 pb-1">
              {frames.slice(band.from, band.to + 1).map((frame, offset) => {
                const index = band.from + offset;
                const family = frameFamily(frame);
                const tall = needsPerson(frame, family);
                // The spec's two marks on the Timeline: where the operator
                // steered, and the call the run is parked on.
                const mark =
                  index === parkedAt
                    ? "parked"
                    : /steer/i.test(frame.type)
                      ? "steer"
                      : null;
                return (
                  <span
                    key={frame.cursor}
                    className="relative flex shrink-0 flex-col items-center"
                  >
                    {mark === null ? null : (
                      <span
                        data-testid={`player-mark-${mark}`}
                        className={`${mono} pointer-events-none absolute bottom-full mb-0.5 whitespace-nowrap rounded border px-1 text-[9.5px] leading-tight ${mark === "parked" ? "border-info/40 bg-info/10 text-info" : "border-border bg-card text-muted-foreground"}`}
                      >
                        {t(`mark.${mark}`)}
                      </span>
                    )}
                    <button
                      key={frame.cursor}
                      type="button"
                      data-testid="player-tick"
                      data-family={family}
                      aria-label={t("tickLabel", {
                        seq: frame.seq,
                        type: frame.type,
                      })}
                      aria-pressed={index === position}
                      title={t("tickTitle", {
                        seq: frame.seq,
                        type: frame.type,
                        summary: frame.summary,
                      })}
                      onClick={() => {
                        onPick(index);
                      }}
                      className={`w-[5px] shrink-0 rounded-sm ${FAMILY_INK[family]} ${tall ? "h-7" : "h-4"} ${index === position ? "outline outline-2 outline-offset-1 outline-foreground" : ""}`}
                    />
                  </span>
                );
              })}
            </div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap justify-between gap-2 text-[11px] text-muted-foreground">
        <span className={mono}>
          {first === undefined ? null : clock(first.observedAt)}
        </span>
        <span className={mono}>
          {t("end", {
            elapsed: formatDuration(Math.max(0, elapsed), locale),
            at: end === undefined ? "" : clock(end.observedAt),
            status: t(`status.${status}`),
          })}
        </span>
      </div>
      <p className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
        <span>{t("hint")}</span>
        <span>{t("turnsInView", { count: bands.length })}</span>
      </p>
    </section>
  );
}

function Bar({
  frames,
  position,
  runCost,
  playing,
  speed,
  onPick,
  onPlay,
  onSpeed,
}: {
  frames: readonly RunFrame[];
  position: number;
  runCost: MoneyValue | null;
  playing: boolean;
  speed: number;
  onPick: (index: number) => void;
  onPlay: () => void;
  onSpeed: (speed: number) => void;
}) {
  const t = useTranslations("run.player");
  const locale = useLocale();
  const clock = useTimeOfDay();
  const frame = frames[position];
  const last = frames.length - 1;
  const spent = costBy(frames, position);
  const transport = `${buttonSecondary} min-h-11 px-2.5 sm:min-h-8`;
  return (
    <div
      data-testid="player-bar"
      className={`${panel} flex flex-col gap-2 p-3`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          aria-label={t("first")}
          className={transport}
          onClick={() => {
            onPick(0);
          }}
        >
          ⏮
        </button>
        <button
          type="button"
          aria-label={t("previous")}
          className={transport}
          disabled={position === 0}
          onClick={() => {
            onPick(position - 1);
          }}
        >
          ◀
        </button>
        <button
          type="button"
          data-testid="player-replay"
          aria-pressed={playing}
          className={transport}
          onClick={onPlay}
        >
          {playing ? t("pause") : t("replay")}
        </button>
        <button
          type="button"
          aria-label={t("next")}
          className={transport}
          disabled={position === last}
          onClick={() => {
            onPick(position + 1);
          }}
        >
          ▶
        </button>
        <button
          type="button"
          aria-label={t("last")}
          className={transport}
          onClick={() => {
            onPick(last);
          }}
        >
          ⏭
        </button>
        <input
          type="range"
          min={0}
          max={last}
          value={position}
          aria-label={t("scrub")}
          onChange={(event) => {
            onPick(Number(event.target.value));
          }}
          className="min-w-32 flex-1 accent-foreground"
        />
        <span
          data-testid="player-position"
          className={`${mono} text-xs text-muted-foreground`}
        >
          {t("position", {
            at: formatCount(position + 1, locale),
            of: formatCount(frames.length, locale),
            seq: frame?.seq ?? "",
            time: frame === undefined ? "" : clock(frame.observedAt),
          })}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <span data-testid="player-cost" className="text-muted-foreground">
          {spent === null ? (
            t("unpriced")
          ) : (
            <>
              <span className="font-semibold text-foreground">
                <Money value={spent.value} precision="exact" />
              </span>{" "}
              {runCost === null ? (
                t("byHere")
              ) : (
                <>
                  {t("of")} <Money value={runCost} /> {t("byHere")}
                </>
              )}{" "}
              <span data-testid="player-cost-basis" className={mono}>
                {spent.basis ?? t("basisNotRecorded")}
              </span>
            </>
          )}
        </span>
        <span
          className="flex items-center gap-1"
          role="group"
          aria-label={t("speed")}
        >
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => {
                onSpeed(value);
              }}
              className="min-h-11 rounded-md px-2 text-xs aria-pressed:bg-muted aria-pressed:font-semibold sm:min-h-7"
            >
              {value}×
            </button>
          ))}
        </span>
        <span className="hidden gap-2 text-[11px] text-muted-foreground sm:flex">
          {t("keys")}
        </span>
      </div>
    </div>
  );
}

/**
 * The approval the parked frame waits on, as `list_approvals` recorded it
 * (spec pages/run.md, the frame detail: the request, the call, the rule and
 * how long it has waited). The approvals read names no frame, so the card
 * pairs them only when the run has exactly one waiting call and this is the
 * frame the run is parked on. Two waiting calls cannot be told apart from
 * the frames, so the card says the drawer holds them instead of guessing.
 */
function ApprovalFacts({
  waiting,
  at,
}: {
  waiting: readonly ApprovalItem[];
  at: number;
}) {
  const t = useTranslations("run.player.approval");
  const locale = useLocale();
  const only = waiting.length === 1 ? waiting[0] : undefined;
  if (only === undefined) {
    return (
      <p
        data-testid="player-approval-many"
        className="text-xs text-muted-foreground"
      >
        {t("many", { count: waiting.length })}
      </p>
    );
  }
  return (
    <dl
      data-testid="player-approval"
      className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-md border border-info/30 bg-info/5 p-3 text-sm"
    >
      <dt className="text-muted-foreground">{t("request")}</dt>
      <dd className={`${mono} break-all text-xs`}>{only.id}</dd>
      <dt className="text-muted-foreground">{t("call")}</dt>
      <dd className={mono}>{only.tool}</dd>
      <dt className="text-muted-foreground">{t("rule")}</dt>
      <dd className={`${mono} break-all text-xs`}>
        {only.rule ?? t("noRule")}
      </dd>
      <dt className="text-muted-foreground">{t("waited")}</dt>
      <dd>
        {formatDuration(
          Math.max(0, at - new Date(only.createdAt).getTime()),
          locale,
        )}
      </dd>
    </dl>
  );
}

function FrameDetail({
  frames,
  position,
  total,
  place,
  approval,
  onPick,
}: {
  frames: readonly RunFrame[];
  position: number;
  total: number;
  place: Place;
  /** The calls waiting on a person, drawn when this frame is the parked one. */
  approval: { waiting: readonly ApprovalItem[]; at: number } | null;
  onPick: (index: number) => void;
}) {
  const t = useTranslations("run.player");
  const tf = useTranslations("run.frames");
  const locale = useLocale();
  const clock = useTimeOfDay();
  const frame = frames[position];
  if (frame === undefined) return null;
  const family = frameFamily(frame);
  return (
    <section
      aria-labelledby="run-player-frame"
      data-testid="player-frame"
      className={`${panel} flex flex-col gap-3 p-4`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="run-player-frame" className="text-base font-semibold">
          {t("frameTitle", { seq: frame.seq, type: frame.type })}
        </h3>
        {/* No tier badge: a frame records no tier of its own, and the run's
            tier printed on every frame would claim one it did not record. */}
        <span className="flex items-center gap-2">
          <time
            dateTime={frame.observedAt}
            className={`${mono} text-xs text-muted-foreground`}
          >
            {clock(frame.observedAt)}
          </time>
        </span>
      </div>
      <p className="text-sm">{frame.summary}</p>
      {approval === null ? null : (
        <ApprovalFacts waiting={approval.waiting} at={approval.at} />
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t("family.label")}</dt>
        <dd>
          <Badge tone="quiet" dot={false}>
            {t(`family.${family}`)}
          </Badge>
        </dd>
        <dt className="text-muted-foreground">{t("stage")}</dt>
        <dd className={mono}>{frame.stage}</dd>
        <dt className="text-muted-foreground">{t("digest")}</dt>
        <dd className={`${mono} break-all text-xs`}>{frame.digest}</dd>
        <dt className="text-muted-foreground">{t("body")}</dt>
        <dd className="flex flex-wrap items-center gap-2">
          <span>{tf(`fidelity.${frame.body.fidelity}`)}</span>
          {frame.body.digest === null ||
          frame.body.fidelity !== "full" ? null : (
            <SafeLink
              to={routes.run(place.org, place.ws, place.runId, {
                tab: "actions",
                ...(place.frames === null ? {} : { frames: place.frames }),
                body: frame.seq,
              })}
              className={`${linkText} text-xs`}
              data-testid="frame-open-body"
            >
              {tf("openBody")}
            </SafeLink>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("cost")}</dt>
        <dd>
          {frame.cost === null ? (
            <span className="text-muted-foreground">{t("unpricedFrame")}</span>
          ) : (
            <>
              <Money value={frame.cost} precision="exact" />{" "}
              <span className={`${mono} text-xs text-muted-foreground`}>
                {frame.cost.basis ?? t("basisNotRecorded")}
              </span>
            </>
          )}
        </dd>
      </dl>
      {frame.body.redactions.length === 0 ? null : (
        <ul data-testid="frame-redactions" className="flex flex-col gap-0.5">
          {frame.body.redactions.map((redaction) => (
            <li
              key={redaction.originalDigest}
              className="text-[11px] text-muted-foreground"
            >
              {tf("redacted", {
                path: redaction.path,
                reason: redaction.reason,
              })}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-3">
        <span className="flex gap-2">
          <button
            type="button"
            data-testid="player-previous"
            className={buttonSecondary}
            disabled={position === 0}
            onClick={() => {
              onPick(position - 1);
            }}
          >
            {t("previousFrame")}
          </button>
          <button
            type="button"
            data-testid="player-next"
            className={buttonSecondary}
            disabled={position === frames.length - 1}
            onClick={() => {
              onPick(position + 1);
            }}
          >
            {t("nextFrame")}
          </button>
        </span>
        <span className={`${mono} text-[11px] text-muted-foreground`}>
          {t("frameOf", {
            at: formatCount(position + 1, locale),
            shown: formatCount(frames.length, locale),
            total: formatCount(total, locale),
          })}
        </span>
      </div>
    </section>
  );
}

function FrameList({
  frames,
  position,
  status,
  onPick,
}: {
  frames: readonly RunFrame[];
  position: number;
  status: RunStatus;
  onPick: (index: number) => void;
}) {
  const t = useTranslations("run.player");
  return (
    <section
      aria-labelledby="run-player-list"
      data-testid="player-list"
      className={`${panel} flex flex-col p-2`}
    >
      <div className="flex items-center justify-between px-2 py-2">
        <h3 id="run-player-list" className="text-base font-semibold">
          {t("timeline")}
        </h3>
        <span className="text-xs text-muted-foreground">
          {t(`status.${status}`)}
        </span>
      </div>
      <ol className="flex max-h-[32rem] flex-col overflow-y-auto">
        {frames.map((frame, index) => {
          const family = frameFamily(frame);
          return (
            <li key={frame.cursor}>
              <button
                type="button"
                data-testid="player-row"
                aria-current={index === position ? "true" : undefined}
                onClick={() => {
                  onPick(index);
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-2 text-left text-sm hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:font-semibold sm:min-h-8"
              >
                <span
                  className={`${mono} w-8 shrink-0 text-right text-xs text-muted-foreground`}
                >
                  {frame.seq}
                </span>
                <span
                  aria-hidden="true"
                  className={`size-1.5 shrink-0 rounded-full ${FAMILY_INK[family]}`}
                />
                <span className="min-w-0 flex-1 truncate">{frame.type}</span>
                {frame.cost === null ? null : (
                  <span className="rounded border border-border px-1.5 text-[11px] text-muted-foreground">
                    <Money value={frame.cost} precision="exact" />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function FramePlayer({
  frames,
  total,
  status,
  runCost,
  openSeq,
  place,
  waiting = null,
  at = 0,
}: {
  /** The frames `get_run` returned for this page, in recorded order. */
  frames: readonly RunFrame[];
  /** Every frame the run recorded, the ones not on this page included. */
  total: number;
  status: RunStatus;
  /** The calls on this run waiting on a person; null when that read failed. */
  waiting?: readonly ApprovalItem[] | null;
  /** The instant "waited" is read against. */
  at?: number;
  /** The run's own cost, which "by here" is read against; null when not priced. */
  runCost: MoneyValue | null;
  /** `?body=`: the frame whose body is open opens the player on it. */
  openSeq: string | null;
  place: Place;
}) {
  const parkedAt = parkedIndex(frames, (waiting?.length ?? 0) > 0);
  // The player opens on the frame `?body=` names, else on the frame the run
  // is parked on, else on the last frame of the page it read.
  const start = useMemo(() => {
    const opened = frames.findIndex((frame) => frame.seq === openSeq);
    return opened === -1 ? (parkedAt ?? frames.length - 1) : opened;
  }, [frames, openSeq, parkedAt]);
  const [position, setPosition] = useState(start);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const last = frames.length - 1;
  // Playback stops on the last frame without an effect setting it back.
  const moving = playing && position < last;
  const pick = useCallback(
    (index: number) => {
      setPosition(Math.min(last, Math.max(0, index)));
    },
    [last],
  );
  useEffect(() => {
    if (!moving) return;
    const timer = setTimeout(() => {
      setPosition((at) => Math.min(last, at + 1));
    }, 1000 / speed);
    return () => {
      clearTimeout(timer);
    };
  }, [moving, position, last, speed]);
  function keys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target instanceof HTMLInputElement) return;
    const moves: Record<string, () => void> = {
      ArrowLeft: () => {
        pick(position - 1);
      },
      ArrowRight: () => {
        pick(position + 1);
      },
      Home: () => {
        pick(0);
      },
      End: () => {
        pick(last);
      },
      " ": () => {
        setPlaying(!moving);
      },
    };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    move();
  }
  return (
    // The region takes the player's keys (← → space home end) while focus
    // is inside it. Every key also has a button, so nothing needs the keys.
    <div
      data-testid="frame-player"
      onKeyDown={keys}
      className="flex flex-col gap-4"
    >
      <Timeline
        frames={frames}
        total={total}
        status={status}
        position={position}
        parkedAt={parkedAt}
        onPick={pick}
      />
      <Bar
        frames={frames}
        position={position}
        runCost={runCost}
        playing={moving}
        speed={speed}
        onPick={pick}
        onPlay={() => {
          if (position >= last) setPosition(0);
          setPlaying(!moving);
        }}
        onSpeed={setSpeed}
      />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <FrameDetail
          frames={frames}
          position={position}
          total={total}
          place={place}
          approval={
            position === parkedAt && waiting !== null && waiting.length > 0
              ? { waiting, at }
              : null
          }
          onPick={pick}
        />
        <FrameList
          frames={frames}
          position={position}
          status={status}
          onPick={pick}
        />
      </div>
    </div>
  );
}
