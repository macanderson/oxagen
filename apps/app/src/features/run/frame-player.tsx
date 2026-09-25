"use client";
// The frame player's live parts (mockup `fpBar`, `fpPlay`, `fpTick`,
// `fpAfterRender` and its keydown handler): play, pause and replay, the speed,
// the scrub, the arrow, space, Home and End keys, the list kept on the open
// frame, and the button that opens the shell's approvals drawer.
//
// Every step is a navigation to `?body=<seq>`, because the open frame and its
// body are read on the server. So playback is a walk of those navigations: it
// holds the open frame for the recorded gap to the next, divided by the speed,
// then asks for the next frame and waits for it to land before it counts the
// next gap. A slow read slows the playback down rather than stacking reads up.
import { useTranslations } from "next-intl";
import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { openApprovals } from "@/features/shell/client";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";
import {
  PLAYBACK_MIN_MS,
  PLAYBACK_SPEEDS,
  type PlaybackSpeed,
} from "./player-model";
import { barShape, disabledStep } from "./player-styles";

/**
 * `.seg { display:inline-flex; gap:2px; padding:2px; border:1px solid
 * var(--border); border-radius:8px; background:var(--void) }`, placed with
 * `margin-left:4px`.
 */
const speedSegment =
  "ml-1 inline-flex gap-0.5 rounded-lg border border-border bg-void p-0.5";
/**
 * `.seg .btn { border-color:transparent; background:transparent }` over the
 * bar's small button, pressed `{ background:var(--hl);
 * border-color:var(--rule); color:var(--fg) }`.
 */
const speedButton =
  "inline-flex min-w-[30px] items-center justify-center rounded-[7px] border border-transparent bg-transparent px-2 py-[3px] font-mono text-[11.5px] font-medium text-button-default-fg transition-colors hover:bg-hl aria-pressed:border-rule aria-pressed:bg-hl aria-pressed:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11 max-md:min-w-11";

/** Where each key leads; null where there is no frame that way. */
export type StepTargets = {
  first: SafePath | null;
  prev: SafePath | null;
  next: SafePath | null;
  last: SafePath | null;
};

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

/** ← → step, Home and End jump: the mockup's keys, each a navigation to that frame. */
function useStepKeys(steps: StepTargets) {
  const navigate = useNavigate();
  useEffect(() => {
    const keys: Record<string, SafePath | null> = {
      ArrowLeft: steps.prev,
      ArrowRight: steps.next,
      Home: steps.first,
      End: steps.last,
    };
    const onKey = (event: KeyboardEvent) => {
      const to = keys[event.key];
      if (to === undefined || to === null || !isStepKey(event)) return;
      event.preventDefault();
      navigate.push(to);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [navigate, steps.first, steps.prev, steps.next, steps.last]);
}

/** The keys that step, so a step taken by hand stops the playback the way `fpStep` does. */
const STEP_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
]);

/** The keys that move a focused range, so a scrub by key stops the playback too. */
const RANGE_KEYS: ReadonlySet<string> = new Set([
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * Space on a control is that control's own: it presses a button, follows a
 * link, or scrolls the frame list. Space toggles playback only when focus
 * rests on none of them.
 */
function isOnControl(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest(
      'a, button, summary, [role="button"], [role="tab"], [role="checkbox"], [role="switch"], [role="menuitem"], [tabindex]',
    ) !== null
  );
}

type Playback = {
  /** The playback is stepping, or waiting on the step it asked for. */
  playing: boolean;
  /** The open frame is the last one shown, so play starts again from the first. */
  done: boolean;
  /** Fewer than two frames shown: there is nothing to play through. */
  disabled: boolean;
  speed: PlaybackSpeed;
  toggle: () => void;
  /** A step taken by hand: the playback stops where it is. */
  stop: () => void;
  setSpeed: (speed: PlaybackSpeed) => void;
};

const PlaybackContext = createContext<Playback | null>(null);

function usePlayback(): Playback {
  const playback = use(PlaybackContext);
  if (playback === null)
    throw new Error(
      "The play button, the speeds and the scrub render inside FramePlayback.",
    );
  return playback;
}

/**
 * The playback behind the bar's play button and speeds (`fpPlay`, `fpTick`,
 * `fpSpeed`). It walks the frames shown by navigating to each in turn, and
 * holds each for its recorded gap to the next divided by the speed.
 *
 * It asks for one frame at a time: the next gap starts only once the frame it
 * asked for is the open one. It stops on the last frame, and play from there,
 * or from a frame the page does not hold, starts again from the first. A step
 * taken by hand stops it: a step key, a click on a link to one of the page's
 * frames (the bar's steps, the timeline, the frame list), or a touch of the
 * scrub. Space plays and pauses. The timer goes with the bar.
 */
export function FramePlayback({
  hrefs,
  gaps,
  index,
  children,
}: {
  /** The page's frames in order, as the link that opens each. */
  hrefs: readonly SafePath[];
  /** How long each frame is held at 1× before the next, from `playbackGaps`. */
  gaps: readonly number[];
  /** The open frame's place on the page; -1 when the page does not hold it. */
  index: number;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<PlaybackSpeed>(1);
  // A step has been asked for and the frame it asked from is still open.
  const [stepping, setStepping] = useState(false);
  // The open frame changed, so the step asked for has landed (or a person
  // went elsewhere, which ends the wait just the same).
  const [landed, setLanded] = useState(index);
  if (landed !== index) {
    setLanded(index);
    setStepping(false);
  }
  const count = hrefs.length;
  const disabled = count < 2;
  const done = !disabled && index >= count - 1;
  const running = playing && (stepping || (index >= 0 && index < count - 1));
  // It reached the last frame, or a person opened one the page does not hold.
  if (playing && !running) setPlaying(false);

  const next = running && !stepping ? (hrefs[index + 1] ?? null) : null;
  // Whole milliseconds, as a browser's timer counts them.
  const delay = Math.round((gaps[index] ?? PLAYBACK_MIN_MS) / speed);
  useEffect(() => {
    if (next === null) return;
    const timer = setTimeout(() => {
      setStepping(true);
      navigate.advance(next);
    }, delay);
    return () => {
      clearTimeout(timer);
    };
  }, [next, delay, navigate]);

  const stop = useCallback(() => {
    setPlaying(false);
    setStepping(false);
  }, []);

  const first = hrefs[0] ?? null;
  const toggle = useCallback(() => {
    if (running) {
      stop();
      return;
    }
    if (disabled || first === null) return;
    setPlaying(true);
    if (index < 0 || done) {
      setStepping(true);
      navigate.advance(first);
    }
  }, [running, disabled, first, index, done, navigate, stop]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isStepKey(event)) return;
      if (STEP_KEYS.has(event.key)) {
        stop();
        return;
      }
      if (event.key !== " " || event.repeat || isOnControl(event.target))
        return;
      // With nothing to play, space keeps its own job of scrolling the page.
      if (disabled) return;
      event.preventDefault();
      toggle();
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [toggle, stop, disabled]);

  // A click on a link to one of the page's frames is a step taken by hand,
  // wherever the link sits. It is heard in the capture phase, before the link
  // navigates, so the timer is cleared before the frame it opens can land. A
  // click that opens a new tab leaves this one playing.
  useEffect(() => {
    const frameLinks = new Set(
      hrefs.map((href) => new URL(href, document.baseURI).href),
    );
    const onClick = (event: MouseEvent) => {
      if (
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const link =
        event.target instanceof Element
          ? event.target.closest("a[href]")
          : null;
      if (link instanceof HTMLAnchorElement && frameLinks.has(link.href))
        stop();
    };
    document.addEventListener("click", onClick, true);
    return () => {
      document.removeEventListener("click", onClick, true);
    };
  }, [hrefs, stop]);

  const value = useMemo<Playback>(
    () => ({
      playing: running,
      done,
      disabled,
      speed,
      toggle,
      stop,
      setSpeed,
    }),
    [running, done, disabled, speed, toggle, stop],
  );
  return <PlaybackContext value={value}>{children}</PlaybackContext>;
}

/** `.fp-bar .play { min-width:82px }`: ▶ play, ❙❙ pause, or ▶ replay on the last frame. */
export function PlayButton() {
  const t = useTranslations("run.player.bar");
  const { playing, done, disabled, toggle } = usePlayback();
  const [glyph, word] = playing
    ? ["❙❙", t("pause")]
    : done
      ? ["▶", t("replay")]
      : ["▶", t("play")];
  return (
    <button
      type="button"
      data-testid="player-play"
      title={t("playTitle")}
      aria-keyshortcuts="Space"
      disabled={disabled}
      onClick={toggle}
      className={`${barShape} min-w-[82px] gap-1 ${disabled ? disabledStep : ""}`}
    >
      <span aria-hidden="true">{glyph}</span>
      {word}
    </button>
  );
}

/** `FP_SPEEDS` as a segment: 1×, 4×, 16×, the one playing pressed. */
export function SpeedSegment() {
  const t = useTranslations("run.player.bar");
  const { speed, setSpeed } = usePlayback();
  return (
    <span
      role="group"
      aria-label={t("speedLabel")}
      data-testid="player-speeds"
      className={speedSegment}
    >
      {PLAYBACK_SPEEDS.map((value) => (
        <button
          key={value}
          type="button"
          aria-pressed={speed === value}
          onClick={() => {
            setSpeed(value);
          }}
          className={speedButton}
        >
          {t("speed", { speed: value })}
        </button>
      ))}
    </span>
  );
}

/**
 * `.fp-scrub`: the range over the frames shown and the governed ticks under
 * it. The range moves freely while it is dragged and opens the frame it is
 * released on, so a drag across the run makes one read, not one per frame.
 * The caller keys it by the open frame, so a step resets it. Taking hold of it,
 * by pointer or by key, stops the playback, so no step the playback asks for
 * lands under a drag and resets the range mid-move.
 */
export function PlayerScrub({
  hrefs,
  index,
  steps,
  marks,
}: {
  /** The page's frames in order, as the link that opens each. */
  hrefs: readonly SafePath[];
  /** The open frame's place on the page; -1 when the page does not hold it. */
  index: number;
  steps: StepTargets;
  /** `.fp-ticks i`: a governed frame's place under the range and its hue. */
  marks: readonly { left: string; hue: string; title: string }[];
}) {
  const t = useTranslations("run.player.bar");
  const navigate = useNavigate();
  const { stop } = usePlayback();
  const [pos, setPos] = useState(Math.max(0, index));
  useStepKeys(steps);
  const commit = () => {
    const to = hrefs[pos];
    if (pos !== index && to !== undefined) navigate.push(to);
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
        onPointerDown={stop}
        onKeyDown={(event) => {
          if (RANGE_KEYS.has(event.key)) stop();
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
