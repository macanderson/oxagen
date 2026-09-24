// The Governed actions tab's Timeline (mockup `runTimeline`, engine.css
// `.rt-*`): the page's frames as ticks on a track laid out by their recorded
// instants, one hue per frame kind, the turns the transcript placed them in as
// bands behind them, and "steer" and "parked · approval" over the frames that
// carry them. Every tick is a link that opens its frame in the player below.
//
// It draws the page of frames `get_run` answered, so its caption says how many
// that is against the run's own count, and the pager to the next page sits in
// its foot.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RunFrame, TranscriptEntry } from "@/data/contracts/run";
import type { SafePath } from "@/shared/safe-path";
import { mono, panel, panelTitle } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount, formatDuration, ratioWidth } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { KIND_HUE } from "./player-hues";
import {
  type Band,
  decisionOf,
  isParked,
  kindCounts,
  kindOf,
  type TimelineMark,
} from "./player-model";

/**
 * `.panel-h { display:flex; align-items:center; gap:10px; padding:12px 16px;
 * border-bottom:1px solid var(--border) }` with the count set right after the
 * title and `.rt-leg { margin-left:auto }` pushing the legend right, so this
 * header does not spread its three parts the way the two-part recipe does.
 */
const timelineHeader =
  "flex flex-wrap items-center gap-x-2.5 gap-y-1.5 border-b border-border px-4 py-3";

/**
 * `.rt-tick { position:absolute; bottom:16px; width:4px; height:18px;
 * margin-left:-2px; background:var(--c); border-radius:2px 2px 0 0;
 * box-shadow:0 0 0 2px var(--panel) }`, `.rt-tick::before { inset:-6px -8px }`
 * for the hit area, and `:hover, :focus-visible { filter:brightness(1.2);
 * z-index:3 }`.
 */
const tick =
  "absolute bottom-4 -ml-0.5 w-1 rounded-t-[2px] shadow-[0_0_0_2px_var(--panel)] before:absolute before:-inset-x-2 before:-inset-y-1.5 before:content-[''] hover:z-[3] hover:brightness-125 focus-visible:z-[3] focus-visible:brightness-125 focus-visible:outline-none";
/** `.rt-tick.tall { height:30px }`, `.rt-tick.cost { height:24px }`, and the resting 18px. */
const TICK_HEIGHT = { tall: "h-[30px]", cost: "h-6", rest: "h-[18px]" };
/** `.rt-tick.on { outline:2px solid var(--fg); outline-offset:1px; z-index:2 }` */
const tickOn = "z-[2] outline-2 outline-offset-1 outline-foreground";

/** A cost the record carries and that is more than nothing. */
function spent(frame: RunFrame): boolean {
  return frame.cost !== null && /[1-9]/.test(frame.cost.micros);
}

function Legend({ frames }: { frames: readonly RunFrame[] }) {
  const t = useTranslations("run.player.timeline");
  const locale = useLocale();
  return (
    // `.rt-leg { display:flex; gap:4px 12px; flex-wrap:wrap; font-size:11px; color:var(--muted); margin-left:auto }`
    <ul
      aria-label={t("legendLabel")}
      className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground"
    >
      {kindCounts(frames).map(({ kind, count }) => (
        <li
          key={kind}
          data-testid={`legend-${kind}`}
          className="inline-flex items-center gap-[5px] tabular-nums"
        >
          {/* `.rt-leg i { width:8px; height:8px; border-radius:2px; background:var(--c) }` */}
          <i
            aria-hidden="true"
            className={`size-2 flex-none rounded-[2px] ${KIND_HUE[kind]}`}
          />
          {t(`legend.${kind}`)}{" "}
          <b className="font-semibold text-foreground">
            {formatCount(count, locale)}
          </b>
        </li>
      ))}
    </ul>
  );
}

/** A band's label: `w<14 ? 't'+n : 'turn '+n`, so a narrow band keeps the number alone. */
function BandLabel({ band }: { band: Band }) {
  const t = useTranslations("run.player.timeline");
  if (band.width < 14) return t("turnShort", { turn: band.turn });
  return band.afterSteer
    ? t("turnAfterSteer", { turn: band.turn })
    : t("turn", { turn: band.turn });
}

export function RunTimeline({
  frames,
  xs,
  bands,
  marks,
  entries,
  total,
  openSeq,
  hrefOf,
  live,
  pager,
}: {
  frames: readonly RunFrame[];
  /** Each frame's left edge in percent (`tickPositions`). */
  xs: readonly number[];
  bands: readonly Band[];
  marks: readonly TimelineMark[];
  entries: ReadonlyMap<string, TranscriptEntry>;
  /** The run's own frame count. */
  total: number;
  openSeq: string | null;
  hrefOf: (seq: string) => SafePath;
  /** The run is still recording, so the axis ends on "live". */
  live: boolean;
  /** The links to the other pages of frames, when there are any. */
  pager: ReactNode;
}) {
  const t = useTranslations("run.player.timeline");
  const locale = useLocale();
  const format = useFormatter();
  const first = frames[0];
  const last = frames.at(-1);
  const clock = (iso: string) =>
    format.dateTime(new Date(iso), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  return (
    <section
      aria-labelledby="run-timeline-title"
      data-testid="run-timeline"
      className={panel}
    >
      <div className={timelineHeader}>
        <h3 id="run-timeline-title" className={panelTitle}>
          {t("title")}
        </h3>
        <span
          data-testid="timeline-shown"
          className={`${mono} text-[11px] text-dim`}
        >
          {t("shown", {
            shown: formatCount(frames.length, locale),
            total: formatCount(total, locale),
          })}
        </span>
        <Legend frames={frames} />
      </div>
      {/* `.rt .panel-b { padding:12px 16px 10px }` */}
      <div className="px-4 pb-2.5 pt-3">
        {/* `.rt-turns { position:relative; height:16px; font-family:var(--mono); font-size:10px; color:var(--dim); letter-spacing:.06em; text-transform:uppercase }` */}
        <div
          aria-hidden="true"
          className="relative h-4 font-mono text-[10px] uppercase tracking-[0.06em] text-dim"
        >
          {bands.map((band) => (
            <span
              key={`${String(band.turn)}:${String(band.left)}`}
              data-testid="timeline-turn"
              // `.rt-turns span { position:absolute; top:1px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; padding-left:2px }`
              className="absolute top-px truncate pl-0.5"
              style={{
                left: ratioWidth(band.left / 100),
                width: ratioWidth(band.width / 100),
              }}
            >
              <BandLabel band={band} />
            </span>
          ))}
        </div>
        {/* `.rt-track { position:relative; height:50px; margin:2px 0 0 }` */}
        <div className="relative mt-0.5 h-[50px]">
          {bands.map((band) => (
            <div
              key={`${String(band.turn)}:${String(band.left)}`}
              aria-hidden="true"
              // `.rt-band { position:absolute; top:0; bottom:16px; background:var(--hl); border-radius:6px; border:1px solid var(--border) }`, `.alt { background:transparent }`
              className={`absolute bottom-4 top-0 rounded-md border border-border ${band.alt ? "bg-transparent" : "bg-hl"}`}
              style={{
                left: ratioWidth(band.left / 100),
                width: ratioWidth(band.width / 100),
              }}
            />
          ))}
          {frames.map((frame, i) => {
            const kind = kindOf(frame.type);
            const parked = isParked(
              frame.type,
              decisionOf(entries.get(frame.seq)),
            );
            const height =
              kind === "op" || parked
                ? TICK_HEIGHT.tall
                : spent(frame)
                  ? TICK_HEIGHT.cost
                  : TICK_HEIGHT.rest;
            const on = frame.seq === openSeq;
            return (
              <SafeLink
                key={frame.cursor}
                to={hrefOf(frame.seq)}
                data-testid="timeline-tick"
                data-kind={kind}
                aria-current={on ? "true" : undefined}
                aria-label={t("tick", { seq: frame.seq, type: frame.type })}
                title={t("tickTitle", {
                  tick: t("tick", { seq: frame.seq, type: frame.type }),
                  clock: clock(frame.observedAt),
                  summary: frame.summary,
                })}
                className={`${tick} ${height} ${KIND_HUE[kind]} ${on ? tickOn : ""}`}
                style={{ left: ratioWidth((xs[i] ?? 0) / 100) }}
              />
            );
          })}
          {first === undefined || last === undefined ? null : (
            // `.rt-axis { position:absolute; left:0; right:0; bottom:0; height:14px; border-top:1px solid var(--border); display:flex; justify-content:space-between; font-family:var(--mono); font-size:10px; color:var(--dim); padding-top:2px }`
            <div
              data-testid="timeline-axis"
              className="absolute inset-x-0 bottom-0 flex h-3.5 justify-between border-t border-border pt-0.5 font-mono text-[10px] text-dim"
            >
              <span>{clock(first.observedAt)}</span>
              <span>
                {t(live ? "endLive" : "end", {
                  elapsed: formatDuration(
                    Math.max(
                      0,
                      Date.parse(last.observedAt) -
                        Date.parse(first.observedAt),
                    ),
                    locale,
                  ),
                  end: clock(last.observedAt),
                })}
              </span>
            </div>
          )}
        </div>
        {/* `.rt-marks { position:relative; height:14px; margin-top:3px }`, hidden on a phone */}
        <div
          aria-hidden="true"
          className="relative mt-[3px] h-3.5 max-md:hidden"
        >
          {marks.map((mark) => (
            <span
              key={`${mark.kind}:${String(mark.at)}`}
              data-testid={`timeline-mark-${mark.kind}`}
              // `.rt-mark { position:absolute; top:0; transform:translateX(-50%); font-family:var(--mono); font-size:10px; color:var(--muted); white-space:nowrap }`, `.right { transform:translateX(-100%) }`
              className={`pointer-events-none absolute top-0 whitespace-nowrap font-mono text-[10px] text-muted-foreground ${mark.kind === "parked" ? "-translate-x-full" : "-translate-x-1/2"}`}
              style={{ left: ratioWidth(mark.at / 100) }}
            >
              {t(mark.kind)}
            </span>
          ))}
        </div>
        {/* `.rt-foot { display:flex; gap:12px; flex-wrap:wrap; font-size:11px; color:var(--dim); margin-top:8px }` */}
        <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-dim">
          <span className="min-w-0 flex-1">{t("foot")}</span>
          {bands.length === 0 ? null : (
            <span data-testid="timeline-turns">
              {t("turnsInView", {
                count: new Set(bands.map((band) => band.turn)).size,
              })}
            </span>
          )}
          {pager}
        </div>
      </div>
    </section>
  );
}
