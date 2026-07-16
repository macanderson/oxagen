// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import {
  AgentActivityRail,
  resolveContextRepo,
  type AgentActivityRailProps,
} from "./agent-activity-rail";
import type { LiveToolCall } from "./use-tool-stream";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";
import type { ChatSelectionStore } from "./agent-picker/chat-selection-context";

// The rail composes three fetch-driven children; stub them so the test
// exercises the rail's own structure/logic without network or timers.
vi.mock("./workspace-context-panel", () => ({
  WorkspaceContextTabs: () => <div data-testid="ws-tabs" />,
}));
vi.mock("./composer-pr-status-chip", () => ({
  ComposerPrStatusChip: () => <div data-testid="pr-chip" />,
}));

// Controllable selection store — the Context card reads repo/env selection here.
let mockSelection: ChatSelectionStore | null = null;
vi.mock("./agent-picker/chat-selection-context", () => ({
  useChatSelectionContext: () => mockSelection,
}));

function makeSelection(over: Partial<ChatSelectionStore> = {}): ChatSelectionStore {
  return {
    selectedAgentId: null,
    selectedRepoKey: null,
    selectedBranch: null,
    selectedEnvId: null,
    selectionLocked: false,
    setSelectedAgentId: () => {},
    setSelectedRepoKey: () => {},
    setSelectedEnvId: () => {},
    applyAgentSelection: () => {},
    lockSelection: () => {},
    ...over,
  };
}

function tc(over: Partial<LiveToolCall> & Pick<LiveToolCall, "toolCallId" | "capability">): LiveToolCall {
  return {
    messageId: "m1",
    inputPreview: null,
    riskLevel: "low",
    status: "completed",
    stdout: "",
    stderr: "",
    startedAt: 0,
    ...over,
  };
}

function baseProps(over: Partial<AgentActivityRailProps> = {}): AgentActivityRailProps {
  return {
    order: [],
    plans: {},
    toolCalls: {},
    activeFanouts: {},
    turnUsage: undefined,
    isStreaming: false,
    conversationPublicId: "conv_1",
    orgSlug: "acme",
    workspaceSlug: "eng",
    codeSessionPr: null,
    availableRepos: [],
    availableEnvironments: [],
    conversationCodeBinding: null,
    ...over,
  };
}

const BINDING: StoredCodeBinding = {
  version: 1,
  agentId: "agt_code",
  connectionId: "con_1",
  owner: "oxagen",
  name: "platform",
  defaultBranch: "main",
  environmentId: "env_1",
  environmentName: "Node 24",
};

beforeEach(() => {
  mockSelection = makeSelection();
});

afterEach(() => {
  cleanup();
});

describe("AgentActivityRail", () => {
  it("renders the three cards (Progress / Context / Outputs)", () => {
    render(<AgentActivityRail {...baseProps()} />);
    expect(document.querySelector('[data-card="progress"]')).toBeInTheDocument();
    expect(document.querySelector('[data-card="context"]')).toBeInTheDocument();
    expect(document.querySelector('[data-card="outputs"]')).toBeInTheDocument();
    // Outputs always mounts the tabs (files surface).
    expect(screen.getByTestId("ws-tabs")).toBeInTheDocument();
  });

  it("shows ambient empty states when idle and unbound", () => {
    render(<AgentActivityRail {...baseProps()} />);
    expect(screen.getByTestId("progress-empty")).toBeInTheDocument();
    expect(screen.getByTestId("context-empty")).toBeInTheDocument();
    expect(
      screen.getByText("Not connected to a repository"),
    ).toBeInTheDocument();
  });

  it("renders repo/branch/env from a durable code binding, locked", () => {
    render(
      <AgentActivityRail {...baseProps({ conversationCodeBinding: BINDING })} />,
    );
    const grounded = screen.getByTestId("context-grounded");
    expect(grounded).toBeInTheDocument();
    expect(screen.getByText("oxagen/platform")).toBeInTheDocument();
    expect(screen.getByText("main")).toBeInTheDocument();
    expect(screen.getByText("Node 24")).toBeInTheDocument();
    // A binding locks the conversation → lock affordance present.
    expect(screen.getByLabelText("Locked to this conversation")).toBeInTheDocument();
  });

  it("resolves the selected repo (no binding) from availableRepos, unlocked", () => {
    mockSelection = makeSelection({ selectedRepoKey: "con_9::acme/webapp" });
    render(
      <AgentActivityRail
        {...baseProps({
          availableRepos: [
            {
              key: "con_9::acme/webapp",
              connectionId: "con_9",
              owner: "acme",
              name: "webapp",
              defaultBranch: "trunk",
            },
          ],
        })}
      />,
    );
    expect(screen.getByText("acme/webapp")).toBeInTheDocument();
    expect(screen.getByText("trunk")).toBeInTheDocument();
    expect(
      screen.queryByLabelText("Locked to this conversation"),
    ).not.toBeInTheDocument();
  });

  it("shows the PR chip in Context when a PR is open this turn", () => {
    render(
      <AgentActivityRail
        {...baseProps({
          conversationCodeBinding: BINDING,
          codeSessionPr: {
            owner: "oxagen",
            name: "platform",
            number: 42,
            url: "https://github.com/oxagen/platform/pull/42",
            headRef: "feat/x",
          },
        })}
      />,
    );
    expect(screen.getByTestId("pr-chip")).toBeInTheDocument();
    // The PR head ref wins over the binding's default branch for the branch row.
    expect(screen.getByText("feat/x")).toBeInTheDocument();
  });

  it("counts distinct tool capabilities used this turn", () => {
    render(
      <AgentActivityRail
        {...baseProps({
          conversationCodeBinding: BINDING,
          toolCalls: {
            a: tc({ toolCallId: "a", capability: "read_file" }),
            b: tc({ toolCallId: "b", capability: "read_file" }),
            c: tc({ toolCallId: "c", capability: "edit_repo_file" }),
          },
        })}
      />,
    );
    // read_file + edit_repo_file → 2 distinct capabilities.
    expect(screen.getByText("2 used this turn")).toBeInTheDocument();
  });

  it("shows a live status line and trace stages while streaming", () => {
    render(
      <AgentActivityRail
        {...baseProps({
          isStreaming: true,
          order: ["tool:a"],
          toolCalls: { a: tc({ toolCallId: "a", capability: "read_file", status: "running" }) },
        })}
      />,
    );
    const status = screen.getByTestId("progress-status-line");
    expect(status).toHaveTextContent("Working");
    expect(status).toHaveTextContent("1 tool");
    // The trace stages (from CodingTraceStages) render the tool bucket.
    expect(screen.getByText("Tool calls")).toBeInTheDocument();
    expect(screen.queryByTestId("progress-empty")).not.toBeInTheDocument();
  });

  it('reads "Turn complete" once usage lands', () => {
    render(
      <AgentActivityRail
        {...baseProps({
          isStreaming: false,
          order: ["tool:a"],
          toolCalls: { a: tc({ toolCallId: "a", capability: "read_file" }) },
          turnUsage: {
            promptTokens: 10,
            completionTokens: 5,
            totalTokens: 15,
          },
        })}
      />,
    );
    expect(screen.getByTestId("progress-status-line")).toHaveTextContent(
      "Turn complete",
    );
  });
});

describe("AgentActivityRail — chat_ux_v2 desktop rail (v2)", () => {
  it("renders sessionPanelSlot and NO Context card", () => {
    render(
      <AgentActivityRail
        {...baseProps({
          v2: true,
          sessionPanelSlot: <div data-testid="session-panel-slot" />,
        })}
      />,
    );
    expect(screen.getByTestId("session-panel-slot")).toBeInTheDocument();
    expect(document.querySelector('[data-card="context"]')).not.toBeInTheDocument();
    expect(document.querySelector('[data-card="progress"]')).toBeInTheDocument();
    expect(document.querySelector('[data-card="outputs"]')).toBeInTheDocument();
  });

  it("Progress renders as a single collapsed 'Progress · idle' row with no body when idle", () => {
    render(<AgentActivityRail {...baseProps({ v2: true })} />);
    expect(screen.getByText("Progress · idle")).toBeInTheDocument();
    expect(screen.queryByTestId("progress-empty")).not.toBeInTheDocument();
    const header = screen.getByRole("button", { name: "Progress · idle" });
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it("Progress auto-expands once isStreaming flips true", () => {
    const { rerender } = render(
      <AgentActivityRail {...baseProps({ v2: true, isStreaming: false })} />,
    );
    expect(screen.getByText("Progress · idle")).toBeInTheDocument();
    rerender(
      <AgentActivityRail
        {...baseProps({
          v2: true,
          isStreaming: true,
          order: ["tool:a"],
          toolCalls: { a: tc({ toolCallId: "a", capability: "read_file", status: "running" }) },
        })}
      />,
    );
    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(screen.queryByText("Progress · idle")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /^Progress/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("progress-status-line")).toHaveTextContent("Working");
  });

  it("Progress auto-expands once the first row appears (even without isStreaming)", () => {
    const { rerender } = render(
      <AgentActivityRail {...baseProps({ v2: true, isStreaming: false })} />,
    );
    rerender(
      <AgentActivityRail
        {...baseProps({
          v2: true,
          isStreaming: false,
          order: ["tool:a"],
          toolCalls: { a: tc({ toolCallId: "a", capability: "read_file" }) },
        })}
      />,
    );
    expect(
      screen.getByRole("button", { name: /^Progress/ }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("Files reads 'Files · 0' collapsed when there's no file tool activity yet", () => {
    render(<AgentActivityRail {...baseProps({ v2: true })} />);
    expect(screen.getByText("Files · 0")).toBeInTheDocument();
    const header = screen.getByRole("button", { name: "Files · 0" });
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("ws-tabs")).not.toBeInTheDocument();
  });

  it("Files auto-expands (and drops the count) once a file-producing tool call appears", () => {
    const { rerender } = render(<AgentActivityRail {...baseProps({ v2: true })} />);
    expect(screen.getByText("Files · 0")).toBeInTheDocument();
    rerender(
      <AgentActivityRail
        {...baseProps({
          v2: true,
          toolCalls: { a: tc({ toolCallId: "a", capability: "edit_repo_file" }) },
        })}
      />,
    );
    expect(screen.getByText("Files")).toBeInTheDocument();
    expect(screen.queryByText("Files · 0")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Files" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("ws-tabs")).toBeInTheDocument();
  });

  it("legacy (v2 false/omitted) still reads 'Outputs', open by default, no idle collapse", () => {
    render(<AgentActivityRail {...baseProps()} />);
    expect(screen.getByText("Outputs")).toBeInTheDocument();
    expect(screen.getByText("Progress")).toBeInTheDocument();
    expect(screen.queryByText("Progress · idle")).not.toBeInTheDocument();
    expect(screen.queryByText("Files · 0")).not.toBeInTheDocument();
  });

  it("never renders the redundant helper captions (ux pass 2026-07-16: card bodies self-explain in both modes)", () => {
    const { rerender } = render(<AgentActivityRail {...baseProps()} />);
    expect(
      screen.queryByText("Steps appear here as the agent works through a longer task."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Files the assistant generates or edits in this conversation show up here."),
    ).not.toBeInTheDocument();

    rerender(
      <AgentActivityRail
        {...baseProps({
          v2: true,
          isStreaming: true,
          order: ["tool:a"],
          toolCalls: { a: tc({ toolCallId: "a", capability: "edit_repo_file" }) },
        })}
      />,
    );
    expect(
      screen.queryByText("Steps appear here as the agent works through a longer task."),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Files the assistant generates or edits in this conversation show up here."),
    ).not.toBeInTheDocument();
  });

  it("manual toggle wins over auto-expand for the rest of the session", () => {
    const { rerender } = render(<AgentActivityRail {...baseProps({ v2: true })} />);
    // User manually opens the idle Progress card before anything happens.
    fireEvent.click(screen.getByRole("button", { name: "Progress · idle" }));
    expect(screen.getByRole("button", { name: "Progress · idle" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    // User then manually collapses it again.
    fireEvent.click(screen.getByRole("button", { name: "Progress · idle" }));
    expect(screen.getByRole("button", { name: "Progress · idle" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    // Streaming starts — auto-expand must NOT override the user's explicit choice.
    rerender(<AgentActivityRail {...baseProps({ v2: true, isStreaming: true })} />);
    expect(
      screen.getByRole("button", { name: /^Progress/ }),
    ).toHaveAttribute("aria-expanded", "false");
  });
});

describe("resolveContextRepo", () => {
  it("prefers the durable binding over the picker selection", () => {
    expect(
      resolveContextRepo({
        binding: BINDING,
        selectedRepoKey: "con_9::acme/webapp",
        availableRepos: [
          { key: "con_9::acme/webapp", connectionId: "con_9", owner: "acme", name: "webapp", defaultBranch: "trunk" },
        ],
      }),
    ).toEqual({ owner: "oxagen", name: "platform", branch: "main" });
  });

  it("falls back to the selected repo when unbound", () => {
    expect(
      resolveContextRepo({
        binding: null,
        selectedRepoKey: "con_9::acme/webapp",
        availableRepos: [
          { key: "con_9::acme/webapp", connectionId: "con_9", owner: "acme", name: "webapp", defaultBranch: "trunk" },
        ],
      }),
    ).toEqual({ owner: "acme", name: "webapp", branch: "trunk" });
  });

  it("returns null when nothing is selected or bound", () => {
    expect(
      resolveContextRepo({ binding: null, selectedRepoKey: null, availableRepos: [] }),
    ).toBeNull();
  });

  it("returns null when the selected key matches no available repo", () => {
    expect(
      resolveContextRepo({
        binding: null,
        selectedRepoKey: "con_x::ghost/repo",
        availableRepos: [],
      }),
    ).toBeNull();
  });
});
