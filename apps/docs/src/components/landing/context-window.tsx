"use client";

import { useEffect, useMemo, useRef, useState } from "react";

/**
 * ContextWindow — the landing page's central concept animation: "context
 * windows, more free than full."
 *
 * A token grid stands in for an LLM context window. It cycles between two
 * states:
 *   • OVERLOADED — ~86% of the window crammed with ember-hot tokens (every
 *     document dumped in; the model drowns and degrades).
 *   • GOVERNED   — ~9% lit in a cool, precise cluster (only the authorized,
 *     relevant slice, retrieved from the typed knowledge graph).
 *
 * A usage meter tweens between the two so the "free, not full" idea is legible
 * at a glance. Honours prefers-reduced-motion by holding the governed state.
 */

const COLS = 18;
const ROWS = 8;
const TOTAL = COLS * ROWS;

// Deterministic "overloaded" scatter — frothy, not a clean fill line.
function isOverloaded(i: number): boolean {
  return (i * 73 + (i % 7) * 11) % 100 < 86;
}

// The governed slice: a focused cluster + a few precise satellites.
const GOVERNED = new Set<number>();
for (let r = 3; r <= 4; r++)
  for (let c = 7; c <= 10; c++) GOVERNED.add(r * COLS + c);
[
  1 * COLS + 2,
  6 * COLS + 14,
  5 * COLS + 3,
  0 * COLS + 16,
  7 * COLS + 11,
].forEach((i) => GOVERNED.add(i));

const FULL_PCT = 86;
const FREE_USED_PCT = 9;

export function ContextWindow() {
  const [governed, setGoverned] = useState(true);
  const [used, setUsed] = useState(FREE_USED_PCT);
  const raf = useRef<number | null>(null);

  // phase cycler
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setGoverned(true);
      setUsed(FREE_USED_PCT);
      return;
    }
    const t = setInterval(() => setGoverned((g) => !g), 4600);
    return () => clearInterval(t);
  }, []);

  // tween the usage number toward the active phase target
  useEffect(() => {
    const target = governed ? FREE_USED_PCT : FULL_PCT;
    const start = performance.now();
    const from = used;
    const dur = 760;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - t, 3);
      setUsed(Math.round(from + (target - from) * eased));
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [governed]);

  const cells = useMemo(() => Array.from({ length: TOTAL }, (_, i) => i), []);

  return (
    <div className="w-full">
      {/* status row */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span
            className="size-2.5 rounded-full transition-colors duration-500"
            style={{
              background: governed
                ? "var(--success, #7BC98A)"
                : "var(--_ember-b, #EFC53F)",
              boxShadow: `0 0 10px ${governed ? "rgba(123,201,138,.8)" : "rgba(239,197,63,.8)"}`,
            }}
          />
          <span className="font-mono text-xs font-medium tracking-wide text-muted-foreground">
            {governed ? "GOVERNED RETRIEVAL" : "EVERYTHING IN CONTEXT"}
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 font-mono">
          <span
            className="text-2xl font-semibold tabular-nums transition-colors duration-500"
            style={{
              color: governed
                ? "var(--success, #7BC98A)"
                : "var(--_ember-b, #EFC53F)",
            }}
          >
            {used}%
          </span>
          <span className="text-xs text-muted-foreground">used</span>
        </div>
      </div>

      {/* usage bar */}
      <div className="mb-5 h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
        <div
          className="h-full rounded-full transition-[width,background-color] duration-700 ease-out"
          style={{
            width: `${used}%`,
            background: governed
              ? "var(--success, #7BC98A)"
              : "linear-gradient(90deg, var(--_ember-a,#725A00), var(--_ember-b,#EFC53F), var(--_ember-c,#F7D96B))",
          }}
        />
      </div>

      {/* token grid */}
      <div
        className="grid gap-1.5"
        style={{ gridTemplateColumns: `repeat(${COLS}, minmax(0, 1fr))` }}
        aria-hidden="true"
      >
        {cells.map((i) => {
          const lit = governed ? GOVERNED.has(i) : isOverloaded(i);
          const bg = !lit
            ? "color-mix(in oklch, var(--foreground) 7%, transparent)"
            : governed
              ? "var(--success, #7BC98A)"
              : "var(--_ember-b, #EFC53F)";
          return (
            <span
              key={i}
              className="aspect-square rounded-[3px]"
              style={{
                background: bg,
                boxShadow: lit
                  ? `0 0 8px ${governed ? "rgba(123,201,138,.55)" : "rgba(239,197,63,.6)"}`
                  : "none",
                transition: "background-color .55s ease, box-shadow .55s ease",
                transitionDelay: `${(i % COLS) * 9}ms`,
              }}
            />
          );
        })}
      </div>

      {/* caption */}
      <p className="mt-5 text-sm text-muted-foreground">
        {governed ? (
          <>
            <span className="font-medium text-foreground">Free, not full.</span>{" "}
            Oxagen retrieves only the authorized, relevant slice from your typed
            knowledge graph — RBAC-scoped, so the window stays open and the
            model stays sharp.
          </>
        ) : (
          <>
            <span className="font-medium text-foreground">
              Full, and failing.
            </span>{" "}
            Dump every document into the prompt and the window saturates —
            latency climbs, cost climbs, and recall collapses in the noise.
          </>
        )}
      </p>
    </div>
  );
}
