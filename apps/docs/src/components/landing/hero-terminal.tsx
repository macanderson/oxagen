"use client";

import {
  TypewriterTerminal,
  type TerminalStep,
} from "@/components/landing/typewriter-terminal";

/**
 * HeroTerminal — the home-page animated terminal: installs the Oxagen CLI,
 * verifies the version, and runs a sample agent query — then loops.
 * Rendering + typing animation live in TypewriterTerminal.
 */

const STEPS: TerminalStep[] = [
  {
    cmd: "curl -fsSL https://cli.oxagen.sh/install.sh | sh",
    out: [
      { kind: "dim", text: "▸ detecting platform · darwin-arm64" },
      { kind: "dim", text: "▸ fetching oxagen · verifying checksum" },
      { kind: "out", text: "install: ~/.local/bin/oxagen" },
      { kind: "ok", text: "✓ oxagen is on your PATH" },
    ],
  },
  {
    cmd: "oxagen --version",
    out: [{ kind: "out", text: "oxagen/0.10.0 · node v20.11 · darwin-arm64" }],
  },
  {
    cmd: 'oxagen "where do we enforce tenant isolation?"',
    out: [
      {
        kind: "dim",
        text: "◇ planning · scanning the workspace knowledge graph",
      },
      {
        kind: "out",
        text: "→ packages/database/rls.sql — FORCE ROW LEVEL SECURITY on every tenant table",
      },
      {
        kind: "out",
        text: "→ oxagen_app role has no BYPASSRLS; an unscoped query returns zero rows",
      },
      { kind: "ok", text: "✓ answered in 4.2s · 1,284 context tokens used" },
    ],
  },
];

export function HeroTerminal() {
  return <TypewriterTerminal steps={STEPS} title="oxagen — install" />;
}
