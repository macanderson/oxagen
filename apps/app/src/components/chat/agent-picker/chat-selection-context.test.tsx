// @vitest-environment jsdom
/**
 * chat-selection-context.test.tsx — the shared agent-selection store: the
 * local fallback (no provider), and the provider's initial resolution +
 * persistence. ADR-043 reduced the selection to the agent alone, so the
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
  const { selectedAgentId, applyAgentSelection } = useComposerSelectionState();
  return (
    <div>
      <span data-testid="agent">{selectedAgentId ?? "none"}</span>
      <button
        type="button"
        onClick={() => applyAgentSelection({ agentId: "agt_code" })}
      >
        apply
      </button>
      <button
        type="button"
        onClick={() => applyAgentSelection({ agentId: "agt_other" })}
      >
        apply other
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

// REGRESSION (e2e chat-agent-picker): the store has NO lock. It used to latch
// on the first send, which froze the composer chip into a disabled "Agent
// locked: <name>" button for the rest of the conversation. ADR-043 removed the
// durable code binding that latch stood in for — `agentId` is a per-turn
// parameter of /api/v1/chat/stream — so every apply must keep committing, for
// the whole conversation, in BOTH stores.
describe("useComposerSelectionState — no conversation lock", () => {
  it("keeps accepting applies after a selection is made (local fallback)", () => {
    render(<Probe />);
    fireEvent.click(screen.getByText("apply"));
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");
    fireEvent.click(screen.getByText("apply other"));
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_other");
  });

  it("keeps accepting applies — and persisting them — in the provider store", () => {
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
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_code");

    // A second apply — the "after a turn was sent" case — still commits and
    // still writes through to the per-conversation key.
    act(() => {
      fireEvent.click(screen.getByText("apply other"));
    });
    expect(screen.getByTestId("agent")).toHaveTextContent("agt_other");
    expect(window.localStorage.getItem(agentStorageKey("ws", "conv_1"))).toBe(
      "agt_other",
    );
  });
});
