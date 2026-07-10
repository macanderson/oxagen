// @vitest-environment jsdom
/**
 * agent-picker-panel.test.tsx — the shared picker panel: rendering, search,
 * chat-agent immediate apply, the code-agent repo/env setup step + prefill, the
 * default star, and roving keyboard focus.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPickerPanel } from "./agent-picker-panel";
import type { AgentOption } from "./agent-picker-types";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

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
  agentType: "code",
  isCode: true,
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [{ type: "skill", ref: "skills/review" }],
};
const CHATTER: AgentOption = {
  agentId: "agt_chat",
  slug: "chatter",
  name: "Chatter",
  description: "Chats with you",
  agentType: "custom",
  isCode: false,
  avatarUrl: null,
  summary: "Friendly chat",
  managed: true,
  toolRefs: [],
};
const REPOS: RepoOption[] = [
  {
    key: "con_1::acme/api",
    connectionId: "con_1",
    owner: "acme",
    name: "api",
    defaultBranch: "main",
  },
];
const ENVS: EnvironmentOption[] = [
  { id: "env_dev", name: "Development", isDefault: true },
];

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
      repos={REPOS}
      environments={ENVS}
      defaultRepoKey={null}
      defaultEnvId={null}
      defaultAgentId={null}
      onSetDefaultAgent={onSetDefaultAgent}
      selectedAgentId={null}
      selectedRepoKey={null}
      selectedEnvId={null}
      onApply={onApply}
      onDismiss={onDismiss}
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

  it("opens the repo/env setup step for a code agent instead of applying", () => {
    const { onApply } = renderPanel();
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    expect(onApply).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /Chat with Coder/ }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Session repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Session environment")).toBeInTheDocument();
  });

  it("prefills repo + env from the workspace defaults so confirm is enabled", () => {
    renderPanel({ defaultRepoKey: "con_1::acme/api", defaultEnvId: "env_dev" });
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    expect(
      screen.getByRole("button", { name: /Chat with Coder/ }),
    ).not.toBeDisabled();
  });

  it("blocks confirm until repo + env are chosen (no defaults)", () => {
    renderPanel();
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    expect(
      screen.getByRole("button", { name: /Chat with Coder/ }),
    ).toBeDisabled();
  });

  it("confirms the code-agent setup with the selected repo + env", () => {
    const { onApply, onDismiss } = renderPanel({
      defaultRepoKey: "con_1::acme/api",
      defaultEnvId: "env_dev",
    });
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    fireEvent.click(screen.getByRole("button", { name: /Chat with Coder/ }));
    expect(onApply).toHaveBeenCalledWith({
      agentId: "agt_code",
      repoKey: "con_1::acme/api",
      envId: "env_dev",
    });
    expect(onDismiss).toHaveBeenCalled();
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
