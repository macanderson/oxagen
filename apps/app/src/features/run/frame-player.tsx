"use client";
// The frame player's live parts (mockup `fpBar`, `fpAfterRender` and its
// keydown handler): the scrub, the arrow, Home and End keys, the list kept on
// the open frame, and the button that opens the shell's approvals drawer.
//
// Every step is a navigation to `?body=<seq>`, because the open frame and its
// body are read on the server. So the player steps and scrubs, and it does not
// play: a playback would re-read the page once per frame.
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { openApprovals } from "@/features/shell/client";
import type { SafePath } from "@/shared/safe-path";
import { buttonSecondary } from "@/ui/control-styles";
import { useNavigate } from "@/ui/navigation";

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

/**
 * `.fp-scrub`: the range over the frames shown and the governed ticks under
 * it. The range moves freely while it is dragged and opens the frame it is
 * released on, so a drag across the run makes one read, not one per frame.
 * The caller keys it by the open frame, so a step resets it.
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
