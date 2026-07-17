// @vitest-environment jsdom
/**
 * agent-bottom-bar.test.tsx — render tests for AgentBottomBar.
 *
 * AgentBottomBar is the persistent bottom toolbar in the authenticated shell.
 * It reads state from useAgentPanelStore; we mock the hook so each test can
 * pin a specific store state and assert the component's rendering branches:
 *   - The toolbar + always-present "Open AI agent" / history buttons.
 *   - The collapsed-conversation tab (only when collapsed + a title exists).
 *   - The status indicator (hidden when idle; labelled for active/completed).
 *   - The open() wiring on the launch + resume buttons.
 *
 * Replaces the stale e2e/agent-panel.spec.ts, which tested a removed
 * "agent-panel-launcher" design (PR #164's glassmorphism panel) on /login.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

// Hoisted mutable store state + pathname so the (hoisted) vi.mock factories can
// read them. `pathname` defaults to a non-`/sessions` route so the bar renders in the
// existing suites; the route-suppression suite overrides it per test.
const h = vi.hoisted(() => ({
  state: {
    visibility: "closed" as "open" | "collapsed" | "closed",
    status: "idle" as "idle" | "active" | "completed",
    conversationTitle: null as string | null,
    open: vi.fn(),
  },
  pathname: "/acme/prod/knowledge",
}));

vi.mock("./use-agent-panel-store", () => ({
  useAgentPanelStore: () => h.state,
}));

vi.mock("next/navigation", () => ({
  usePathname: () => h.pathname,
}));

import { AgentBottomBar } from "./agent-bottom-bar";

beforeEach(() => {
  h.state.visibility = "closed";
  h.state.status = "idle";
  h.state.conversationTitle = null;
  h.state.open = vi.fn();
  h.pathname = "/acme/prod/knowledge";
});

afterEach(cleanup);

describe("AgentBottomBar — always-present chrome", () => {
  it("renders the agent toolbar", () => {
    render(<AgentBottomBar />);
    expect(
      screen.getByRole("toolbar", { name: /agent toolbar/i }),
    ).toBeInTheDocument();
  });

  it("renders the 'Open AI agent' launch button with the Ask Oxagen label", () => {
    render(<AgentBottomBar />);
    const launch = screen.getByRole("button", { name: /open ai agent/i });
    expect(launch).toBeInTheDocument();
    expect(launch).toHaveTextContent(/ask oxagen/i);
    expect(launch).toHaveAttribute("type", "button");
  });

  it("renders the conversation-history button", () => {
    render(<AgentBottomBar />);
    expect(
      screen.getByRole("button", { name: /conversation history/i }),
    ).toBeInTheDocument();
  });

  it("calls open() when the launch button is clicked", () => {
    render(<AgentBottomBar />);
    fireEvent.click(screen.getByRole("button", { name: /open ai agent/i }));
    expect(h.state.open).toHaveBeenCalledTimes(1);
  });
});

describe("AgentBottomBar — route suppression", () => {
  it("renders nothing on the /sessions conversation surface", () => {
    h.pathname = "/acme/prod/sessions";
    const { container } = render(<AgentBottomBar />);
    expect(container).toBeEmptyDOMElement();
    expect(
      screen.queryByRole("toolbar", { name: /agent toolbar/i }),
    ).toBeNull();
  });

  it("still renders on a non-/sessions route", () => {
    h.pathname = "/acme/prod/knowledge";
    render(<AgentBottomBar />);
    expect(
      screen.getByRole("toolbar", { name: /agent toolbar/i }),
    ).toBeInTheDocument();
  });

  it("does not false-positive on a route where an earlier segment is 'sessions'", () => {
    // An org/workspace literally named "sessions" must not suppress the bar on
    // its other pages — only the trailing `/sessions` segment counts.
    h.pathname = "/sessions/prod/knowledge";
    render(<AgentBottomBar />);
    expect(
      screen.getByRole("toolbar", { name: /agent toolbar/i }),
    ).toBeInTheDocument();
  });
});

describe("AgentBottomBar — collapsed conversation tab", () => {
  it("is hidden when the panel is closed (default)", () => {
    render(<AgentBottomBar />);
    expect(
      screen.queryByRole("button", { name: /resume conversation/i }),
    ).toBeNull();
  });

  it("is hidden when collapsed but there is no conversation title", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = null;
    render(<AgentBottomBar />);
    expect(
      screen.queryByRole("button", { name: /resume conversation/i }),
    ).toBeNull();
  });

  it("shows the conversation title when collapsed with a title", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = "Deploy plan";
    render(<AgentBottomBar />);
    const resume = screen.getByRole("button", {
      name: /resume conversation: deploy plan/i,
    });
    expect(resume).toBeInTheDocument();
    expect(resume).toHaveTextContent("Deploy plan");
  });

  it("calls open() when the collapsed conversation tab is clicked", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = "Deploy plan";
    render(<AgentBottomBar />);
    fireEvent.click(
      screen.getByRole("button", { name: /resume conversation: deploy plan/i }),
    );
    expect(h.state.open).toHaveBeenCalledTimes(1);
  });
});

describe("AgentBottomBar — status indicator", () => {
  it("renders no status indicator when idle", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = "Deploy plan";
    h.state.status = "idle";
    render(<AgentBottomBar />);
    expect(screen.queryByLabelText(/agent is working/i)).toBeNull();
    expect(screen.queryByLabelText(/agent completed/i)).toBeNull();
  });

  it("labels the indicator 'Agent is working' when active", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = "Deploy plan";
    h.state.status = "active";
    render(<AgentBottomBar />);
    expect(screen.getByLabelText(/agent is working/i)).toBeInTheDocument();
  });

  it("labels the indicator 'Agent completed' when completed", () => {
    h.state.visibility = "collapsed";
    h.state.conversationTitle = "Deploy plan";
    h.state.status = "completed";
    render(<AgentBottomBar />);
    expect(screen.getByLabelText(/agent completed/i)).toBeInTheDocument();
  });
});
