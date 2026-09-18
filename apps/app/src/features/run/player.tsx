"use client";
// The transport over one run's transcript (spec §8.4; Appendix F page 2): the
// entries as steps, and a scrub, a step, a play and a pause over them.
//
// Position is the entry's own `seq`, not a wall-clock offset: a recording is a
// sequence of frames, and the only place the run is at is the frame it is on.
// Elapsed is the `at` delta the contract recorded, and the cost the readout
// carries is the run's cumulative total at the playhead, which the contract
// computes as a prefix sum over the whole run, so it stays correct across
// pages.
//
// Playback compresses idleness. A gap longer than IDLE_CAP plays as IDLE_CAP,
// because a run that waited forty seconds for a tool should not make a person
// wait forty seconds to see what came back. The true gap is printed beside the
// compressed one, so the compression never hides how long the run took.
//
// There is no stop button. Stop and pause would be the same action here, and
// the second one would only make a person wonder what the difference was.
//
// A live run follows its own head: the SSE route says a frame landed, the
// player reads the tail, and the playhead moves with it. Scrubbing back
// detaches from the head and says so, and one control puts it back.
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  RunTranscript,
  TranscriptEntry,
  TranscriptKind,
  TranscriptZoom,
} from "@/data/contracts/run";
import type { Read } from "@/data/read";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { Money } from "@/ui/money";
import { formatCount } from "@/ui/money-format";
import { readTranscriptPage } from "./actions";
import { Entry, formatElapsed, type Place } from "./entry";
import { useRunStream } from "./use-run-stream";

/** The longest a gap between two entries plays for, however long the run waited. */
const IDLE_CAP_MS = 2000;

/** The speeds the transport offers (spec §8.4). */
const SPEEDS = [1, 1.5, 2, 4] as const;
type Speed = (typeof SPEEDS)[number];

/** How close to the end the playhead gets before the next page is read ahead of it. */
const PREFETCH_WITHIN = 5;

type Loading = "idle" | "reading" | "failed";

function Transport({
  entry,
  index,
  total,
  playing,
  speed,
  idleGapMs,
  atEnd,
  onSeek,
  onPlay,
  onSpeed,
}: {
  entry: TranscriptEntry;
  index: number;
  total: number;
  playing: boolean;
  speed: Speed;
  /** The true gap out of this entry when playback compressed it; null when it did not. */
  idleGapMs: number | null;
  atEnd: boolean;
  onSeek: (next: number) => void;
  onPlay: (next: boolean) => void;
  onSpeed: (next: Speed) => void;
}) {
  const t = useTranslations("run.player");
  const locale = useLocale();
  return (
    <div
      data-testid="run-transport"
      className="flex flex-col gap-2 rounded-lg border border-border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="player-first"
          aria-label={t("first")}
          className={buttonSecondary}
          disabled={index === 0}
          onClick={() => {
            onSeek(0);
          }}
        >
          {"|<"}
        </button>
        <button
          type="button"
          data-testid="player-back"
          aria-label={t("back")}
          className={buttonSecondary}
          disabled={index === 0}
          onClick={() => {
            onSeek(index - 1);
          }}
        >
          {"<"}
        </button>
        <button
          type="button"
          data-testid="player-play"
          aria-label={playing ? t("pause") : t("play")}
          aria-pressed={playing}
          className={buttonSecondary}
          disabled={atEnd && !playing}
          onClick={() => {
            onPlay(!playing);
          }}
        >
          {playing ? "||" : ">"}
        </button>
        <button
          type="button"
          data-testid="player-forward"
          aria-label={t("forward")}
          className={buttonSecondary}
          disabled={index >= total - 1}
          onClick={() => {
            onSeek(index + 1);
          }}
        >
          {">"}
        </button>
        <button
          type="button"
          data-testid="player-last"
          aria-label={t("last")}
          className={buttonSecondary}
          disabled={index >= total - 1}
          onClick={() => {
            onSeek(total - 1);
          }}
        >
          {">|"}
        </button>
        <div
          role="group"
          aria-label={t("speedLabel")}
          className="flex flex-wrap gap-1"
        >
          {SPEEDS.map((rate) => (
            <button
              key={rate}
              type="button"
              data-testid={`player-speed-${rate}`}
              aria-pressed={rate === speed}
              className={`${buttonSecondary} aria-pressed:border-foreground aria-pressed:text-foreground`}
              onClick={() => {
                onSpeed(rate);
              }}
            >
              {t("speed", { rate })}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">
        <span>{t("scrub")}</span>
        <input
          type="range"
          data-testid="player-scrub"
          min={0}
          max={Math.max(total - 1, 0)}
          step={1}
          value={index}
          onChange={(event) => {
            onSeek(Number(event.target.value));
          }}
          className="w-full"
        />
      </label>
      <p
        data-testid="player-position"
        aria-live="polite"
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs"
      >
        <span className={mono}>{t("atFrame", { seq: entry.seq })}</span>
        <span>
          {t("ofEntries", {
            index: formatCount(index + 1, locale),
            total: formatCount(total, locale),
          })}
        </span>
        <span>
          {t("into", { elapsed: formatElapsed(entry.elapsedMs, locale) })}
        </span>
        {entry.cumulativeCost === null ? (
          <span className="text-muted-foreground">{t("noCostYet")}</span>
        ) : (
          <span data-testid="player-cost">
            {t.rich("spentSoFar", {
              cost: () => (
                <Money value={entry.cumulativeCost!} precision="exact" />
              ),
            })}
          </span>
        )}
      </p>
      {idleGapMs === null ? null : (
        <p data-testid="player-idle" className="text-xs text-muted-foreground">
          {t("idle", {
            played: formatElapsed(IDLE_CAP_MS, locale),
            real: formatElapsed(idleGapMs, locale),
          })}
        </p>
      )}
    </div>
  );
}

export function RunPlayer({
  first,
  zoom,
  kinds,
  live,
  org,
  ws,
  runId,
}: {
  /** The first page of the transcript, read on the server. */
  first: RunTranscript;
  zoom: TranscriptZoom;
  kinds: readonly TranscriptKind[];
  /** True while the run is still recording: the player then follows its head. */
  live: boolean;
} & Place) {
  const t = useTranslations("run.player");
  const locale = useLocale();
  const [entries, setEntries] = useState<TranscriptEntry[]>(first.entries);
  const [cursor, setCursor] = useState<string | null>(first.cursor);
  const [complete, setComplete] = useState(first.complete);
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  const [loading, setLoading] = useState<Loading>("idle");
  const [failure, setFailure] = useState<Read<unknown> | null>(null);
  // Only meaningful on a live run: false once the person has scrubbed back off
  // the head, so new entries stop dragging the playhead with them.
  const [attached, setAttached] = useState(live);
  const list = useRef<HTMLOListElement>(null);
  // A read in flight is not started again: the stream can signal several times
  // before one page comes back.
  const reading = useRef(false);
  // The entries and the cursor as the last read left them, so an append knows
  // the new length before React has committed the state it set.
  const held = useRef<TranscriptEntry[]>(first.entries);
  const cursorRef = useRef<string | null>(first.cursor);

  const total = entries.length;
  const entry = entries[Math.min(index, total - 1)];

  /**
   * Read the page past the cursor and append it. `follow` moves the playhead
   * onto the last entry that arrived, which is what following a live head
   * means.
   *
   * The appended array is held in a ref as well as in state, because this is
   * the only place that appends and the caller needs the new length before
   * React has committed it.
   */
  const loadMore = useCallback(
    async (options: { follow?: boolean } = {}): Promise<void> => {
      if (reading.current || cursorRef.current === null) return;
      reading.current = true;
      setLoading("reading");
      try {
        const read = await readTranscriptPage(
          org,
          ws,
          runId,
          zoom,
          kinds,
          cursorRef.current,
        );
        if (!read.ok) {
          setFailure(read);
          setLoading("failed");
          return;
        }
        setFailure(null);
        setLoading("idle");
        const next = [...held.current, ...read.value.entries];
        held.current = next;
        cursorRef.current = read.value.cursor;
        setEntries(next);
        setCursor(read.value.cursor);
        setComplete(read.value.complete);
        if (options.follow && read.value.entries.length > 0) {
          setIndex(next.length - 1);
        }
      } catch {
        setFailure({
          ok: false,
          reason: "error",
          code: "unanswered",
          status: 0,
        });
        setLoading("failed");
      } finally {
        reading.current = false;
      }
    },
    [kinds, org, runId, ws, zoom],
  );

  // Following the head of a live run. A frame landing means the contract can
  // now derive more entries, so the tail is read and, while attached, the
  // playhead moves onto it.
  const follow = useCallback(() => {
    void loadMore({ follow: attached });
  }, [attached, loadMore]);

  const streamUrl = `/api/v1/${encodeURIComponent(org)}/${encodeURIComponent(
    ws,
  )}/runs/${encodeURIComponent(runId)}/stream`;
  const stream = useRunStream({
    url: streamUrl,
    enabled: live,
    onFrames: follow,
  });

  /** Move the playhead. Going backwards on a live run lets go of the head. */
  const seek = useCallback(
    (next: number) => {
      const bounded = Math.max(0, Math.min(next, entries.length - 1));
      setIndex((held) => {
        if (live && bounded < held) setAttached(false);
        return bounded;
      });
    },
    [entries.length, live],
  );

  // Playback. Each tick waits the recorded gap, capped, divided by the speed.
  useEffect(() => {
    if (!playing) return;
    if (index >= entries.length - 1) {
      // Nothing left on this page. A run with more behind the cursor keeps
      // playing once the next page lands; a complete one stops.
      if (cursor === null) setPlaying(false);
      return;
    }
    const here = entries[index];
    const next = entries[index + 1];
    if (here === undefined || next === undefined) return;
    const gap = Math.max(next.elapsedMs - here.elapsedMs, 0);
    const wait = Math.min(gap, IDLE_CAP_MS) / speed;
    const timer = setTimeout(() => {
      setIndex((held) => held + 1);
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [playing, index, entries, speed, cursor]);

  // Read ahead of the playhead, so playback does not stall at a page boundary.
  // Only while playing: reading a second page the moment a short transcript
  // renders would double the cost of opening the tab for a person who has not
  // asked for anything yet, and "Read more" is what asking looks like.
  useEffect(() => {
    if (!playing || cursor === null || loading !== "idle") return;
    if (index < entries.length - PREFETCH_WITHIN) return;
    void loadMore();
  }, [playing, index, entries.length, cursor, loading, loadMore]);

  // Keep the entry under the playhead on screen. A person who asked for less
  // motion gets none.
  useEffect(() => {
    const node = list.current?.querySelector("[data-current='true']");
    // `scrollIntoView` is not implemented everywhere a component test runs, and
    // scrolling is never what the page is for, so a runtime without it renders
    // the same page and simply does not scroll.
    if (
      !(node instanceof HTMLElement) ||
      typeof node.scrollIntoView !== "function"
    ) {
      return;
    }
    const still =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    node.scrollIntoView({
      block: "nearest",
      behavior: still ? "auto" : "smooth",
    });
  }, [index]);

  const idleGapMs = useMemo(() => {
    const here = entries[index];
    const next = entries[index + 1];
    if (here === undefined || next === undefined) return null;
    const gap = next.elapsedMs - here.elapsedMs;
    return gap > IDLE_CAP_MS ? gap : null;
  }, [entries, index]);

  if (entry === undefined) return null;

  return (
    <div className="flex flex-col gap-3">
      <Transport
        entry={entry}
        index={Math.min(index, total - 1)}
        total={total}
        playing={playing}
        speed={speed}
        idleGapMs={idleGapMs}
        atEnd={index >= total - 1 && cursor === null}
        onSeek={seek}
        onPlay={setPlaying}
        onSpeed={setSpeed}
      />
      {live ? (
        <p
          data-testid="player-follow"
          data-attached={attached ? "true" : "false"}
          className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground"
        >
          <span>{attached ? t(`following.${stream}`) : t("detached")}</span>
          {attached ? null : (
            <button
              type="button"
              data-testid="player-reattach"
              className={buttonSecondary}
              onClick={() => {
                setAttached(true);
                setIndex(entries.length - 1);
                void loadMore({ follow: true });
              }}
            >
              {t("reattach")}
            </button>
          )}
        </p>
      ) : null}
      <ol ref={list} data-testid="transcript-entries" className="flex flex-col">
        {entries.map((row, position) => (
          <Entry
            key={`${row.seq}-${row.endSeq}`}
            entry={row}
            current={position === Math.min(index, total - 1)}
            org={org}
            ws={ws}
            runId={runId}
          />
        ))}
      </ol>
      {failure === null ? null : (
        <p data-testid="player-read-failed" className="max-w-prose text-sm">
          {failure.ok
            ? null
            : failure.reason === "error" && failure.code === "invalid_input"
              ? t("badCursor")
              : t("pageFailed")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-muted-foreground">
        <span data-testid="transcript-count">
          {complete
            ? t("loadedComplete", { count: formatCount(total, locale) })
            : t("loadedCut", { count: formatCount(total, locale) })}
        </span>
        {cursor === null ? null : (
          <button
            type="button"
            data-testid="transcript-more"
            className={buttonSecondary}
            disabled={loading === "reading"}
            onClick={() => {
              void loadMore();
            }}
          >
            {loading === "reading" ? t("readingMore") : t("more")}
          </button>
        )}
      </div>
    </div>
  );
}
