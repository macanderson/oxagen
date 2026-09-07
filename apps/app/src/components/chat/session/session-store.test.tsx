// @vitest-environment jsdom
/**
 * session-store.test.tsx — the unified session provider: seeding, the single
 * write path (locks), and persistence (draft carry, per-conversation keys).
 *
 * ADR-041 removed the code half of the session (repo / branch / sandbox
 * environment, per-agent code memory, the durable code binding), so what is
 * left to prove is the governance-relevant contract: the agent binding, the
 * model/tier/effort/budget settings, the agent lock (derived from server truth
 * — `hasMessages` — not a client-side latch), and that persistence never leaks
 * one conversation's session onto another key.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatSessionProvider, useChatSession } from "./session-store";
import { sessionStorageKey, type SessionSeed } from "./session-state";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SEED: SessionSeed = {
  defaultAgentId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

/** Probe that exposes the store as DOM for assertions and buttons for writes. */
function Probe() {
  const store = useChatSession();
  return (
    <div>
      <output data-testid="state">{JSON.stringify(store.state)}</output>
      <output data-testid="locks">{JSON.stringify(store.locks)}</output>
      <output data-testid="dirty">{String(store.isDirty)}</output>
      <button onClick={() => store.updateSession({ agentId: "agt_pick" })}>
        pick-agent
      </button>
      <button onClick={() => store.updateSession({ effort: "high" })}>
        raise-effort
      </button>
      <button onClick={() => store.updateSession({ budgetUsd: 2 })}>
        set-budget
      </button>
      <button
        onClick={() =>
          store.updateSession({ model: "anthropic/claude-sonnet-5" })
        }
      >
        pick-model
      </button>
      <button onClick={() => store.resetToDefaults()}>reset</button>
    </div>
  );
}

function stateOf(): Record<string, unknown> {
  return JSON.parse(screen.getByTestId("state").textContent ?? "{}") as Record<
    string,
    unknown
  >;
}

function renderProvider(
  props: Partial<React.ComponentProps<typeof ChatSessionProvider>> = {},
) {
  return render(
    <ChatSessionProvider
      workspaceSlug="ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation
      hasMessages={false}
      seed={SEED}
      {...props}
    >
      <Probe />
    </ChatSessionProvider>,
  );
}

describe("ChatSessionProvider", () => {
  it("seeds a new chat from workspace defaults", () => {
    renderProvider();
    const s = stateOf();
    expect(s.agentId).toBeNull();
    expect(s.tier).toBe("fast");
    expect(s.model).toBeNull();
    expect(s.effort).toBe("medium");
    expect(s.budgetUsd).toBeNull();
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("applies the URL agent binding for a new chat", () => {
    renderProvider({ boundAgentId: "agt_url" });
    expect(stateOf().agentId).toBe("agt_url");
  });

  it("updateSession enforces model/tier exclusivity and persists", () => {
    renderProvider();
    fireEvent.click(screen.getByText("pick-model"));
    const s = stateOf();
    expect(s.model).toBe("anthropic/claude-sonnet-5");
    expect(s.tier).toBeNull();
    const persisted = window.localStorage.getItem(
      sessionStorageKey("ws", null),
    );
    expect(persisted).toContain('"model":"anthropic/claude-sonnet-5"');
  });

  it("marks dirty when a setting differs from defaults, clean after reset", () => {
    renderProvider();
    fireEvent.click(screen.getByText("raise-effort"));
    expect(screen.getByTestId("dirty").textContent).toBe("true");
    fireEvent.click(screen.getByText("reset"));
    expect(screen.getByTestId("dirty").textContent).toBe("false");
    expect(stateOf().effort).toBe("medium");
  });

  it("hydrates the persisted session for an existing conversation", () => {
    window.localStorage.setItem(
      sessionStorageKey("ws", "cnv_1"),
      JSON.stringify({
        v: 1,
        agentId: "agt_saved",
        tier: null,
        model: "anthropic/claude-sonnet-5",
        effort: "high",
        budgetUsd: 2,
      }),
    );
    renderProvider({ conversationId: "cnv_1", isNewConversation: false });
    const s = stateOf();
    expect(s.agentId).toBe("agt_saved");
    expect(s.effort).toBe("high");
    expect(s.budgetUsd).toBe(2);
  });

  // The draft session survives the first send: chat-shell-client pins the URL
  // to `?c=<publicId>` once the conversation row exists, the RSC re-renders with
  // a conversationId, and the hydration effect carries the draft onto the real
  // key. This is now the ONLY migration path — the send-time hook that
  // duplicated it was removed with the client-side agent latch.
  it("carries the draft session onto the conversation key when the id arrives", () => {
    const { rerender } = renderProvider();
    fireEvent.click(screen.getByText("pick-agent"));
    fireEvent.click(screen.getByText("set-budget"));
    expect(
      window.localStorage.getItem(sessionStorageKey("ws", null)),
    ).toContain('"budgetUsd":2');

    rerender(
      <ChatSessionProvider
        workspaceSlug="ws"
        conversationId="cnv_new"
        boundAgentId={null}
        isNewConversation={false}
        hasMessages
        seed={SEED}
      >
        <Probe />
      </ChatSessionProvider>,
    );

    expect(
      window.localStorage.getItem(sessionStorageKey("ws", null)),
    ).toBeNull();
    expect(
      window.localStorage.getItem(sessionStorageKey("ws", "cnv_new")),
    ).toContain('"budgetUsd":2');
    expect(stateOf().agentId).toBe("agt_pick");
    expect(stateOf().budgetUsd).toBe(2);
  });

  // The lock is derived from server truth alone, so a send that FAILS before a
  // message exists leaves the agent editable — the old client-side latch was
  // one-way and stranded the picker after a failed turn.
  it("a new chat with no messages keeps the agent unlocked", () => {
    renderProvider();
    expect(JSON.parse(screen.getByTestId("locks").textContent ?? "{}")).toEqual(
      { agent: false },
    );
    fireEvent.click(screen.getByText("pick-agent"));
    expect(stateOf().agentId).toBe("agt_pick");
  });

  it("an existing conversation with messages locks the agent up front", () => {
    renderProvider({
      conversationId: "cnv_live",
      isNewConversation: false,
      hasMessages: true,
    });
    expect(JSON.parse(screen.getByTestId("locks").textContent ?? "{}")).toEqual(
      { agent: true },
    );
    fireEvent.click(screen.getByText("pick-agent"));
    expect(stateOf().agentId).toBeNull();
    // Non-agent settings stay editable on a live conversation.
    fireEvent.click(screen.getByText("raise-effort"));
    expect(stateOf().effort).toBe("high");
  });

  it("degrades to in-memory state when localStorage throws (private mode)", () => {
    const getSpy = vi
      .spyOn(Storage.prototype, "getItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    const setSpy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("storage disabled");
      });
    try {
      renderProvider();
      // Writes still update in-memory state without crashing…
      fireEvent.click(screen.getByText("raise-effort"));
      expect(stateOf().effort).toBe("high");
      // …and an agent pick still lands in memory when the write-through throws.
      fireEvent.click(screen.getByText("pick-agent"));
      expect(stateOf().agentId).toBe("agt_pick");
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });
});
