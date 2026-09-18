"use client";
// The transcript and its transport (mockup `pRun`, `renderTranscript` and
// `renderTransport`): every run reads the same way, from the run's start
// through each turn, each turn's steps on a spine, and each step's frames
// behind a disclosure.
//
// The transport moves the viewer, never the run. Its position is a frame;
// playback walks the frames at their recorded pace, idle longer than 2 s
// compressed, and the readout puts the true elapsed time and the cost to
// that point beside the position. Frames past the position are dimmed, and
// the step holding it is marked.
//
// Zoom is which disclosures start open (Turns: none, Steps: the turns,
// Everything: the turns and their steps), not a different read, so a change
// of level keeps the position and rewrites only the query value.
//
// A live run re-reads itself every few seconds while the viewer follows its
// head and the tab is visible. Scrubbing back stops following, and "go live"
// resumes it; a sealed or halted run is never re-read.
import { useFormatter, useLocale, useTranslations } from "next-intl";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { Money as MoneyValue } from "@/data/contracts/money";
import {
  type RunTranscript,
  TRANSCRIPT_ZOOMS,
  type TranscriptEntry,
  type TranscriptZoom,
} from "@/data/contracts/run";
import type { ReplayGrade, RunStatus } from "@/data/contracts/runs";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatClock, formatCount } from "@/ui/money-format";
import { SafeLink, useNavigate } from "@/ui/navigation";
import {
  buildTranscript,
  costAt,
  elapsedAt,
  type Frames,
  frameAt,
  frameCost,
  idsAt,
  openAtZoom,
  playDelay,
  type StepDigest,
  type StepNode,
  stepDigest,
  type TranscriptStep,
  type TranscriptTurn,
} from "./transcript-model";

type Place = { org: string; ws: string; runId: string };

const SPEEDS = [1, 1.5, 2, 4] as const;
/** How often a followed live run re-reads itself. */
const LIVE_REFRESH_MS = 5000;

const DOT: Record<StepNode, string> = {
  model: "border-info",
  tool: "border-muted-foreground",
  policy: "border-success",
  control: "border-brand rounded-[2px]",
  deny: "border-destructive bg-destructive",
};
const NAME: Record<StepNode, string> = {
  model: "text-info",
  tool: "text-foreground",
  policy: "text-foreground",
  control: "text-brand",
  deny: "text-destructive",
};

const chip =
  "whitespace-nowrap rounded-full border border-border bg-card px-2 font-mono text-[10.5px] leading-[1.8] text-muted-foreground";
const segButton =
  "border-r border-border px-2 py-1 text-[11px] text-muted-foreground last:border-r-0 hover:text-foreground aria-pressed:bg-card aria-pressed:font-semibold aria-pressed:text-foreground";
const tpButton =
  "grid size-[30px] shrink-0 place-items-center rounded-md border border-border bg-card text-foreground hover:border-foreground/40 disabled:cursor-not-allowed disabled:opacity-35";

function Chevron() {
  return (
    <span
      aria-hidden="true"
      className="inline-block w-2.5 shrink-0 text-[8px] text-muted-foreground transition-transform group-open:rotate-90"
    >
      ▶
    </span>
  );
}

function Chip({
  children,
  tone,
}: {
  children: ReactNode;
  tone?: "cost" | "warn";
}) {
  return (
    <span
      className={`${chip} ${tone === "cost" ? "text-foreground" : tone === "warn" ? "text-destructive" : ""}`}
    >
      {children}
    </span>
  );
}

function FrameDetail({
  frame,
  org,
  ws,
  runId,
}: { frame: TranscriptEntry } & Place) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  return (
    <div
      data-testid="transcript-frame"
      className="border-b border-border last:border-b-0"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-1.5">
        <span className="font-mono text-[11px] text-foreground">
          {frame.type}
        </span>
        <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
          {t("frameHead", {
            seq: frame.seq,
            time: format.dateTime(new Date(frame.at), { timeStyle: "medium" }),
            fidelity: t(`fidelity.${frame.fidelity}`),
          })}
        </span>
      </div>
      <div className="flex flex-col gap-2 px-3 py-2.5">
        {frame.label !== frame.type ? (
          <p className="m-0 font-mono text-[11.5px] text-muted-foreground">
            {frame.label}
          </p>
        ) : null}
        {frame.text === null ? (
          <p className="m-0 text-xs text-muted-foreground">
            {t(frame.fidelity === "digest_only" ? "digestOnly" : "noBody")}
          </p>
        ) : (
          <pre className="m-0 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-card p-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
            {frame.text}
          </pre>
        )}
        {frame.truncated ? (
          <p
            data-testid="entry-truncated"
            className="m-0 text-xs text-muted-foreground"
          >
            {t("truncated")}{" "}
            <SafeLink
              to={routes.run(org, ws, runId, {
                tab: "frames",
                body: frame.seq,
              })}
              className={linkText}
            >
              {t("openFrame", { seq: frame.seq })}
            </SafeLink>
          </p>
        ) : (
          <SafeLink
            to={routes.run(org, ws, runId, { tab: "frames", body: frame.seq })}
            className={`${linkText} self-start text-[11px]`}
          >
            {t("envelope", { seq: frame.seq })}
          </SafeLink>
        )}
      </div>
    </div>
  );
}

function StepRow({
  step,
  digest,
  pos,
  open,
  onToggle,
  place,
}: {
  step: TranscriptStep;
  digest: StepDigest;
  pos: number;
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
  place: Place;
}) {
  const t = useTranslations("run.transcript");
  const format = useFormatter();
  const locale = useLocale();
  const { first } = step;
  const isNow = pos >= step.from && pos <= step.to;
  const isFuture = step.from > pos;
  return (
    <details
      data-testid="transcript-step"
      data-node={digest.node}
      data-now={isNow ? "true" : undefined}
      open={open}
      onToggle={(e) => {
        onToggle(step.id, e.currentTarget.open);
      }}
      className={`group border-b border-border last:border-b-0 ${isFuture ? "opacity-35" : ""}`}
    >
      <summary
        className={`cursor-pointer list-none py-1.5 pr-3 select-none hover:bg-muted [&::-webkit-details-marker]:hidden ${isNow ? "bg-muted shadow-[inset_3px_0_0_var(--color-brand)]" : ""}`}
      >
        <div className="grid grid-cols-[46px_30px_1fr] items-baseline">
          <time
            dateTime={first.at}
            className="pr-2 text-right font-mono text-[10.5px] tabular-nums text-muted-foreground"
          >
            {format.dateTime(new Date(first.at), {
              minute: "2-digit",
              second: "2-digit",
            })}
          </time>
          <span className="relative text-center before:absolute before:-top-3 before:-bottom-3 before:left-1/2 before:w-px before:bg-border">
            <span
              aria-hidden="true"
              className={`relative z-10 inline-block size-[7px] rounded-full border-2 bg-card ${DOT[digest.node]}`}
            />
          </span>
          <span className="flex min-w-0 flex-wrap items-baseline gap-2">
            <Chevron />
            <span
              className={`font-mono text-xs font-semibold ${NAME[digest.node]}`}
            >
              {digest.name}
            </span>
            {digest.arg === null ? null : (
              <span className="max-w-[46ch] overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11.5px] text-muted-foreground">
                {digest.arg}
              </span>
            )}
            <span className="ml-auto flex flex-wrap gap-1.5">
              {digest.outcome === null ? null : (
                <Chip tone={digest.node === "deny" ? "warn" : undefined}>
                  {digest.outcome}
                </Chip>
              )}
              {digest.status === null ? null : (
                <Chip tone={digest.node === "deny" ? "warn" : undefined}>
                  {digest.status}
                </Chip>
              )}
              {digest.durationMs === null ? null : (
                <Chip>
                  {t("ms", { ms: formatCount(digest.durationMs, locale) })}
                </Chip>
              )}
              {step.frames.length > 1 ? (
                <Chip>{t("frameCount", { count: step.frames.length })}</Chip>
              ) : null}
              {digest.cost === null ? null : (
                <Chip tone="cost">
                  <Money value={digest.cost} precision="exact" />
                </Chip>
              )}
            </span>
          </span>
        </div>
      </summary>
      {open ? (
        <div className="pr-3 pb-2.5">
          <div className="ml-0 overflow-hidden rounded-md border border-border bg-background md:ml-[76px]">
            {step.frames.map((frame) => (
              <FrameDetail key={frame.seq} frame={frame} {...place} />
            ))}
          </div>
        </div>
      ) : null}
    </details>
  );
}

function Role({ who, text }: { who: "you" | "agent"; text: string }) {
  const t = useTranslations("run.transcript");
  return (
    <div
      data-testid={`transcript-${who}`}
      className="grid grid-cols-1 border-b border-border py-2.5 pr-3 pl-3 md:grid-cols-[74px_1fr] md:pl-0"
    >
      <div className="pb-1.5 md:pr-3 md:pb-0 md:text-right">
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[9.5px] font-bold tracking-[0.13em] text-background ${who === "you" ? "bg-info" : "bg-muted-foreground"}`}
        >
          {t(who)}
        </span>
      </div>
      <p
        className={`m-0 max-w-[70ch] whitespace-pre-wrap text-[13px] leading-relaxed text-foreground ${who === "agent" ? "border-l-2 border-border pl-3" : ""}`}
      >
        {text}
      </p>
    </div>
  );
}

function TurnBlock({
  turn,
  pos,
  running,
  openIds,
  onToggle,
  place,
}: {
  turn: TranscriptTurn;
  pos: number;
  running: boolean;
  openIds: Set<string>;
  onToggle: (id: string, open: boolean) => void;
  place: Place;
}) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const { first, last } = turn;
  const cost = frameCost(turn.frames);
  const seconds = (Date.parse(last.at) - Date.parse(first.at)) / 1000;
  return (
    <details
      data-testid="transcript-turn"
      open={openIds.has(turn.id)}
      onToggle={(e) => {
        onToggle(turn.id, e.currentTarget.open);
      }}
      className="group/turn"
    >
      <summary className="cursor-pointer list-none border-b border-border bg-muted px-3 py-2.5 select-none hover:bg-card [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <span
            aria-hidden="true"
            className="inline-block w-2.5 shrink-0 text-[8px] text-muted-foreground transition-transform group-open/turn:rotate-90"
          >
            ▶
          </span>
          <span className="text-[13px] font-semibold text-foreground">
            <span aria-hidden="true" className="text-brand">
              ▍
            </span>
            {turn.turn === null ? t("runStart") : t("turn", { n: turn.turn })}
          </span>
          {turn.turn === null ? null : running ? (
            <span className="text-[11px] tracking-[0.06em] text-info">
              {t("turnRunning")}
            </span>
          ) : (
            <span className="text-[11px] tracking-[0.06em] text-success">
              {t("turnDone")}
            </span>
          )}
          <span className="ml-auto flex flex-wrap gap-1.5">
            <Chip>{t("stepCount", { count: turn.steps.length })}</Chip>
            <Chip>{t("seqSpan", { from: first.seq, to: last.seq })}</Chip>
            <Chip>{formatClock(seconds, locale)}</Chip>
            {cost === null ? null : (
              <Chip tone="cost">
                <Money value={cost} precision="exact" />
              </Chip>
            )}
          </span>
        </div>
      </summary>
      {turn.prompt === null ? null : <Role who="you" text={turn.prompt} />}
      {turn.steps.map((step) => (
        <StepRow
          key={step.id}
          step={step}
          digest={stepDigest(step)}
          pos={pos}
          open={openIds.has(step.id)}
          onToggle={onToggle}
          place={place}
        />
      ))}
      {turn.reply === null ? null : <Role who="agent" text={turn.reply} />}
    </details>
  );
}

function Readout({ entries, pos }: { entries: Frames; pos: number }) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const head = entries.length - 1;
  const here = frameAt(entries, pos);
  const cost: MoneyValue | null = costAt(entries, pos);
  return (
    <span
      data-testid="transport-readout"
      className="whitespace-nowrap font-mono text-[11.5px] tabular-nums text-muted-foreground"
    >
      <b className="font-medium text-foreground">
        {t("position", { seq: here.seq })}
      </b>{" "}
      {t("of", { seq: frameAt(entries, head).seq })}
      {" · "}
      {formatClock(elapsedAt(entries, pos) / 1000, locale)} /{" "}
      {formatClock(elapsedAt(entries, head) / 1000, locale)}
      {cost === null ? null : (
        <>
          {" · "}
          <b className="font-medium text-foreground">
            <Money value={cost} precision="exact" />
          </b>
        </>
      )}
    </span>
  );
}

export function TranscriptView({
  transcript,
  entries,
  zoom: initialZoom,
  status,
  replayGrade,
  org,
  ws,
  runId,
}: {
  transcript: Pick<RunTranscript, "complete">;
  /** The transcript's frames, at least one. */
  entries: Frames;
  /** The level the URL asked for: which disclosures start open. */
  zoom: TranscriptZoom;
  status: RunStatus;
  replayGrade: ReplayGrade | null;
} & Place) {
  const t = useTranslations("run.transcript");
  const locale = useLocale();
  const navigate = useNavigate();
  const place = useMemo(() => ({ org, ws, runId }), [org, ws, runId]);
  const head = entries.length - 1;
  const turns = useMemo(() => buildTranscript(entries), [entries]);
  const live = status === "live";

  const [zoom, setZoom] = useState<TranscriptZoom>(initialZoom);
  const [openIds, setOpenIds] = useState(() => {
    const open = openAtZoom(turns, initialZoom);
    for (const id of idsAt(turns, head)) open.add(id);
    return open;
  });
  // The frame the viewer pinned; null follows the head as a live run grows.
  const [pinned, setPinned] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1);
  const bodyRef = useRef<HTMLDivElement>(null);

  const following = pinned === null;
  const pos = pinned === null ? head : Math.min(pinned, head);
  // A sealed run stops at its last frame; a live one waits there for more.
  const isPlaying = playing && (live || pos < head);

  // A viewer following a live run sees the newest step open, at any zoom but Turns.
  const shown = useMemo(() => {
    if (!following || zoom === "turns") return openIds;
    const ids = idsAt(turns, head);
    if (ids.every((id) => openIds.has(id))) return openIds;
    return new Set([...openIds, ...ids]);
  }, [following, zoom, openIds, turns, head]);

  const reveal = useCallback(
    (at: number) => {
      const ids = idsAt(turns, at);
      setOpenIds((prev) => {
        if (ids.every((id) => prev.has(id))) return prev;
        return new Set([...prev, ...ids]);
      });
    },
    [turns],
  );

  // A followed live run re-reads itself while the tab is visible.
  useEffect(() => {
    if (!live || !following) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") navigate.refresh();
    }, LIVE_REFRESH_MS);
    return () => {
      clearInterval(timer);
    };
  }, [live, following, navigate]);

  // Playback walks the frames at their recorded pace.
  useEffect(() => {
    if (!isPlaying || pos >= head) return;
    const timer = setTimeout(
      () => {
        const next = pos + 1;
        setPinned(next >= head ? null : next);
        reveal(next);
      },
      playDelay(entries, pos, speed),
    );
    return () => {
      clearTimeout(timer);
    };
  }, [isPlaying, pos, head, entries, speed, reveal]);

  // Keep the marked step in view while playing; the container's scroll
  // behaviour honours reduced motion.
  useEffect(() => {
    if (!isPlaying) return;
    bodyRef.current
      ?.querySelector<HTMLElement>("[data-now]")
      ?.scrollIntoView({ block: "nearest" });
  }, [isPlaying, pos]);

  const moveTo = (next: number) => {
    const clamped = Math.max(0, Math.min(head, next));
    setPlaying(false);
    setPinned(clamped >= head ? null : clamped);
    reveal(clamped);
  };

  const toggle = useCallback((id: string, open: boolean) => {
    setOpenIds((prev) => {
      if (prev.has(id) === open) return prev;
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const chooseZoom = (level: TranscriptZoom) => {
    setZoom(level);
    const open = openAtZoom(turns, level);
    if (level !== "turns") for (const id of idsAt(turns, pos)) open.add(id);
    setOpenIds(open);
    window.history.replaceState(
      null,
      "",
      routes.run(org, ws, runId, { tab: "transcript", zoom: level }),
    );
  };

  const lastTurnId = turns[turns.length - 1]?.id;

  return (
    <section
      aria-label={t("title")}
      data-testid="transcript"
      className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted px-3 py-2.5">
        {live && following ? (
          <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-success/15 px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-success uppercase">
            <span
              aria-hidden="true"
              className="size-1.5 animate-pulse rounded-full bg-success"
            />
            {t("live")}
          </span>
        ) : live ? (
          <button
            type="button"
            onClick={() => {
              moveTo(head);
            }}
            className="inline-flex shrink-0 items-center rounded-full border border-border bg-muted px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase hover:text-foreground"
          >
            {t("goLive")}
          </button>
        ) : (
          <span className="inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 font-mono text-[10.5px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
            {t(status === "halted" ? "recorded.halted" : "recorded.sealed")}
          </span>
        )}
        <button
          type="button"
          className={tpButton}
          disabled={pos <= 0}
          aria-label={t("back")}
          onClick={() => {
            moveTo(pos - 1);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
            <path d="M11.4 3.2 4.6 8l6.8 4.8Z" fill="currentColor" />
            <rect
              x="3.2"
              y="3.2"
              width="1.6"
              height="9.6"
              fill="currentColor"
            />
          </svg>
        </button>
        <button
          type="button"
          className={`${tpButton} size-[34px] border-foreground/30`}
          aria-label={isPlaying ? t("pause") : t("play")}
          onClick={() => {
            if (isPlaying) {
              setPlaying(false);
              return;
            }
            setPinned(pos >= head && !live ? 0 : pos);
            setPlaying(true);
          }}
        >
          {isPlaying ? (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
              <rect
                x="4.6"
                y="3.4"
                width="2.4"
                height="9.2"
                fill="currentColor"
              />
              <rect
                x="9"
                y="3.4"
                width="2.4"
                height="9.2"
                fill="currentColor"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
              <path d="M4.6 3.2 12.4 8l-7.8 4.8Z" fill="currentColor" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className={tpButton}
          disabled={pos >= head}
          aria-label={t("forward")}
          onClick={() => {
            moveTo(pos + 1);
          }}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true" className="size-[13px]">
            <path d="M4.6 3.2 11.4 8l-6.8 4.8Z" fill="currentColor" />
            <rect
              x="11.2"
              y="3.2"
              width="1.6"
              height="9.6"
              fill="currentColor"
            />
          </svg>
        </button>
        <span className="flex min-w-[130px] flex-[1_1_190px] items-center">
          <input
            type="range"
            min={0}
            max={head}
            value={pos}
            aria-label={t("scrub")}
            aria-valuetext={t("position", { seq: frameAt(entries, pos).seq })}
            onChange={(e) => {
              moveTo(Number(e.currentTarget.value));
            }}
            className="h-1 w-full cursor-pointer accent-foreground"
          />
        </span>
        <Readout entries={entries} pos={pos} />
        <span
          role="group"
          aria-label={t("speedLabel")}
          className="flex shrink-0 overflow-hidden rounded-md border border-border"
        >
          {SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={speed === value}
              onClick={() => {
                setSpeed(value);
              }}
              className={`${segButton} font-mono`}
            >
              {t("speed", { speed: value })}
            </button>
          ))}
        </span>
        <span
          role="group"
          aria-label={t("zoomLabel")}
          className="flex shrink-0 overflow-hidden rounded-md border border-border"
        >
          {TRANSCRIPT_ZOOMS.map((level) => (
            <button
              key={level}
              type="button"
              aria-pressed={zoom === level}
              onClick={() => {
                chooseZoom(level);
              }}
              className={segButton}
            >
              {t(`zoom.${level}`)}
            </button>
          ))}
        </span>
        <p className="m-0 basis-full text-[11px] leading-snug text-muted-foreground">
          {replayGrade === null
            ? t("transportNote")
            : t("transportNoteGraded", { grade: replayGrade })}
        </p>
      </div>
      <div
        ref={bodyRef}
        className="max-h-[min(66vh,760px)] overflow-y-auto motion-safe:scroll-smooth"
      >
        {turns.map((turn) => (
          <TurnBlock
            key={turn.id}
            turn={turn}
            pos={pos}
            running={live && turn.id === lastTurnId}
            openIds={shown}
            onToggle={toggle}
            place={place}
          />
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t border-border bg-muted px-3 py-2.5 text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={`size-1.5 rounded-full ${live ? "animate-pulse bg-success" : "bg-muted-foreground"}`}
        />
        {live
          ? t("recording")
          : transcript.complete
            ? t("complete", { count: formatCount(entries.length, locale) })
            : t("cut", { count: formatCount(entries.length, locale) })}
      </div>
    </section>
  );
}
