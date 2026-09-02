// @vitest-environment jsdom
/**
 * chat-header-desktop.test.tsx
 *
 * ChatHeaderDesktop reads the unified session store directly (it is only
 * ever mounted once useChatSessionContext() !== null AND the viewport is
 * non-mobile — see the mount gate in chat-shell-client.tsx), so every test
 * wraps it in a real ChatSessionProvider seeded to the scenario under test,
 * following the same convention as chat-header-mobile.test.tsx.
 *
 * Covers:
 *   - agent name + full `{model} · {repo} @ {branch} · {environment}` subtitle
 *   - middle-ellipsis kicks in for a long repo segment (+ the helper directly)
 *   - omits missing segments cleanly
 *   - the whole header is a button that calls onFocusSessionPanel
 *   - the activity dot appears only while isStreaming
 */
import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatHeaderDesktop, middleEllipsis } from "./chat-header-desktop";
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

const LONG_REPOS: RepoOption[] = [
  {
    key: "con_1::acme-corp-engineering/a-very-long-repository-name",
    connectionId: "con_1",
    owner: "acme-corp-engineering",
    name: "a-very-long-repository-name",
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
  props: Partial<React.ComponentProps<typeof ChatHeaderDesktop>> = {},
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
      <ChatHeaderDesktop
        agents={[CODER]}
        repos={REPOS}
        environments={ENVIRONMENTS}
        isStreaming={false}
        onFocusSessionPanel={vi.fn()}
        {...props}
      />
    </ChatSessionProvider>,
  );
}

describe("ChatHeaderDesktop — session summary", () => {
  it("renders 'Default assistant' and the fast-tier model label with nothing else selected", () => {
    renderHeader();
    expect(screen.getByText("Default assistant")).toBeInTheDocument();
    expect(screen.getByText("Fast")).toBeInTheDocument();
  });

  it("renders the current agent's name and the full model/repo/branch/environment subtitle", () => {
    renderHeader(
      { agents: [CODER] },
      {
        ...BASE_SEED,
        defaultAgentId: "agt_code",
        defaultRepoKey: "con_1::acme/platform",
        defaultEnvId: "env_1",
      },
    );
    expect(screen.getByText("Coder")).toBeInTheDocument();
    // No explicit branch chosen — sessionSubtitleParts falls back to the
    // repo's default branch ("main"); repo segment isn't long enough to ellipsize.
    expect(
      screen.getByText("Fast · acme/platform @ main · Node 22"),
    ).toBeInTheDocument();
  });

  it("omits missing segments (no repo, no environment) cleanly", () => {
    renderHeader({}, { ...BASE_SEED, defaultAgentId: "agt_code" });
    expect(screen.getByText("Fast")).toBeInTheDocument();
  });

  it("uses modelLabelOf to prettify an explicit gateway model id", () => {
    renderHeader(
      {},
      { ...BASE_SEED, textModel: "anthropic/claude-sonnet-5", textTier: null },
    );
    expect(screen.getByText("Claude Sonnet 5")).toBeInTheDocument();
  });

  it("middle-ellipsizes a long repo segment, keeping the branch alongside it", () => {
    renderHeader(
      { repos: LONG_REPOS },
      {
        ...BASE_SEED,
        defaultRepoKey:
          "con_1::acme-corp-engineering/a-very-long-repository-name",
      },
    );
    // "acme-corp-engineering/a-very-long-repository-name" (51 chars) > 24 →
    // first 12 + … + last 8, per middleEllipsis's own defaults.
    const full = "acme-corp-engineering/a-very-long-repository-name";
    const ellipsized = middleEllipsis(full);
    expect(screen.getByText(`Fast · ${ellipsized} @ main`)).toBeInTheDocument();
    expect(screen.queryByText(`Fast · ${full} @ main`)).not.toBeInTheDocument();
  });
});

describe("middleEllipsis", () => {
  it("returns the value unchanged when at or under the max length", () => {
    expect(middleEllipsis("acme/platform")).toBe("acme/platform");
    expect(middleEllipsis("a".repeat(24))).toBe("a".repeat(24));
  });

  it("keeps the first 12 and last 8 characters, joined by an ellipsis, once over 24 chars", () => {
    const value = "acme-corp-engineering/a-very-long-repository-name";
    const result = middleEllipsis(value);
    expect(result).toBe(
      `${value.slice(0, 12)}…${value.slice(value.length - 8)}`,
    );
    expect(result.length).toBeLessThan(value.length);
  });

  it("respects custom head/tail lengths", () => {
    expect(middleEllipsis("0123456789abcdefghij", 10, 3, 3)).toBe("012…hij");
  });
});

describe("ChatHeaderDesktop — interactions", () => {
  it("is a single button covering the whole header that calls onFocusSessionPanel when clicked", () => {
    const onFocusSessionPanel = vi.fn();
    renderHeader({ onFocusSessionPanel });
    const button = screen.getByRole("button", { name: "Session settings" });
    expect(button).toBeInTheDocument();
    fireEvent.click(button);
    expect(onFocusSessionPanel).toHaveBeenCalledTimes(1);
  });
});

describe("ChatHeaderDesktop — activity status dot", () => {
  it("shows the pulsing status dot while streaming", () => {
    renderHeader({ isStreaming: true });
    expect(
      screen.getByTestId("chat-header-desktop-activity-dot"),
    ).toBeInTheDocument();
  });

  it("omits the status dot when not streaming", () => {
    renderHeader({ isStreaming: false });
    expect(
      screen.queryByTestId("chat-header-desktop-activity-dot"),
    ).not.toBeInTheDocument();
  });
});
