"use client";

import { TypewriterTerminal, type TerminalStep } from "@/components/landing/typewriter-terminal";

/**
 * HeroTerminal — the home-page animated terminal: installs the Oxagen CLI,
 * verifies the version, and runs a sample agent query — then loops.
 * Rendering + typing animation live in TypewriterTerminal.
 */

const STEPS: TerminalStep[] = [
  {
    cmd: "pnpm add -g @oxagen/cli",
    out: [
      { kind: "dim", text: "Packages: +1" },
      { kind: "dim", text: "Progress: resolved 1, reused 1, downloaded 0, added 1, done" },
      { kind: "out", text: "+ @oxagen/cli 0.10.0" },
      { kind: "ok", text: "Done in 2.1s" },
    ],
  },
  {
    cmd: "oxagen --version",
    out: [{ kind: "out", text: "oxagen/0.10.0 · node v20.11 · darwin-arm64" }],
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

export function HeroTerminal() {
  return <TypewriterTerminal steps={STEPS} title="oxagen — install" />;
}
