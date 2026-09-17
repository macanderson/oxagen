// @vitest-environment jsdom
/**
 * use-agent-panel-store.test.tsx — tests for the agent panel store.
 *
 * Exercises the real AgentPanelStoreProvider/useAgentPanelStore context: the
 * default state, every action's state transition, and the guard that throws
 * when the hook is used outside the provider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import type { ReactNode } from "react";
import {
  AgentPanelStoreProvider,
  useAgentPanelStore,
} from "./use-agent-panel-store";

afterEach(cleanup);

function wrapper({ children }: { children: ReactNode }) {
  return <AgentPanelStoreProvider>{children}</AgentPanelStoreProvider>;
}

function renderStore() {
  return renderHook(() => useAgentPanelStore(), { wrapper });
}

describe("useAgentPanelStore — provider guard", () => {
  it("throws when used outside AgentPanelStoreProvider", () => {
    // React logs the render error; silence it so the suite output stays clean.
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useAgentPanelStore())).toThrow(
      /must be used inside AgentPanelStoreProvider/,
    );
    spy.mockRestore();
  });
});

describe("useAgentPanelStore — default state", () => {
  it("defaults to closed / standard / idle / no title", () => {
    const { result } = renderStore();
    expect(result.current.visibility).toBe("closed");
    expect(result.current.sizeMode).toBe("standard");
    expect(result.current.status).toBe("idle");
    expect(result.current.conversationTitle).toBeNull();
  });
});

describe("useAgentPanelStore — visibility transitions", () => {
  it("open() sets visibility to open", () => {
    const { result } = renderStore();
    act(() => result.current.open());
    expect(result.current.visibility).toBe("open");
  });

  it("collapse() sets visibility to collapsed", () => {
    const { result } = renderStore();
    act(() => result.current.collapse());
    expect(result.current.visibility).toBe("collapsed");
  });

  it("close() resets visibility to closed and status to idle", () => {
    const { result } = renderStore();
    act(() => {
      result.current.open();
      result.current.setStatus("active");
    });
    act(() => result.current.close());
    expect(result.current.visibility).toBe("closed");
    expect(result.current.status).toBe("idle");
  });
});

describe("useAgentPanelStore — size mode", () => {
  it("toggleSize() flips between standard and expanded", () => {
    const { result } = renderStore();
    act(() => result.current.toggleSize());
    expect(result.current.sizeMode).toBe("expanded");
    act(() => result.current.toggleSize());
    expect(result.current.sizeMode).toBe("standard");
  });

  it("setSizeMode() sets the mode explicitly", () => {
    const { result } = renderStore();
    act(() => result.current.setSizeMode("expanded"));
    expect(result.current.sizeMode).toBe("expanded");
  });
});

describe("useAgentPanelStore — status and title", () => {
  it("setStatus() and setConversationTitle() update state", () => {
    const { result } = renderStore();
    act(() => {
      result.current.setStatus("completed");
      result.current.setConversationTitle("Ship it");
    });
    expect(result.current.status).toBe("completed");
    expect(result.current.conversationTitle).toBe("Ship it");
  });

  it("startNewChat() clears the title and resets status to idle", () => {
    const { result } = renderStore();
    act(() => {
      result.current.open();
      result.current.setConversationTitle("Old chat");
      result.current.setStatus("active");
    });
    act(() => result.current.startNewChat());
    expect(result.current.conversationTitle).toBeNull();
    expect(result.current.status).toBe("idle");
    // Visibility intentionally stays open so the user sees the new-chat state.
    expect(result.current.visibility).toBe("open");
  });
});

describe("useAgentPanelStore — conversation public id (continue-in-page link)", () => {
  it("defaults to null", () => {
    const { result } = renderStore();
    expect(result.current.conversationPublicId).toBeNull();
  });

  it("setConversationPublicId() records the active conversation publicId", () => {
    const { result } = renderStore();
    act(() => result.current.setConversationPublicId("conv_abc123"));
    expect(result.current.conversationPublicId).toBe("conv_abc123");
  });

  it("startNewChat() clears the conversation publicId", () => {
    const { result } = renderStore();
    act(() => result.current.setConversationPublicId("conv_abc123"));
    act(() => result.current.startNewChat());
    expect(result.current.conversationPublicId).toBeNull();
  });
});

describe("useAgentPanelStore — newChatNonce (remount signal)", () => {
  it("defaults to 0", () => {
    const { result } = renderStore();
    expect(result.current.newChatNonce).toBe(0);
  });

  it("increments on every startNewChat() so the panel can key a fresh chat shell", () => {
    const { result } = renderStore();
    act(() => result.current.startNewChat());
    expect(result.current.newChatNonce).toBe(1);
    act(() => result.current.startNewChat());
    expect(result.current.newChatNonce).toBe(2);
  });
});
