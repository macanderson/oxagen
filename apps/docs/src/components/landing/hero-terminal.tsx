"use client";

import { useEffect, useRef, useState } from "react";

/**
 * HeroTerminal — an animated macOS-style terminal that types the Oxagen CLI
 * install command (`pnpm add -g @oxagen/cli`), streams realistic install
 * output, verifies the version, and runs a sample agent query — then loops.
 *
 * The blinking caret follows the cursor while typing and rests at a fresh
 * prompt when idle. Honours `prefers-reduced-motion`: reduced-motion users get
 * the fully-rendered transcript with no typing animation.
 */

type Line = { id: number; kind: "cmd" | "out" | "ok" | "dim"; text: string; caret?: boolean };

interface Step {
  cmd: string;
  out: { kind: "out" | "ok" | "dim"; text: string }[];
}

const STEPS: Step[] = [
  {
    cmd: "pnpm add -g @oxagen/cli",
    out: [
      { kind: "dim", text: "Packages: +1" },
      { kind: "dim", text: "Progress: resolved 1, reused 1, downloaded 0, added 1, done" },
      { kind: "out", text: "+ @oxagen/cli 0.6.4" },
      { kind: "ok", text: "Done in 2.1s" },
    ],
  },
  {
    cmd: "oxagen --version",
    out: [{ kind: "out", text: "oxagen/0.6.4 · node v20.11 · darwin-arm64" }],
  },
  {
    cmd: 'oxagen "where do we enforce tenant isolation?"',
    out: [
      { kind: "dim", text: "◇ planning · scanning the workspace knowledge graph" },
      { kind: "out", text: "→ packages/database/rls.sql — FORCE ROW LEVEL SECURITY on every tenant table" },
      { kind: "out", text: "→ oxagen_app role has no BYPASSRLS; an unscoped query returns zero rows" },
      { kind: "ok", text: "✓ answered in 4.2s · 1,284 context tokens used" },
    ],
  },
];

let _id = 0;
const nextId = () => ++_id;

function fullTranscript(): Line[] {
  const lines: Line[] = [];
  for (const s of STEPS) {
    lines.push({ id: nextId(), kind: "cmd", text: s.cmd });
    for (const o of s.out) lines.push({ id: nextId(), kind: o.kind, text: o.text });
  }
  lines.push({ id: nextId(), kind: "cmd", text: "", caret: true });
  return lines;
}

export function HeroTerminal() {
  const [lines, setLines] = useState<Line[]>([]);
  const cancelled = useRef(false);

  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setLines(fullTranscript());
      return;
    }

    cancelled.current = false;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const wait = (ms: number) =>
      new Promise<void>((res) => timers.push(setTimeout(res, ms)));

    async function run() {
      while (!cancelled.current) {
        setLines([]);
        for (const step of STEPS) {
          if (cancelled.current) return;
          const id = nextId();
          setLines((p) => [...p, { id, kind: "cmd", text: "", caret: true }]);
          // type the command
          for (let i = 1; i <= step.cmd.length; i++) {
            if (cancelled.current) return;
            await wait(36 + Math.random() * 46);
            const slice = step.cmd.slice(0, i);
            setLines((p) => p.map((l) => (l.id === id ? { ...l, text: slice } : l)));
          }
          // command "runs" — drop the caret, stream output
          setLines((p) => p.map((l) => (l.id === id ? { ...l, caret: false } : l)));
          await wait(440);
          for (const o of step.out) {
            if (cancelled.current) return;
            await wait(240 + Math.random() * 160);
            setLines((p) => [...p, { id: nextId(), kind: o.kind, text: o.text }]);
          }
          await wait(720);
        }
        // rest at a fresh prompt, then loop
        setLines((p) => [...p, { id: nextId(), kind: "cmd", text: "", caret: true }]);
        await wait(4600);
      }
    }

    void run();
    return () => {
      cancelled.current = true;
      timers.forEach(clearTimeout);
    };
  }, []);

  return (
    <div className="lp-term w-full overflow-hidden rounded-xl text-left font-mono text-[12.5px] leading-relaxed sm:text-[13.5px]">
      {/* title bar */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-2.5">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 select-none text-[11px] text-white/40">
          oxagen — install
        </span>
      </div>

      {/* transcript */}
      <div className="min-h-[244px] space-y-1 px-4 py-4 text-white/85">
        {lines.map((l) =>
          l.kind === "cmd" ? (
            <div key={l.id} className="lp-line flex items-start gap-2">
              <span className="select-none text-[var(--_ember-flame,#FF7E5F)]">$</span>
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
