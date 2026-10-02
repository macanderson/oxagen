"use client";

import {
  TypewriterTerminal,
  type TerminalStep,
} from "@/components/landing/typewriter-terminal";
import { INSTALL_CMD } from "@/lib/install";

/**
 * HeroTerminal: the home-page animated terminal. It installs the Oxagen CLI
 * and prints its version, then loops. The lines match what install.sh prints.
 * The CLI runs no agent turns (they moved to the stella CLI), so the animation
 * shows none. Rendering and the typing animation live in TypewriterTerminal.
 */

const STEPS: TerminalStep[] = [
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

export function HeroTerminal() {
  return <TypewriterTerminal steps={STEPS} title="oxagen · install" />;
}
