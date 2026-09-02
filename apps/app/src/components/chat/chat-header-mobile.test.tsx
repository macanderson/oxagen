// @vitest-environment jsdom
/**
 * chat-header-mobile.test.tsx
 *
 * ChatHeaderMobile reads the unified session store directly (it is only ever
 * mounted once useChatSessionContext() !== null — see the mount gate in
 * chat-shell-client.tsx), so every test wraps it in a real ChatSessionProvider
 * seeded to the scenario under test, following the same convention as
 * session-settings.test.tsx.
 *
 * Covers:
 *   - agent name + `{model} · {branch}` subtitle render from the store
 *   - falls back to "Default assistant" / a capitalized tier label
 *   - center tap calls onOpenSettings
 *   - Conversations / Activity buttons call their handlers
 *   - the activity dot appears only while isStreaming
 *   - every icon button carries an aria-label
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatHeaderMobile } from "./chat-header-mobile";
import { ChatSessionProvider } from "./session/session-store";
import type { SessionSeed } from "./session/session-state";
import type { AgentOption } from "./agent-picker/agent-picker-types";
import type { RepoOption } from "./repo-selector";
import type { EnvironmentOption } from "./environment-selector";

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
];

const ENVIRONMENTS: EnvironmentOption[] = [
  { id: "env_1", name: "Node 22", isDefault: true },
];

const BASE_SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: null,
  defaultEnvId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

function renderHeader(
  props: Partial<React.ComponentProps<typeof ChatHeaderMobile>> = {},
  seed: SessionSeed = BASE_SEED,
) {
  return render(
    <ChatSessionProvider
      workspaceSlug="acme-ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation={true}
      hasMessages={false}
      seed={seed}
    >
      <ChatHeaderMobile
        agents={[CODER]}
        repos={REPOS}
        environments={ENVIRONMENTS}
        isStreaming={false}
        onOpenSettings={vi.fn()}
        onOpenActivity={vi.fn()}
        {...props}
      />
    </ChatSessionProvider>,
  );
}

describe("ChatHeaderMobile — session summary", () => {
  it("renders 'Default assistant' and the fast-tier model label with no repo selected", () => {
    renderHeader();
    expect(screen.getByText("Default assistant")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
  });

  it("renders the current agent's name and `{model} · {branch}` subtitle when an agent + repo are seeded", () => {
    renderHeader(
      { agents: [CODER] },
      {
        ...BASE_SEED,
        defaultAgentId: "agt_code",
        defaultRepoKey: "con_1::acme/platform",
      },
    );
    expect(screen.getByText("Coder")).toBeInTheDocument();
    // No explicit branch chosen — sessionSubtitleParts falls back to the
    // repo's default branch ("main").
    expect(screen.getByText("Fast · main")).toBeInTheDocument();
  });

  it("uses modelLabelOf to prettify an explicit gateway model id", () => {
    renderHeader(
      {},
      { ...BASE_SEED, textModel: "anthropic/claude-sonnet-5", textTier: null },
    );
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
  });
});

describe("ChatHeaderMobile — interactions", () => {
  it("calls onOpenSettings when the center summary is tapped", () => {
    const onOpenSettings = vi.fn();
    renderHeader({ onOpenSettings });
    fireEvent.click(screen.getByRole("button", { name: "Session settings" }));
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenConversations when the left button is tapped", () => {
    const onOpenConversations = vi.fn();
    renderHeader({ onOpenConversations });
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
    expect(onOpenConversations).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenActivity when the activity button is tapped", () => {
    const onOpenActivity = vi.fn();
    renderHeader({ onOpenActivity });
    fireEvent.click(screen.getByRole("button", { name: "Activity" }));
    expect(onOpenActivity).toHaveBeenCalledTimes(1);
  });

  it("does not throw when onOpenConversations is omitted", () => {
    expect(() =>
      renderHeader({ onOpenConversations: undefined }),
    ).not.toThrow();
    fireEvent.click(screen.getByRole("button", { name: "Conversations" }));
  });
});

describe("ChatHeaderMobile — activity status dot", () => {
  it("shows the pulsing status dot on the Activity button while streaming", () => {
    renderHeader({ isStreaming: true });
    expect(screen.getByTestId("chat-header-activity-dot")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activity, in progress" }),
    ).toBeInTheDocument();
  });

  it("omits the status dot when not streaming", () => {
    renderHeader({ isStreaming: false });
    expect(
      screen.queryByTestId("chat-header-activity-dot"),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activity" }),
    ).toBeInTheDocument();
  });
});

describe("ChatHeaderMobile — accessibility", () => {
  it("gives every icon button an accessible name", () => {
    renderHeader();
    expect(
      screen.getByRole("button", { name: "Conversations" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Session settings" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Activity" }),
    ).toBeInTheDocument();
  });

  it("renders the notificationsSlot when provided", () => {
    renderHeader({ notificationsSlot: <div data-testid="bell-slot" /> });
    expect(screen.getByTestId("bell-slot")).toBeInTheDocument();
  });
});
