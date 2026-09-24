"use client";
// The frame player's live parts (mockup `fpBar`, `fpTick`, `fpAfterRender`
// and its keydown handler): play, pause and speed, the scrub, the arrow,
// Home, End and space keys, the list kept on the open frame, and the button
// that opens the shell's approvals drawer.
//
// Every step is a navigation to `?body=<seq>`, because the open frame and its
// body are read on the server. So play waits for each frame to land before it
// times the next one: the pause is the recorded gap between the two frames,
// held between 250 ms and 5 s and divided by the speed, and a slow read slows
// the playback rather than stacking reads behind it.
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useEffectEvent,
  useRef,
  useState,
} from "react";
import { openApprovals } from "@/features/shell/client";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import { playButton, speedButton, speedSeg } from "./player-styles";

/** Where each key leads; null where there is no frame that way. */
export type StepTargets = {
  first: SafePath | null;
  prev: SafePath | null;
  next: SafePath | null;
  last: SafePath | null;
};

/** `FP_SPEEDS` */
const SPEEDS = [1, 4, 16] as const;

/**
 * How long play holds a frame before it opens the next (`fpTick`): the
 * recorded gap between the two, held between 250 ms and 5 s, over the speed.
 * A frame with no time, or one out of order, holds the 250 ms floor.
 *
 * @internal Exported for its test.
 */
export function stepMs(
  from: number | undefined,
  to: number | undefined,
  speed: number,
): number {
  const gap = from === undefined || to === undefined ? 0 : to - from;
  return Math.max(250, Math.min(5000, Number.isFinite(gap) ? gap : 0)) / speed;
}

/** A keypress meant for a field, a dialog or a shortcut is not a step. */
function isStepKey(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) ||
      target.isContentEditable)
  )
    return false;
  return document.querySelector('[role="dialog"]') === null;
}

type Playback = {
  /** Play is running and has a frame left to open. */
  playing: boolean;
  /** The open frame is the page's last, so play starts over. */
  done: boolean;
  /** The page holds one frame, so there is nothing to play. */
  disabled: boolean;
  speed: number;
  toggle: () => void;
  setSpeed: (speed: number) => void;
  /** A scrub keeps play running (`fpSeek(i, true)`), unless play had already run out. */
  seek: () => void;
};

const PlaybackContext = createContext<Playback | null>(null);

/**
 * `.fp-bar`, and the playback the bar's controls share. ← and → step, Home
 * and End jump, and each of those stops play (`fpStep`, `fpSeek`), as does a
 * click on a step link. Space plays and pauses. Play at the last frame starts
 * over from the first.
 */
export function PlayerPlayback({
  hrefs,
  times,
  index,
  steps,
  label,
  className,
  children,
}: {
  /** The page's frames in order, as the link that opens each. */
  hrefs: readonly SafePath[];
  /** When each frame was recorded, in epoch milliseconds; NaN where unreadable. */
  times: readonly number[];
  /** The open frame's place on the page; -1 when the page does not hold it. */
  index: number;
  steps: StepTargets;
  label: string;
  className: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(SPEEDS[0]);
  const done = index >= hrefs.length - 1;
  const running = playing && !done;
  const toggle = () => {
    if (running) {
      setPlaying(false);
      return;
    }
    setPlaying(true);
    const first = hrefs[0];
    if ((index < 0 || done) && first !== undefined) navigate.push(first);
  };
  // The next frame and the hold before it. The timer is set again only when
  // the open frame lands, so one read is in flight at a time.
  const next = playing && index >= 0 ? hrefs[index + 1] : undefined;
  const wait = stepMs(times[index], times[index + 1], speed);
  useEffect(() => {
    if (next === undefined) return;
    const timer = setTimeout(() => {
      navigate.push(next);
    }, wait);
    return () => {
      clearTimeout(timer);
    };
  }, [next, wait, navigate]);
  const onKey = useEffectEvent((event: KeyboardEvent) => {
    if (!isStepKey(event)) return;
    if (event.key === " ") {
      // A focused button already answers space with a click.
      if (
        event.target instanceof Element &&
        event.target.closest('button, summary, [role="button"]') !== null
      )
        return;
      if (hrefs.length < 2) return;
      event.preventDefault();
      toggle();
      return;
    }
    const to = {
      ArrowLeft: steps.prev,
      ArrowRight: steps.next,
      Home: steps.first,
      End: steps.last,
    }[event.key];
    if (to === undefined || to === null) return;
    event.preventDefault();
    setPlaying(false);
    navigate.push(to);
  });
  useEffect(() => {
    const listen = (event: KeyboardEvent) => {
      onKey(event);
    };
    document.addEventListener("keydown", listen);
    return () => {
      document.removeEventListener("keydown", listen);
    };
  }, []);
  const playback: Playback = {
    playing: running,
    done,
    disabled: hrefs.length < 2,
    speed,
    toggle,
    setSpeed,
    seek: () => {
      if (done) setPlaying(false);
    },
  };
  return (
    <PlaybackContext value={playback}>
      <div
        role="group"
        aria-label={label}
        data-testid="player-bar"
        className={className}
        onClickCapture={(event) => {
          // A step link is a step (`fpStep`), and a step stops play.
          if (event.target instanceof Element && event.target.closest("a"))
            setPlaying(false);
        }}
      >
        {children}
      </div>
    </PlaybackContext>
  );
}

/** `.fp-bar .play`: play, pause, or replay from the first frame at the last. */
export function PlayButton() {
  const t = useTranslations("run.player.bar");
  const playback = use(PlaybackContext);
  if (playback === null) return null;
  const [glyph, word] = playback.playing
    ? ["❙❙", t("pause")]
    : playback.done && !playback.disabled
      ? ["▶", t("replay")]
      : ["▶", t("play")];
  return (
    <button
      type="button"
      disabled={playback.disabled}
      aria-keyshortcuts="Space"
      data-testid="player-play"
      onClick={playback.toggle}
      className={playButton}
    >
      <span aria-hidden="true">{glyph}</span>
      {word}
    </button>
  );
}

/** `.seg`: the playback speeds, the one in use pressed. */
export function PlaySpeed() {
  const t = useTranslations("run.player.bar");
  const playback = use(PlaybackContext);
  if (playback === null) return null;
  return (
    <span
      role="group"
      aria-label={t("speedLabel")}
      data-testid="player-speed"
      className={speedSeg}
    >
      {SPEEDS.map((speed) => (
        <button
          key={speed}
          type="button"
          aria-pressed={playback.speed === speed}
          onClick={() => {
            playback.setSpeed(speed);
          }}
          className={speedButton}
        >
          {t("speed", { speed })}
        </button>
      ))}
    </span>
  );
}

/**
 * `.fp-scrub`: the range over the frames shown and the governed ticks under
 * it. The range moves freely while it is dragged and opens the frame it is
 * released on, so a drag across the run makes one read, not one per frame.
 * The caller keys it by the open frame, so a step resets it. A scrub keeps
 * play running.
 */
export function PlayerScrub({
  hrefs,
  index,
  marks,
}: {
  /** The page's frames in order, as the link that opens each. */
  hrefs: readonly SafePath[];
  /** The open frame's place on the page; -1 when the page does not hold it. */
  index: number;
  /** `.fp-ticks i`: a governed frame's place under the range and its hue. */
  marks: readonly { left: string; hue: string; title: string }[];
}) {
  const t = useTranslations("run.player.bar");
  const navigate = useNavigate();
  const playback = use(PlaybackContext);
  const [pos, setPos] = useState(Math.max(0, index));
  const commit = () => {
    const to = hrefs[pos];
    if (pos === index || to === undefined) return;
    playback?.seek();
    navigate.push(to);
  };
  return (
    // `.fp-scrub { flex:1; min-width:180px; display:grid; gap:3px; margin:0 6px }`
    <div className="mx-1.5 grid min-w-[180px] flex-1 gap-[3px] max-md:basis-full">
      <input
        type="range"
        min={0}
        max={Math.max(0, hrefs.length - 1)}
        value={pos}
        aria-label={t("scrub")}
        aria-valuetext={t("scrubValue", {
          index: pos + 1,
          shown: hrefs.length,
        })}
        disabled={hrefs.length < 2}
        onChange={(event) => {
          setPos(Number(event.currentTarget.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        // `.fp-range { width:100%; margin:0; accent-color:var(--fg); cursor:pointer }`
        className="m-0 w-full cursor-pointer accent-foreground disabled:cursor-default"
      />
      {/* `.fp-ticks { position:relative; height:6px; margin:0 7px }` */}
      <div aria-hidden="true" className="relative mx-[7px] h-1.5">
        {marks.map((mark, i) => (
          <i
            key={`${mark.left}:${String(i)}`}
            title={mark.title}
            // `.fp-ticks i { position:absolute; top:0; width:4px; height:6px; border-radius:2px; margin-left:-2px }`
            className={`absolute top-0 -ml-0.5 h-1.5 w-1 rounded-[2px] ${mark.hue}`}
            style={{ left: mark.left }}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The Timeline list's scroll box (`#fptl { max-height:420px; overflow-y:auto;
 * padding:7px }`), kept on the open frame the way `fpAfterRender` scrolls it
 * into view. It scrolls the box alone, never the page.
 */
export function FrameListBox({
  children,
  label,
}: {
  children: ReactNode;
  label: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const box = ref.current;
    const current = box?.querySelector('[aria-current="true"]');
    if (!box || !(current instanceof HTMLElement)) return;
    const top = current.offsetTop;
    const bottom = top + current.offsetHeight;
    if (top < box.scrollTop || bottom > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, top - box.clientHeight / 2);
  });
  return (
    <div
      ref={ref}
      role="region"
      aria-label={label}
      // A scroll box a keyboard can reach (WCAG 2.1.1): it takes focus.
      tabIndex={0}
      className="relative max-h-[420px] overflow-y-auto p-[7px] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
    >
      {children}
    </div>
  );
}

/** Opens the shell's approvals drawer, where every call parked in the workspace is decided. */
export function OpenApprovalsButton({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      data-testid="open-approvals"
      onClick={openApprovals}
      className={buttonSecondary}
    >
      {children}
    </button>
  );
}
