"use client";

/**
 * A clickable reproduction of the Command Deck's own tab strip.
 *
 * This is not an embedded terminal and it is not a screen recording — it is
 * nine static panes, one per real deck tab, and clicking a tab swaps which
 * one is showing. Each pane's content is trimmed straight out of
 * `crates/stella-tui/tests/snapshots/deck/tab_*.txt`, the golden renders that
 * `make gate` checks on every PR touching the TUI, so what is on screen here
 * is the deck's own output rather than a redrawn mock of it.
 *
 * There is no timer, nothing plays on a loop, and nothing moves without a
 * click — so there is no `prefers-reduced-motion` case to design around.
 */

import { useRef, useState } from "react";

import { COMMAND_DECK_TABS } from "@/components/stella/command-deck-tabs";

// This monorepo's tsconfig enables `noUncheckedIndexedAccess` (stella's own
// does not), so every `COMMAND_DECK_TABS[i]` reads as possibly `undefined`
// even though the literal array is always non-empty. Guarded explicitly
// below rather than asserted away, and the guards sit after the hooks —
// React requires every hook to run unconditionally on every render.
export function CommandDeckExplorer() {
  const firstTab = COMMAND_DECK_TABS[0];
  const [activeKey, setActiveKey] = useState(firstTab?.key ?? "");
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const active =
    COMMAND_DECK_TABS.find((tab) => tab.key === activeKey) ?? firstTab;

  function focusTab(index: number) {
    const total = COMMAND_DECK_TABS.length;
    if (total === 0) return;
    const wrapped = COMMAND_DECK_TABS[((index % total) + total) % total];
    if (!wrapped) return;
    setActiveKey(wrapped.key);
    tabRefs.current[wrapped.key]?.focus();
  }

  function handleKeyDown(
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      focusTab(index + 1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      focusTab(index - 1);
    }
  }

  if (!active) return null;

  return (
    <div className="dke">
      <div className="dke-tabs" role="tablist" aria-label="Command Deck tabs">
        {COMMAND_DECK_TABS.map((tab, index) => (
          <button
            key={tab.key}
            ref={(el) => {
              tabRefs.current[tab.key] = el;
            }}
            type="button"
            role="tab"
            id={`dke-tab-${tab.key}`}
            aria-selected={tab.key === activeKey}
            aria-controls={`dke-panel-${tab.key}`}
            tabIndex={tab.key === activeKey ? 0 : -1}
            className="dke-tab"
            data-active={tab.key === activeKey}
            onClick={() => setActiveKey(tab.key)}
            onKeyDown={(event) => handleKeyDown(event, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        className="dke-pane"
        role="tabpanel"
        id={`dke-panel-${active.key}`}
        aria-labelledby={`dke-tab-${active.key}`}
      >
        <p className="dke-blurb">{active.blurb}</p>
        <pre className="dke-lines">{active.lines.join("\n")}</pre>
      </div>
    </div>
  );
}
