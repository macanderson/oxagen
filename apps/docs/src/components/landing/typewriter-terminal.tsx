"use client";

import { useEffect, useState } from "react";

/**
 * TypewriterTerminal — an animated macOS-style terminal that types each
 * command character-by-character, streams its output lines, then loops.
 * Shared by the home hero terminal and the CLI install landing page so the
 * landing surfaces have exactly one typing-terminal implementation.
 *
 * The blinking caret follows the cursor while typing and rests at a fresh
 * prompt when idle. Honours `prefers-reduced-motion`: reduced-motion users get
 * the fully-rendered transcript with no typing animation.
 */

type Line = {
  id: number;
  kind: "cmd" | "out" | "ok" | "dim";
  text: string;
  caret?: boolean;
};

export interface TerminalStep {
  cmd: string;
  out: { kind: "out" | "ok" | "dim"; text: string }[];
}

let _id = 0;
const nextId = () => ++_id;

function fullTranscript(steps: TerminalStep[]): Line[] {
  const lines: Line[] = [];
  for (const s of steps) {
    lines.push({ id: nextId(), kind: "cmd", text: s.cmd });
    for (const o of s.out)
      lines.push({ id: nextId(), kind: o.kind, text: o.text });
  }
  lines.push({ id: nextId(), kind: "cmd", text: "", caret: true });
  return lines;
}

export function TypewriterTerminal({
  steps,
  title,
  minHeightClass = "min-h-[244px]",
}: {
  steps: TerminalStep[];
  title: string;
  minHeightClass?: string;
}) {
  const [lines, setLines] = useState<Line[]>([]);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setLines(fullTranscript(steps));
      return;
    }

    // `cancelled` and `pending` are per-effect-run locals, not refs: the loop
    // never terminates on its own, so under StrictMode's mount/unmount/mount
    // a shared flag would let the first run un-cancel itself and race the
    // second, writing two interleaved transcripts into the same state.
    let cancelled = false;
    // Only the timer currently being awaited is tracked. The loop is infinite,
    // so accumulating every handle in an array would grow without bound for as
    // long as the tab stays open.
    let pending: ReturnType<typeof setTimeout> | undefined;
    const wait = (ms: number) =>
      new Promise<void>((res) => {
        pending = setTimeout(res, ms);
      });

    async function run() {
      while (!cancelled) {
        setLines([]);
        for (const step of steps) {
          if (cancelled) return;
          const id = nextId();
          setLines((p) => [...p, { id, kind: "cmd", text: "", caret: true }]);
          // type the command
          for (let i = 1; i <= step.cmd.length; i++) {
            await wait(36 + Math.random() * 46);
            if (cancelled) return;
            const slice = step.cmd.slice(0, i);
            setLines((p) =>
              p.map((l) => (l.id === id ? { ...l, text: slice } : l)),
            );
          }
          // command "runs" — drop the caret, stream output
          setLines((p) =>
            p.map((l) => (l.id === id ? { ...l, caret: false } : l)),
          );
          await wait(440);
          if (cancelled) return;
          for (const o of step.out) {
            await wait(240 + Math.random() * 160);
            if (cancelled) return;
            setLines((p) => [
              ...p,
              { id: nextId(), kind: o.kind, text: o.text },
            ]);
          }
          await wait(720);
          if (cancelled) return;
        }
        // rest at a fresh prompt, then loop
        setLines((p) => [
          ...p,
          { id: nextId(), kind: "cmd", text: "", caret: true },
        ]);
        await wait(4600);
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (pending !== undefined) clearTimeout(pending);
    };
  }, [steps]);

  return (
    <div className="lp-term w-full overflow-hidden rounded-xl text-left font-mono text-[12.5px] leading-relaxed sm:text-[13.5px]">
      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 select-none text-[11px] text-white/40">
          {title}
        </span>
      </div>

      {/* transcript */}
      <div className={`${minHeightClass} space-y-1 px-4 py-4 text-white/85`}>
        {lines.map((l) =>
          l.kind === "cmd" ? (
            <div key={l.id} className="lp-line flex items-start gap-2">
              <span className="select-none text-[var(--_ember-b,#EFC53F)]">
                $
              </span>
              <span className="break-all">
                {l.text}
                {l.caret && <span className="lp-caret ml-0.5 align-baseline" />}
              </span>
            </div>
          ) : (
            <div
              key={l.id}
              className={
                "lp-line break-all pl-4 " +
                (l.kind === "ok"
                  ? "text-[#38d39f]"
                  : l.kind === "dim"
                    ? "text-white/40"
                    : "text-white/70")
              }
            >
              {l.text}
            </div>
          ),
        )}
      </div>
    </div>
  );
}
