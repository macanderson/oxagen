// @vitest-environment jsdom
/**
 * chat-selection-context.test.tsx — the shared selection store: the local
 * fallback (no provider), and the provider's initial resolution + persistence.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import {
  ChatSelectionProvider,
  useComposerSelectionState,
} from "./chat-selection-context";
import { agentStorageKey, writeStoredAgentId } from "./agent-context";
import type { AgentOption } from "./agent-picker-types";

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

function Probe() {
  const {
    selectedAgentId,
    selectedRepoKey,
    selectedEnvId,
    applyAgentSelection,
  } = useComposerSelectionState();
  return (
    <div>
      <span data-testid="agent">{selectedAgentId ?? "none"}</span>
      <span data-testid="repo">{selectedRepoKey ?? "none"}</span>
      <span data-testid="env">{selectedEnvId ?? "none"}</span>
      <button
        type="button"
        onClick={() =>
          applyAgentSelection({
            agentId: "agt_code",
            repoKey: "r1",
            envId: "e1",
          })
        }
      >
        apply
      </button>
    </div>
  );
}

describe("useComposerSelectionState — local fallback (no provider)", () => {
  it("starts empty and applies an atomic selection", () => {
    render(<Probe />);
    expect(screen.getByTestId("agent")).toHaveTextContent("none");
    fireEvent.click(screen.getByText("apply"));
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
    expect(screen.getByTestId("repo")).toHaveTextContent("r1");
    expect(screen.getByTestId("env")).toHaveTextContent("e1");
  });
});

describe("ChatSelectionProvider — initial resolution", () => {
  it("seeds the selection from the URL binding", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId="agt_code"
        workspaceDefaultAgentId={null}
        defaultRepoKey={null}
        defaultEnvId={null}
        conversationId={null}
        workspaceSlug="ws"
        isNewConversation
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
  });

  it("seeds a new conversation from the workspace default", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId={null}
        workspaceDefaultAgentId="agt_code"
        defaultRepoKey={null}
        defaultEnvId={null}
        conversationId={null}
        workspaceSlug="ws"
        isNewConversation
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
  });

  it("prefills repo + env for a code-agent default", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId="agt_code"
        workspaceDefaultAgentId={null}
        defaultRepoKey="con_1::acme/api"
        defaultEnvId="env_dev"
        conversationId="conv_1"
        workspaceSlug="ws"
        isNewConversation={false}
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    expect(screen.getByTestId("repo")).toHaveTextContent("con_1::acme/api");
    expect(screen.getByTestId("env")).toHaveTextContent("env_dev");
  });

  it("hydrates the per-conversation persisted selection over the workspace default", () => {
    writeStoredAgentId(agentStorageKey("ws", "conv_1"), "agt_persisted");
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId={null}
        workspaceDefaultAgentId="agt_code"
        defaultRepoKey={null}
        defaultEnvId={null}
        conversationId="conv_1"
        workspaceSlug="ws"
        isNewConversation={false}
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_persisted");
  });

  it("persists a newly applied selection to localStorage", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId={null}
        workspaceDefaultAgentId={null}
        defaultRepoKey={null}
        defaultEnvId={null}
        conversationId="conv_1"
        workspaceSlug="ws"
        isNewConversation={false}
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText("apply"));
    });
    expect(window.localStorage.getItem(agentStorageKey("ws", "conv_1"))).toBe(
      "agt_code",
    );
  });
});
