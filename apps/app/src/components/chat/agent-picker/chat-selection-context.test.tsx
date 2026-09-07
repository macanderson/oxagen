// @vitest-environment jsdom
/**
 * chat-selection-context.test.tsx — the shared agent-selection store: the
 * local fallback (no provider), and the provider's initial resolution +
 * persistence. ADR-041 reduced the selection to the agent alone, so the
 * repo/branch/environment half of these tests went with the runtime.
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
  agentType: "custom",
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};

function Probe() {
  const {
    selectedAgentId,
    selectionLocked,
    applyAgentSelection,
    lockSelection,
  } = useComposerSelectionState();
  return (
    <div>
      <span data-testid="agent">{selectedAgentId ?? "none"}</span>
      <span data-testid="locked">{selectionLocked ? "yes" : "no"}</span>
      <button
        type="button"
        onClick={() => applyAgentSelection({ agentId: "agt_code" })}
      >
        apply
      </button>
      <button type="button" onClick={() => lockSelection()}>
        lock
      </button>
    </div>
  );
}

describe("useComposerSelectionState — local fallback (no provider)", () => {
  it("starts empty and applies a selection", () => {
    render(<Probe />);
    expect(screen.getByTestId("agent")).toHaveTextContent("none");
    fireEvent.click(screen.getByText("apply"));
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
  });
});

describe("ChatSelectionProvider — initial resolution", () => {
  it("seeds the selection from the URL binding", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId="agt_code"
        workspaceDefaultAgentId={null}
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
        conversationId={null}
        workspaceSlug="ws"
        isNewConversation
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
  });

  it("hydrates the per-conversation persisted selection over the workspace default", () => {
    writeStoredAgentId(agentStorageKey("ws", "conv_1"), "agt_persisted");
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId={null}
        workspaceDefaultAgentId="agt_code"
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

describe("useComposerSelectionState — client-side lock", () => {
  it("lockSelection() flips selectionLocked and freezes further edits (local fallback)", () => {
    render(<Probe />);
    expect(screen.getByTestId("locked")).toHaveTextContent("no");

    act(() => {
      fireEvent.click(screen.getByText("lock"));
    });
    expect(screen.getByTestId("locked")).toHaveTextContent("yes");

    // An apply after locking is rejected — the selection never leaves its
    // initial empty state.
    act(() => {
      fireEvent.click(screen.getByText("apply"));
    });
    expect(screen.getByTestId("agent")).toHaveTextContent("none");
  });

  it("the provider store rejects an apply once locked", () => {
    render(
      <ChatSelectionProvider
        agents={[CODER]}
        boundAgentId={null}
        workspaceDefaultAgentId={null}
        conversationId="conv_1"
        workspaceSlug="ws"
        isNewConversation={false}
      >
        <Probe />
      </ChatSelectionProvider>,
    );
    act(() => {
      fireEvent.click(screen.getByText("lock"));
    });
    act(() => {
      fireEvent.click(screen.getByText("apply"));
    });
    expect(screen.getByTestId("agent")).toHaveTextContent("none");
    expect(screen.getByTestId("locked")).toHaveTextContent("yes");
  });
});
