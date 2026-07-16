// @vitest-environment jsdom
/**
 * agent-picker-panel.test.tsx — the shared picker panel: rendering, search,
 * chat-agent immediate apply, the code-agent repo → branch → environment setup
 * step (+ prefill, lazy branch load, and the repo→branch cascade), the default
 * star, and roving keyboard focus.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AgentPickerPanel } from "./agent-picker-panel";
import { ChatSessionProvider } from "../session/session-store";
import type { SessionSeed } from "../session/session-state";
import { listRepoBranchesAction } from "../session/branch-actions";
import type { AgentOption } from "./agent-picker-types";
import type { RepoOption } from "../repo-selector";
import type { EnvironmentOption } from "../environment-selector";

// The branch fetch is a "use server" action — importing it for real drags in
// Better Auth's env schema. Stub the module at its boundary.
vi.mock("../session/branch-actions", () => ({
  listRepoBranchesAction: vi.fn(),
}));

/**
 * Select shim (same approach as repo-selector.test.tsx): Base UI's Select
 * portals its popup and needs real pointer events, so swap in a flat
 * trigger-button + option-buttons tree. Keeps `aria-label` on the trigger and
 * routes `onOpenChange` / `onValueChange`, which is exactly the surface the
 * branch row's lazy load and selection depend on.
 */
vi.mock("@/components/ui/select", async () => {
  const React = await vi.importActual<typeof import("react")>("react");
  const Ctx = React.createContext<{
    value?: string;
    disabled?: boolean;
    onValueChange?: (v: string) => void;
    onOpenChange?: (open: boolean) => void;
  }>({});
  return {
    Select: ({
      children,
      value,
      disabled,
      onValueChange,
      onOpenChange,
    }: {
      children: React.ReactNode;
      value?: string;
      disabled?: boolean;
      onValueChange?: (v: string) => void;
      onOpenChange?: (open: boolean) => void;
    }) => (
      <Ctx.Provider value={{ value, disabled, onValueChange, onOpenChange }}>
        <div data-value={value ?? ""}>{children}</div>
      </Ctx.Provider>
    ),
    SelectTrigger: ({
      children,
      className,
      "aria-label": ariaLabel,
    }: {
      children: React.ReactNode;
      className?: string;
      "aria-label"?: string;
    }) => {
      const { onOpenChange, disabled } = React.useContext(Ctx);
      return (
        <button
          type="button"
          aria-label={ariaLabel}
          className={className}
          disabled={disabled}
          onClick={() => onOpenChange?.(true)}
        >
          {children}
        </button>
      );
    },
    SelectValue: ({
      children,
      placeholder,
    }: {
      children?: React.ReactNode | ((v: string | null) => React.ReactNode);
      placeholder?: string;
    }) => {
      const { value } = React.useContext(Ctx);
      return (
        <span>
          {typeof children === "function"
            ? children(value ?? null)
            : (children ?? placeholder)}
        </span>
      );
    },
    SelectPopup: ({ children }: { children: React.ReactNode }) => (
      <div>{children}</div>
    ),
    SelectItem: ({
      children,
      value,
    }: {
      children: React.ReactNode;
      value: string;
    }) => {
      const { onValueChange } = React.useContext(Ctx);
      return (
        <button type="button" onClick={() => onValueChange?.(value)}>
          {children}
        </button>
      );
    },
  };
});

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
  {
    key: "con_1::acme/web",
    connectionId: "con_1",
    owner: "acme",
    name: "web",
    defaultBranch: "trunk",
  },
];
const ENVS: EnvironmentOption[] = [
  { id: "env_dev", name: "Development", isDefault: true },
];

const listBranchesMock = vi.mocked(listRepoBranchesAction);

beforeEach(() => {
  listBranchesMock.mockReset();
  listBranchesMock.mockResolvedValue({
    branches: [
      { name: "main", isDefault: true },
      { name: "develop", isDefault: false },
    ],
    defaultBranch: "main",
  });
});

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
      orgSlug="acme"
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
      // Untouched branch = the repository's default, sent explicitly as null.
      branch: null,
      envId: "env_dev",
    });
    expect(onDismiss).toHaveBeenCalled();
  });
});

describe("AgentPickerPanel — branch selection", () => {
  /** Open the setup step for the code agent, repo/env prefilled. */
  function openSetup(
    overrides: Partial<React.ComponentProps<typeof AgentPickerPanel>> = {},
  ) {
    const handles = renderPanel({
      defaultRepoKey: "con_1::acme/api",
      defaultEnvId: "env_dev",
      ...overrides,
    });
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    return handles;
  }

  it("shows a branch row in the code-agent setup step", () => {
    openSetup();
    expect(screen.getByTestId("setup-branch-row")).toBeInTheDocument();
    expect(screen.getByLabelText("Session branch")).toBeInTheDocument();
  });

  it("defaults to the repository default rather than forcing a branch choice", () => {
    openSetup();
    // The repo's own defaultBranch labels the row before any fetch resolves.
    expect(screen.getByLabelText("Session branch")).toHaveTextContent(
      "Repository default (main)",
    );
    // No branch chosen must not block confirm — branch is optional.
    expect(
      screen.getByRole("button", { name: /Chat with Coder/ }),
    ).not.toBeDisabled();
  });

  it("applies branch: null when the repository default is kept", () => {
    const { onApply } = openSetup();
    fireEvent.click(screen.getByRole("button", { name: /Chat with Coder/ }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "agt_code", branch: null }),
    );
  });

  it("loads branches lazily — only when the branch picker is opened", async () => {
    openSetup();
    expect(listBranchesMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText("Session branch"));
    await waitFor(() => expect(listBranchesMock).toHaveBeenCalledTimes(1));
    expect(listBranchesMock).toHaveBeenCalledWith(
      { orgSlug: "acme", workspaceSlug: "default" },
      { owner: "acme", repo: "api" },
    );
  });

  it("passes the chosen branch through onApply", async () => {
    const { onApply } = openSetup();
    fireEvent.click(screen.getByLabelText("Session branch"));
    const develop = await screen.findByRole("button", { name: "develop" });
    fireEvent.click(develop);
    fireEvent.click(screen.getByRole("button", { name: /Chat with Coder/ }));
    expect(onApply).toHaveBeenCalledWith({
      agentId: "agt_code",
      repoKey: "con_1::acme/api",
      branch: "develop",
      envId: "env_dev",
    });
  });

  it("lists the default branch once — as the 'Repository default' row", async () => {
    openSetup();
    fireEvent.click(screen.getByLabelText("Session branch"));
    await waitFor(() => expect(listBranchesMock).toHaveBeenCalled());
    // "main" is the sentinel row's subject; it must not also appear as its own
    // row, or two rows would mean the same thing.
    expect(
      screen.queryByRole("button", { name: "main" }),
    ).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "develop" })).toBeInTheDocument();
  });

  it("resets a chosen branch when the repository changes (org → repo → branch cascade)", async () => {
    const { onApply } = openSetup();
    fireEvent.click(screen.getByLabelText("Session branch"));
    fireEvent.click(await screen.findByRole("button", { name: "develop" }));
    expect(screen.getByLabelText("Session branch")).toHaveTextContent("develop");

    // Switch the repo — the branch belonged to the repo we just left.
    fireEvent.click(screen.getByRole("button", { name: "acme/web" }));
    expect(screen.getByLabelText("Session branch")).toHaveTextContent(
      "Repository default (trunk)",
    );
    fireEvent.click(screen.getByRole("button", { name: /Chat with Coder/ }));
    expect(onApply).toHaveBeenCalledWith(
      expect.objectContaining({ repoKey: "con_1::acme/web", branch: null }),
    );
  });

  it("preselects the branch already chosen for the conversation", () => {
    openSetup({ selectedRepoKey: "con_1::acme/api", selectedBranch: "develop" });
    expect(screen.getByLabelText("Session branch")).toHaveTextContent("develop");
  });

  it("omits the branch row without an org+workspace scope to fetch under", () => {
    openSetup({ orgSlug: undefined, workspaceSlug: undefined });
    expect(screen.queryByTestId("setup-branch-row")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Session branch")).not.toBeInTheDocument();
    // The step still works — repo + environment only.
    expect(screen.getByLabelText("Session repository")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Chat with Coder/ }),
    ).not.toBeDisabled();
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
// This whole path previously had ZERO coverage, which is exactly how a code
// agent came to skip the setup step under the flag.

const V2_SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: null,
  defaultEnvId: null,
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
        repos={REPOS}
        environments={ENVS}
        defaultRepoKey={null}
        defaultEnvId={null}
        defaultAgentId={null}
        selectedAgentId={null}
        selectedRepoKey={null}
        selectedEnvId={null}
        onApply={onApply}
        onDismiss={onDismiss}
        orgSlug="acme"
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
    expect(screen.queryByLabelText("Session repository")).not.toBeInTheDocument();
  });

  it("opens the setup step for a CODE agent instead of applying — its target is chosen once, never adjusted later", () => {
    const { onApply } = renderPanelV2();
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    // Must NOT apply on the pick: org/repo/branch/env are immutable once the
    // conversation starts, so the pick is the only chance to choose them.
    expect(onApply).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Session repository")).toBeInTheDocument();
    expect(screen.getByLabelText("Session environment")).toBeInTheDocument();
  });

  it("confirming the setup step sends the whole target atomically", () => {
    const { onApply } = renderPanelV2({
      defaultRepoKey: "con_1::acme/api",
      defaultEnvId: "env_dev",
    });
    fireEvent.click(screen.getByRole("option", { name: /Coder/ }));
    fireEvent.click(screen.getByRole("button", { name: /Chat with Coder/ }));
    expect(onApply).toHaveBeenCalledWith({
      agentId: "agt_code",
      repoKey: "con_1::acme/api",
      branch: null,
      envId: "env_dev",
    });
  });
});
