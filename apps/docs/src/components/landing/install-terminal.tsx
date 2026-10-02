"use client";

import {
  TypewriterTerminal,
  type TerminalStep,
} from "@/components/landing/typewriter-terminal";
import { INSTALL_CMD } from "@/lib/install";

/**
 * InstallTerminal — the /install landing-page animated terminal. Types the
 * full install sequence: the Oxagen agent-skills npx package, then the
 * install.sh curl script, which downloads the executable for the platform,
 * checks its SHA-256, and installs it to `~/.local/bin`, then a verify step.
 * The install lines match what install.sh prints. Rendering and the typing
 * animation live in TypewriterTerminal.
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
    cmd: INSTALL_CMD,
    out: [
      {
        kind: "dim",
        text: "▸ downloading https://downloads.oxagen.sh/latest/oxagen-aarch64-apple-darwin",
      },
      { kind: "ok", text: "✓ checksum matches" },
      { kind: "ok", text: "✓ installed ~/.local/bin/oxagen (2.1.4)" },
    ],
  },
  {
    cmd: "oxagen --version",
    out: [{ kind: "out", text: "2.1.4" }],
  },
];

export function InstallTerminal() {
  return <TypewriterTerminal steps={STEPS} title="oxagen · cli install" />;
}
