// @vitest-environment jsdom
/**
 * session-store.test.tsx — the unified session provider: seeding, the single
 * write path (cascades + locks), persistence (draft carry, per-conversation
 * keys, agent memory), and the binding force that makes header-vs-run
 * mismatches impossible.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { ChatSessionProvider, useChatSession } from "./session-store";
import {
  agentMemoryKey,
  encodeCodeMemory,
  sessionStorageKey,
  type SessionSeed,
} from "./session-state";
import type { StoredCodeBinding } from "@/app/api/v1/chat/stream/code-binding";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: "con_1::acme/platform",
  defaultEnvId: "env_1",
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

const BINDING: StoredCodeBinding = {
  version: 1,
  agentId: "agt_code",
  connectionId: "con_1",
  owner: "acme",
  name: "platform",
  defaultBranch: "main",
  environmentId: "env_1",
  environmentName: "Node 22",
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
      <button
        onClick={() => store.updateSession({ repoKey: "con_1::acme/site" })}
      >
        pick-repo
      </button>
      <button onClick={() => store.updateSession({ branch: "feat/x" })}>
        pick-branch
      </button>
      <button onClick={() => store.updateSession({ effort: "high" })}>
        raise-effort
      </button>
      <button onClick={() => store.updateSession({ org: "umbrella" })}>
        pick-org
      </button>
      <button onClick={() => store.resetToDefaults()}>reset</button>
      <button onClick={() => store.noteMessageSent("cnv_new")}>send</button>
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
    expect(s.repoKey).toBe("con_1::acme/platform");
    expect(s.org).toBe("acme");
    expect(s.envId).toBe("env_1");
    expect(screen.getByTestId("dirty").textContent).toBe("false");
  });

  it("applies the URL agent binding for a new chat", () => {
    renderProvider({ boundAgentId: "agt_url" });
    expect(stateOf().agentId).toBe("agt_url");
  });

  it("updateSession cascades org → repo → branch and persists", () => {
    renderProvider();
    fireEvent.click(screen.getByText("pick-branch"));
    expect(stateOf().branch).toBe("feat/x");
    fireEvent.click(screen.getByText("pick-org"));
    const s = stateOf();
    expect(s.org).toBe("umbrella");
    expect(s.repoKey).toBeNull();
    expect(s.branch).toBeNull();
    const persisted = window.localStorage.getItem(
      sessionStorageKey("ws", null),
    );
    expect(persisted).toContain('"org":"umbrella"');
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
        org: "acme",
        repoKey: "con_1::acme/site",
        branch: "development",
        envId: "env_2",
        outputs: { image: false, video: false },
      }),
    );
    renderProvider({ conversationId: "cnv_1", isNewConversation: false });
    const s = stateOf();
    expect(s.agentId).toBe("agt_saved");
    expect(s.branch).toBe("development");
    expect(s.budgetUsd).toBe(2);
  });

  it("noteMessageSent locks the agent, migrates the draft, and records agent memory", () => {
    renderProvider();
    fireEvent.click(screen.getByText("pick-agent"));
    fireEvent.click(screen.getByText("pick-branch"));
    fireEvent.click(screen.getByText("send"));
    // Agent locked → further agent changes rejected.
    expect(JSON.parse(screen.getByTestId("locks").textContent ?? "{}")).toEqual(
      {
        agent: true,
        code: true,
      },
    );
    // Draft migrated onto the conversation key.
    expect(
      window.localStorage.getItem(sessionStorageKey("ws", null)),
    ).toBeNull();
    expect(
      window.localStorage.getItem(sessionStorageKey("ws", "cnv_new")),
    ).toContain('"branch":"feat/x"');
    // Agent memory recorded for next time.
    expect(
      window.localStorage.getItem(agentMemoryKey("ws", "agt_pick")),
    ).toContain('"branch":"feat/x"');
  });

  it("picking an agent overlays its remembered code context", () => {
    window.localStorage.setItem(
      agentMemoryKey("ws", "agt_pick"),
      encodeCodeMemory({
        org: "umbrella",
        repoKey: "con_2::umbrella/labs",
        branch: "release",
        envId: "env_2",
      }),
    );
    renderProvider();
    fireEvent.click(screen.getByText("pick-agent"));
    const s = stateOf();
    expect(s.repoKey).toBe("con_2::umbrella/labs");
    expect(s.branch).toBe("release");
    expect(s.envId).toBe("env_2");
  });

  it("a durable code binding forces agent/repo/env and locks them", () => {
    renderProvider({
      conversationId: "cnv_bound",
      isNewConversation: false,
      hasMessages: true,
      codeBinding: BINDING,
    });
    const s = stateOf();
    expect(s.agentId).toBe("agt_code");
    expect(s.repoKey).toBe("con_1::acme/platform");
    expect(s.envId).toBe("env_1");
    // Locked writes are rejected.
    fireEvent.click(screen.getByText("pick-agent"));
    fireEvent.click(screen.getByText("pick-repo"));
    expect(stateOf().agentId).toBe("agt_code");
    expect(stateOf().repoKey).toBe("con_1::acme/platform");
    // Branch stays editable on a bound conversation.
    fireEvent.click(screen.getByText("pick-branch"));
    expect(stateOf().branch).toBe("feat/x");
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
      fireEvent.click(screen.getByText("pick-branch"));
      expect(stateOf().branch).toBe("feat/x");
      // …and the send-time bookkeeping (agent memory + draft migration,
      // both storage-backed) survives too.
      fireEvent.click(screen.getByText("pick-agent"));
      fireEvent.click(screen.getByText("send"));
      expect(
        JSON.parse(screen.getByTestId("locks").textContent ?? "{}"),
      ).toEqual({ agent: true, code: true });
    } finally {
      getSpy.mockRestore();
      setSpy.mockRestore();
    }
  });

  it("a persisted stale selection can never shadow the binding — the mismatch regression", () => {
    // The old bug: localStorage said acme/site@development while the durable
    // binding said acme/platform. The store must resolve to the binding.
    window.localStorage.setItem(
      sessionStorageKey("ws", "cnv_bound"),
      JSON.stringify({
        v: 1,
        agentId: "agt_other",
        tier: "fast",
        model: null,
        effort: "medium",
        budgetUsd: null,
        org: "acme",
        repoKey: "con_1::acme/site",
        branch: "development",
        envId: "env_2",
        outputs: { image: false, video: false },
      }),
    );
    renderProvider({
      conversationId: "cnv_bound",
      isNewConversation: false,
      hasMessages: true,
      codeBinding: BINDING,
    });
    const s = stateOf();
    expect(s.agentId).toBe("agt_code");
    expect(s.repoKey).toBe("con_1::acme/platform");
    expect(s.org).toBe("acme");
    expect(s.envId).toBe("env_1");
    // Branch resets to the bound repo's default rather than keeping the
    // stale repo's branch.
    expect(s.branch).toBeNull();
  });
});
