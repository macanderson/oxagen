// @vitest-environment jsdom
/**
 * agent-picker-panel.test.tsx — the shared picker panel: rendering, search,
 * immediate apply, the default star, and roving keyboard focus.
 *
 * ADR-043 removed the code-agent repo → branch → environment setup step: every
 * agent now applies on pick, because a conversation is no longer grounded in a
 * repository.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPickerPanel } from "./agent-picker-panel";
import { ChatSessionProvider } from "../session/session-store";
import type { SessionSeed } from "../session/session-state";
import type { AgentOption } from "./agent-picker-types";

// Strip framer-motion so AnimatePresence swaps views synchronously in jsdom.
vi.mock("motion/react", () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  motion: {
    div: ({
      children,
      variants: _v,
      initial: _i,
      animate: _a,
      exit: _e,
      transition: _t,
      ...rest
    }: React.HTMLAttributes<HTMLDivElement> & Record<string, unknown>) => (
      <div {...rest}>{children}</div>
    ),
  },
  useReducedMotion: () => true,
}));

// jsdom has no Next image runtime (used by an image avatar, not by our null-avatar fixtures).
vi.mock("next/image", () => ({
  default: ({
    src,
    alt,
    ...rest
  }: {
    src: string;
    alt: string;
    [key: string]: unknown;
  }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom shim
    <img src={src} alt={alt} {...rest} />
  ),
}));

afterEach(cleanup);

const CODER: AgentOption = {
  agentId: "agt_code",
  slug: "coder",
  name: "Coder",
  description: "Writes code",
  agentType: "custom",
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [{ type: "capability", ref: "list_agent_executions" }],
};
const CHATTER: AgentOption = {
  agentId: "agt_chat",
  slug: "chatter",
  name: "Chatter",
  description: "Chats with you",
  agentType: "custom",
  avatarUrl: null,
  summary: "Friendly chat",
  managed: true,
  toolRefs: [],
};

function renderPanel(
  overrides: Partial<React.ComponentProps<typeof AgentPickerPanel>> = {},
) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  const onSetDefaultAgent = vi.fn();
  render(
    <AgentPickerPanel
      variant="popover"
      agents={[CODER, CHATTER]}
      defaultAgentId={null}
      onSetDefaultAgent={onSetDefaultAgent}
      selectedAgentId={null}
      onApply={onApply}
      onDismiss={onDismiss}
      workspaceSlug="default"
      {...overrides}
    />,
  );
  return { onApply, onDismiss, onSetDefaultAgent };
}

describe("AgentPickerPanel — list", () => {
  it("renders the default-assistant row plus every agent", () => {
    renderPanel();
    expect(
      screen.getByRole("option", { name: /Default assistant/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Coder/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /Chatter/ })).toBeInTheDocument();
  });

  it("filters agents by the search query", async () => {
    renderPanel();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search agents" }),
      "coder",
    );
    expect(screen.getByRole("option", { name: /Coder/ })).toBeInTheDocument();
    expect(
      screen.queryByRole("option", { name: /Chatter/ }),
    ).not.toBeInTheDocument();
  });
});

describe("AgentPickerPanel — selection", () => {
  it("applies a chat agent immediately and dismisses", () => {
    const { onApply, onDismiss } = renderPanel();
    fireEvent.click(screen.getByRole("option", { name: /Chatter/ }));
    expect(onApply).toHaveBeenCalledWith({ agentId: "agt_chat" });
    expect(onDismiss).toHaveBeenCalled();
  });

  it("applies the default assistant (null) immediately", () => {
    const { onApply } = renderPanel();
    fireEvent.click(screen.getByRole("option", { name: /Default assistant/ }));
    expect(onApply).toHaveBeenCalledWith({ agentId: null });
  });

  it("applies every agent immediately — there is no setup step (ADR-043)", () => {
    const { onApply, onDismiss } = renderPanel();
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    expect(onApply).toHaveBeenCalledWith({ agentId: "agt_code" });
    expect(onDismiss).toHaveBeenCalled();
    expect(
      screen.queryByLabelText("Session repository"),
    ).not.toBeInTheDocument();
  });
});

describe("AgentPickerPanel — default star", () => {
  it("sets an agent as the default", () => {
    const { onSetDefaultAgent } = renderPanel();
    fireEvent.click(
      screen.getByRole("button", { name: "Set Coder as default assistant" }),
    );
    expect(onSetDefaultAgent).toHaveBeenCalledWith("agt_code");
  });

  it("clears the default when the current default's star is toggled", () => {
    const { onSetDefaultAgent } = renderPanel({ defaultAgentId: "agt_code" });
    fireEvent.click(
      screen.getByRole("button", { name: "Remove Coder as default assistant" }),
    );
    expect(onSetDefaultAgent).toHaveBeenCalledWith(null);
  });

  it("hides the star affordance when no handler is provided", () => {
    renderPanel({ onSetDefaultAgent: undefined });
    expect(
      screen.queryByRole("button", { name: /as default assistant/ }),
    ).not.toBeInTheDocument();
  });

  it("surfaces the workspace default agent first in the list", () => {
    // CHATTER is second in `agents`, but as the default it sorts to the top.
    renderPanel({ defaultAgentId: "agt_chat" });
    const options = screen
      .getAllByRole("option")
      .map((el) => el.getAttribute("aria-label") ?? el.textContent ?? "");
    // Row 0 is the Default assistant; the workspace default agent leads the rest.
    const firstAgentRow = options[1] ?? "";
    expect(firstAgentRow).toContain("Chatter");
  });
});

describe("AgentPickerPanel — keyboard", () => {
  it("moves focus between rows with ArrowDown", () => {
    renderPanel();
    const defaultRow = screen.getByRole("option", {
      name: /Default assistant/,
    });
    const coderRow = screen.getByRole("option", { name: /Coder/ });
    defaultRow.focus();
    fireEvent.keyDown(screen.getByRole("listbox", { name: "Agents" }), {
      key: "ArrowDown",
    });
    expect(document.activeElement).toBe(coderRow);
  });
});

// ── chat_ux_v2 path ──────────────────────────────────────────────────────────
// `v2` is NOT a prop — the panel derives it from `useChatSessionContext() !==
// null`, so exercising this path means mounting a real ChatSessionProvider.

const V2_SEED: SessionSeed = {
  defaultAgentId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

function renderPanelV2(
  overrides: Partial<React.ComponentProps<typeof AgentPickerPanel>> = {},
) {
  const onApply = vi.fn();
  const onDismiss = vi.fn();
  render(
    <ChatSessionProvider
      workspaceSlug="default"
      conversationId={null}
      boundAgentId={null}
      isNewConversation={true}
      hasMessages={false}
      seed={V2_SEED}
    >
      <AgentPickerPanel
        variant="popover"
        agents={[CODER, CHATTER]}
        defaultAgentId={null}
        selectedAgentId={null}
        onApply={onApply}
        onDismiss={onDismiss}
        workspaceSlug="default"
        {...overrides}
      />
    </ChatSessionProvider>,
  );
  return { onApply, onDismiss };
}

describe("AgentPickerPanel — chat_ux_v2", () => {
  it("applies a NON-code agent immediately — there is nothing to set up", () => {
    const { onApply } = renderPanelV2();
    fireEvent.click(screen.getByRole("option", { name: /Chatter/ }));
    expect(onApply).toHaveBeenCalledWith({ agentId: "agt_chat" });
    expect(
      screen.queryByLabelText("Session repository"),
    ).not.toBeInTheDocument();
  });

  it("applies a previously code-flavored agent immediately too", () => {
    const { onApply } = renderPanelV2();
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    expect(onApply).toHaveBeenCalledWith({ agentId: "agt_code" });
    expect(
      screen.queryByLabelText("Session environment"),
    ).not.toBeInTheDocument();
  });
});
