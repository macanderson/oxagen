// @vitest-environment jsdom
/**
 * session-settings.test.tsx — the SessionSettings component: writes go
 * through useChatSession() only (verified via a sibling state probe), and the
 * drawer vs rail/slide-over picker chrome differs (pushed full-screen page vs
 * an anchored Popover). The Base UI popover is mocked to render inline so its
 * content is assertable in jsdom — the same convention used by
 * `inference-details-popover.test.tsx`.
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    render,
    children,
  }: {
    render: React.ReactElement;
    children?: React.ReactNode;
  }) => React.cloneElement(render, undefined, children),
  PopoverPopup: ({
    children,
    className,
  }: {
    children: React.ReactNode;
    className?: string;
  }) => (
    <div role="dialog" aria-label="Session picker" className={className}>
      {children}
    </div>
  ),
}));

import { SessionSettings } from "./session-settings";
import { ChatSessionProvider, useChatSession } from "./session-store";
import { sessionStorageKey, type SessionSeed } from "./session-state";
import type { AgentOption } from "../agent-picker/agent-picker-types";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const CODER: AgentOption = {
  agentId: "agt_code",
  slug: "coder",
  name: "Coder",
  description: null,
  agentType: "code",
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};



const MODEL_CONFIG: ResolvedTierCatalog = {
  text: {
    fast: "anthropic/claude-haiku-4.5",
    balanced: "anthropic/claude-sonnet-5",
    precise: "anthropic/claude-opus-4.8",
  },
  image: {
    basic: "google/gemini-3.1-flash-image-preview",
    advanced: "bfl/flux-2-max",
  },
  video: {
    basic: "google/veo-3.0-fast-generate-001",
    advanced: "google/veo-3.0-generate-001",
  },
};

const SEED: SessionSeed = {
  defaultAgentId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

/** Exposes the store as DOM alongside the rendered SessionSettings. */
function StateProbe() {
  const { state } = useChatSession();
  return <output data-testid="state">{JSON.stringify(state)}</output>;
}

function stateOf(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("state").textContent ?? "{}") as Record<
    string,
    unknown
  >;
}

interface HarnessProps {
  variant?: "drawer" | "slide-over" | "rail";
  agents?: AgentOption[];
  walletBalanceUsd?: number | null;
  hasMessages?: boolean;
  conversationId?: string | null;
  isNewConversation?: boolean;
  onOpenAgentPicker?: () => void;
  onStartNewChat?: () => void;
}

function renderHarness(props: HarnessProps = {}) {
  return render(
    <ChatSessionProvider
      workspaceSlug="ws"
      conversationId={props.conversationId ?? null}
      boundAgentId={null}
      isNewConversation={props.isNewConversation ?? true}
      hasMessages={props.hasMessages ?? false}
      seed={SEED}
    >
      <StateProbe />
      <SessionSettings
        variant={props.variant ?? "rail"}
        agents={props.agents ?? [CODER]}
        modelConfig={MODEL_CONFIG}
        walletBalanceUsd={props.walletBalanceUsd ?? null}
        onOpenAgentPicker={props.onOpenAgentPicker}
        onStartNewChat={props.onStartNewChat}
      />
    </ChatSessionProvider>,
  );
}

describe("SessionSettings — Session section", () => {
  it("writes effort via the reasoning-effort segmented control", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(stateOf().effort).toBe("high");
  });

  it("writes a budget preset via a chip", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "$2" }));
    expect(stateOf().budgetUsd).toBe(2);
  });

  it("the custom budget stepper respects min/step and clamps below the minimum", () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "Custom" }));
    const input = screen.getByLabelText("Custom per-turn budget in dollars");
    expect(input).toHaveAttribute("min", "0.05");
    expect(input).toHaveAttribute("step", "0.25");
    fireEvent.change(input, { target: { value: "0.01" } });
    expect(stateOf().budgetUsd).toBe(0.05);
  });

  it('"Reset to defaults" restores the seeded state', () => {
    renderHarness();
    fireEvent.click(screen.getByRole("button", { name: "High" }));
    expect(stateOf().effort).toBe("high");
    fireEvent.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(stateOf().effort).toBe("medium");
  });
});

describe("SessionSettings — Agent row", () => {
  it("shows the locked explanation and a new-chat action once the agent is locked", () => {
    const onStartNewChat = vi.fn();
    renderHarness({ hasMessages: true, onStartNewChat });
    expect(
      screen.getByText("Locked after the first message"),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByText("Start a new chat with a different agent"),
    );
    expect(onStartNewChat).toHaveBeenCalledTimes(1);
  });

  it("opens the agent picker when unlocked", () => {
    const onOpenAgentPicker = vi.fn();
    renderHarness({ onOpenAgentPicker });
    fireEvent.click(screen.getByRole("button", { name: /^Agent:/ }));
    expect(onOpenAgentPicker).toHaveBeenCalledTimes(1);
  });
});

describe("SessionSettings — picker chrome by variant", () => {
  it("drawer variant opens a picker as a full-screen pushed page with no popover role", () => {
    renderHarness({ variant: "drawer" });
    fireEvent.click(screen.getByRole("button", { name: /^Model:/ }));
    expect(screen.getByRole("button", { name: "Back" })).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    // The pushed page replaces the whole surface — the section headers are gone.
    expect(screen.queryByText("Session")).not.toBeInTheDocument();
  });

  it("rail variant renders picker content inside an anchored popover", () => {
    renderHarness({ variant: "rail" });
    expect(screen.getAllByRole("dialog").length).toBeGreaterThan(0);
  });
});
