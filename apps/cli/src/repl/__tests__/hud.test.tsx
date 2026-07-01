/**
 * HudPanel — proves the `/hud` heads-up display renders the live registry: the
 * header vitals, each agent's status glyph, kind, title and model, and the
 * empty state when nothing is running.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render } from "ink-testing-library";
import React from "react";
import { HudPanel } from "../hud.js";
import { agentRegistry } from "../../agent/agent-registry.js";

// A fixed clock so elapsed timers render deterministically.
const NOW = 100_000;
const nowFn = () => NOW;

beforeEach(() => agentRegistry.clear());
afterEach(() => agentRegistry.clear());

describe("HudPanel", () => {
  it("shows the empty state when no agents are running", () => {
    const { lastFrame, unmount } = render(<HudPanel nowFn={nowFn} />);
    expect(lastFrame()).toContain("No agents running");
    unmount();
  });

  it("renders a running turn with its title and model tier", () => {
    agentRegistry.register({
      kind: "turn",
      title: "add rate limiting to the API",
      model: "anthropic/claude-sonnet-5",
    });
    const { lastFrame, unmount } = render(<HudPanel nowFn={nowFn} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("HUD");
    expect(frame).toContain("1 running");
    expect(frame).toContain("[turn]");
    expect(frame).toContain("add rate limiting to the API");
    // Sonnet-5 resolves to the "Sonnet" tier label.
    expect(frame).toContain("Sonnet");
    unmount();
  });

  it("renders a background monitor and a just-finished agent together", () => {
    agentRegistry.register({ kind: "monitor", title: "actions run 42", detail: "watching" });
    agentRegistry.register({ kind: "turn", title: "done thing" }).done();
    const { lastFrame, unmount } = render(<HudPanel nowFn={nowFn} />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("[monitor]");
    expect(frame).toContain("actions run 42");
    expect(frame).toContain("done thing");
    // Header reflects one running (monitor) and one done (turn).
    expect(frame).toContain("1 running");
    expect(frame).toContain("✓ 1");
    unmount();
  });
});
