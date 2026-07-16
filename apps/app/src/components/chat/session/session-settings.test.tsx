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
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";
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
  isCode: true,
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};

const REPOS: RepoOption[] = [
  {
    key: "con_1::acme/platform",
    connectionId: "con_1",
    owner: "acme",
    name: "platform",
    defaultBranch: "main",
  },
  {
    key: "con_1::acme/site",
    connectionId: "con_1",
    owner: "acme",
    name: "site",
    defaultBranch: "main",
  },
  {
    key: "con_2::umbrella/labs",
    connectionId: "con_2",
    owner: "umbrella",
    name: "labs",
    defaultBranch: "develop",
  },
];

const ENVIRONMENTS: EnvironmentOption[] = [
  { id: "env_1", name: "Node 22", isDefault: true },
  { id: "env_2", name: "Python 3.12", isDefault: false },
];

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
  defaultRepoKey: "con_1::acme/platform",
  defaultEnvId: "env_1",
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
  repos?: RepoOption[];
  environments?: EnvironmentOption[];
  branches?: string[] | null;
  branchesLoading?: boolean;
  defaultBranch?: string | null;
  walletBalanceUsd?: number | null;
  hasMessages?: boolean;
  conversationId?: string | null;
  isNewConversation?: boolean;
  onOpenAgentPicker?: () => void;
  onStartNewChat?: () => void;
  onLoadBranches?: () => void;
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
        repos={props.repos ?? REPOS}
        environments={props.environments ?? ENVIRONMENTS}
        modelConfig={MODEL_CONFIG}
        branches={props.branches ?? null}
        branchesLoading={props.branchesLoading ?? false}
        onLoadBranches={props.onLoadBranches ?? (() => {})}
        defaultBranch={props.defaultBranch ?? null}
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

describe("SessionSettings — Code section", () => {
  it("picking a different organization resets repo and branch (the store cascade)", () => {
    renderHarness({ variant: "rail" });
    // Exact match: the "labs" repo row's accessible name is "labs umbrella"
    // (label + owner sublabel) — only the Organization row's name is bare "umbrella".
    fireEvent.click(screen.getByRole("option", { name: "umbrella" }));
    const s = stateOf();
    expect(s.org).toBe("umbrella");
    expect(s.repoKey).toBeNull();
    expect(s.branch).toBeNull();
  });

  it("shows a warning message for a branch that no longer exists", () => {
    window.localStorage.setItem(
      sessionStorageKey("ws", "cnv_1"),
      JSON.stringify({
        v: 1,
        agentId: null,
        tier: "fast",
        model: null,
        effort: "medium",
        budgetUsd: null,
        org: "acme",
        repoKey: "con_1::acme/platform",
        branch: "feat/gone",
        envId: "env_1",
      }),
    );
    renderHarness({
      conversationId: "cnv_1",
      isNewConversation: false,
      branches: ["main", "develop"],
    });
    expect(
      screen.getByText("Branch feat/gone was deleted. Pick another branch."),
    ).toBeInTheDocument();
  });
});

describe("SessionSettings — picker chrome by variant", () => {
  it("drawer variant opens a picker as a full-screen pushed page with no popover role", () => {
    renderHarness({ variant: "drawer" });
    fireEvent.click(screen.getByRole("button", { name: /^Repository:/ }));
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
