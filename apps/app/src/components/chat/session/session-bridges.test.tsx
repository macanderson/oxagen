// @vitest-environment jsdom
/**
 * session-bridges.test.tsx — the transitional adapters: with a session
 * provider mounted, the LEGACY interfaces (ChatSelectionStore via
 * useComposerSelectionState, ComposerModelState via useSessionModelState)
 * read and write the unified store; without one, legacy behavior is
 * untouched. This is the wiring that makes the flag-on run payload agree
 * with the SessionSettings surface by construction.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatSessionProvider, useChatSession } from "./session-store";
import { useSessionModelState } from "./session-bridges";
import { useComposerSelectionState } from "../agent-picker/chat-selection-context";
import { defaultModelState } from "../model-state";
import type { SessionSeed } from "./session-state";

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

function SelectionProbe() {
  const sel = useComposerSelectionState();
  return (
    <div>
      <output data-testid="sel">
        {JSON.stringify({
          agent: sel.selectedAgentId,
          locked: sel.selectionLocked,
        })}
      </output>
      <button onClick={() => sel.setSelectedAgentId("agt_direct")}>
        set-agent
      </button>
      <button onClick={() => sel.applyAgentSelection({ agentId: "agt_x" })}>
        apply
      </button>
      <button onClick={() => sel.applyAgentSelection({ agentId: null })}>
        apply-clear
      </button>
    </div>
  );
}

function ModelProbe() {
  const [model, setModel] = useSessionModelState(defaultModelState, null);
  return (
    <div>
      <output data-testid="model">
        {JSON.stringify({
          tier: model.tier,
          effort: model.effort,
          budgetEnabled: model.budgetEnabled,
          budgetUsd: model.budgetUsd,
        })}
      </output>
      <button onClick={() => setModel((s) => ({ ...s, effort: "high" }))}>
        set-effort
      </button>
      <button
        onClick={() =>
          setModel((s) => ({ ...s, budgetEnabled: true, budgetUsd: 2 }))
        }
      >
        set-budget
      </button>
    </div>
  );
}

function SessionEcho() {
  const session = useChatSession();
  return <output data-testid="session">{JSON.stringify(session.state)}</output>;
}

function sessionState(): Record<string, unknown> {
  return JSON.parse(
    screen.getByTestId("session").textContent ?? "{}",
  ) as Record<string, unknown>;
}

function providerWrap(children: React.ReactNode) {
  return render(
    <ChatSessionProvider
      workspaceSlug="ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation
      hasMessages={false}
      seed={SEED}
    >
      {children}
      <SessionEcho />
    </ChatSessionProvider>,
  );
}

describe("selection bridge (flag on)", () => {
  it("legacy selection writes land in the unified store", () => {
    providerWrap(<SelectionProbe />);
    fireEvent.click(screen.getByText("set-agent"));
    expect(sessionState().agentId).toBe("agt_direct");
  });

  it("applyAgentSelection maps atomically onto the store", () => {
    providerWrap(<SelectionProbe />);
    fireEvent.click(screen.getByText("apply"));
    expect(sessionState().agentId).toBe("agt_x");
    const sel = JSON.parse(screen.getByTestId("sel").textContent ?? "{}") as {
      agent: string;
    };
    expect(sel.agent).toBe("agt_x");
  });

  it("an explicit null agent clears the binding", () => {
    providerWrap(<SelectionProbe />);
    fireEvent.click(screen.getByText("apply"));
    expect(sessionState().agentId).toBe("agt_x");
    fireEvent.click(screen.getByText("apply-clear"));
    expect(sessionState().agentId).toBeNull();
  });
});

describe("selection bridge (flag off)", () => {
  it("falls back to the self-contained local store", () => {
    render(<SelectionProbe />);
    fireEvent.click(screen.getByText("set-agent"));
    const sel = JSON.parse(screen.getByTestId("sel").textContent ?? "{}") as {
      agent: string;
    };
    expect(sel.agent).toBe("agt_direct");
  });
});

describe("model bridge (flag on)", () => {
  it("effort and budget writes land in the unified store and read back", () => {
    providerWrap(<ModelProbe />);
    fireEvent.click(screen.getByText("set-effort"));
    expect(sessionState().effort).toBe("high");
    fireEvent.click(screen.getByText("set-budget"));
    expect(sessionState().budgetUsd).toBe(2);
    const model = JSON.parse(
      screen.getByTestId("model").textContent ?? "{}",
    ) as Record<string, unknown>;
    expect(model.effort).toBe("high");
    expect(model.budgetEnabled).toBe(true);
    expect(model.budgetUsd).toBe(2);
  });
});

describe("model bridge — two writes in one handler (composedRef race)", () => {
  function DoubleWriteProbe() {
    const [model, setModel] = useSessionModelState(defaultModelState, null);
    return (
      <div>
        <output data-testid="model2">
          {JSON.stringify({ effort: model.effort, budgetUsd: model.budgetUsd })}
        </output>
        <button
          onClick={() => {
            // Two functional updates in ONE handler, no re-render between
            // them. The second must see the first's result — a stale
            // composedRef would clobber the effort write with the budget
            // write's full-replacement patch.
            setModel((s) => ({ ...s, effort: "high" }));
            setModel((s) => ({ ...s, budgetEnabled: true, budgetUsd: 2 }));
          }}
        >
          double-write
        </button>
      </div>
    );
  }

  it("both synchronous writes land in the store", () => {
    providerWrap(<DoubleWriteProbe />);
    fireEvent.click(screen.getByText("double-write"));
    expect(sessionState().effort).toBe("high");
    expect(sessionState().budgetUsd).toBe(2);
    const model = JSON.parse(
      screen.getByTestId("model2").textContent ?? "{}",
    ) as Record<string, unknown>;
    expect(model.effort).toBe("high");
    expect(model.budgetUsd).toBe(2);
  });
});

describe("model bridge (flag off)", () => {
  it("behaves as plain local state", () => {
    render(<ModelProbe />);
    fireEvent.click(screen.getByText("set-effort"));
    const model = JSON.parse(
      screen.getByTestId("model").textContent ?? "{}",
    ) as Record<string, unknown>;
    expect(model.effort).toBe("high");
  });
});
