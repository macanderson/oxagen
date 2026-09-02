"use client";

import {
  TypewriterTerminal,
  type TerminalStep,
} from "@/components/landing/typewriter-terminal";

/**
 * InstallTerminal — the /install landing-page animated terminal. Types the
 * full install sequence: the Oxagen agent-skills npx package, then the
 * install.sh curl script that fetches the platform binary and places it in
 * `~/.local/bin` (already on PATH per XDG convention), then a verify step.
 * Rendering + typing animation live in TypewriterTerminal.
 */

const STEPS: TerminalStep[] = [
  {
    cmd: "npx @oxagen/skills@latest install",
    out: [
      { kind: "dim", text: "◇ resolving @oxagen/skills · registry.npmjs.org" },
      {
        kind: "out",
        text: "→ 9 agent skill definitions installed to ~/.oxagen/skills",
      },
      { kind: "ok", text: "✓ skills installed in 3.4s" },
    ],
  },
  {
    cmd: "curl -fsSL https://cli.oxagen.sh/install.sh | sh",
    out: [
      { kind: "dim", text: "▸ detecting platform · darwin-arm64" },
      { kind: "dim", text: "▸ fetching oxagen v0.10.0 · verifying checksum" },
      { kind: "out", text: "install: ~/.local/bin/oxagen" },
      {
        kind: "ok",
        text: "✓ oxagen is on your PATH — run `oxagen` to get started",
      },
    ],
  },
  {
    cmd: "oxagen --version",
    out: [{ kind: "out", text: "oxagen/0.10.0 · node v20.11 · darwin-arm64" }],
  },
];

export function InstallTerminal() {
  return (
    <TypewriterTerminal
      steps={STEPS}
      title="oxagen — cli install"
      minHeightClass="min-h-[276px]"
    />
  );
}
