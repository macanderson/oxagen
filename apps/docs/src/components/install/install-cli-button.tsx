"use client";

import { useState } from "react";
import { celebrate } from "@/components/install/celebrate";

/**
 * InstallCliButton — the site-wide floating "Install CLI" pill, mounted in the
 * root layout so it is reachable from every page (landing and /docs alike).
 * Clicking copies the one-line install command and kicks off the celebration
 * (corner confetti → applause → superhero one-liner, see celebrate.ts).
 */

const INSTALL_CMD = "curl -fsSL https://cli.oxagen.sh/install.sh | sh";

export function InstallCliButton() {
  const [copied, setCopied] = useState(false);

  async function install(): Promise<void> {
    try {
      await navigator.clipboard.writeText(INSTALL_CMD);
    } catch {
      /* clipboard unavailable — still celebrate; the command is on /install */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2600);
    celebrate();
  }

  return (
    <button
      type="button"
      onClick={install}
      aria-label={`Install the Oxagen CLI — copies: ${INSTALL_CMD}`}
      title={INSTALL_CMD}
      className="lp-grad-surface fixed bottom-5 right-5 z-50 inline-flex h-11 items-center gap-2 rounded-full px-5 text-sm font-semibold text-white shadow-lg transition-transform hover:scale-[1.04] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--_ember-flame,#F07650)] active:scale-100"
    >
      {copied ? (
        <>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M20 6 9 17l-5-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Copied — go run it!
        </>
      ) : (
        <>
          {/* terminal prompt glyph */}
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="m5 7 5 5-5 5m8 0h6" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Install CLI
        </>
      )}
    </button>
  );
}
