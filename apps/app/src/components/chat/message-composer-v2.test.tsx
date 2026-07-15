// @vitest-environment jsdom
/**
 * message-composer-v2.test.tsx
 *
 * chat_ux_v2 mobile row: the condensed [plus][textarea][cog][send] toolbar
 * that replaces the ENTIRE desktop/legacy-mobile toolbar, but ONLY when BOTH
 * a ChatSessionProvider is mounted AND the viewport is phone-width (see the
 * `v2Mobile` derivation in message-composer.tsx). Split from
 * message-composer.test.tsx (3500+ lines already) to keep test files
 * focused, mirroring that file's own mocking conventions (it stubs
 * matchMedia via `@/hooks/use-media-query`).
 */
import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";

afterEach(cleanup);

vi.mock("@/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils")>()),
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Controllable viewport: false = desktop (jsdom default), true = phone width.
const { mockViewport } = vi.hoisted(() => ({
  mockViewport: { isMobile: false },
}));
vi.mock("@/hooks/use-media-query", () => ({
  useIsMobile: () => mockViewport.isMobile,
  useMediaQuery: () => mockViewport.isMobile,
}));

afterEach(() => {
  mockViewport.isMobile = false;
  window.localStorage.clear();
});

vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children, open }: { children: React.ReactNode; open?: boolean }) =>
    open ? <div data-testid="sheet-root">{children}</div> : null,
  SheetPopup: ({
    children,
    "data-testid": testId,
  }: {
    children: React.ReactNode;
    side?: string;
    "data-testid"?: string;
  }) => <div data-testid={testId ?? "sheet-popup"}>{children}</div>,
  SheetHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetPanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SheetTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  SheetDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));

vi.mock("./agent-picker/agent-context-chip", () => ({
  AgentContextChip: () => <div data-testid="agent-selector" />,
}));

const mockSupportsReasoning = vi.fn((_model: unknown) => false);
const mockGetModel = vi.fn((_id: unknown) => undefined);
vi.mock("@oxagen/ai/catalog", () => ({
  supportsReasoning: (model: unknown) => mockSupportsReasoning(model),
  getModel: (id: unknown) => mockGetModel(id),
}));

vi.mock("./model-picker", async () => {
  const state = await vi.importActual<typeof import("./model-state")>("./model-state");
  return {
    ...state,
    ModelPicker: () => <div data-testid="model-picker" />,
  };
});

vi.mock("./mcp-server-picker", () => ({
  McpServerPicker: () => <div data-testid="mcp-server-picker" />,
}));

vi.mock("./budget-control", () => ({
  BudgetControl: () => <div data-testid="budget-control" />,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    type,
    className,
    disabled,
    "aria-label": ariaLabel,
    "aria-pressed": ariaPressed,
    ...rest
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: string;
    size?: string;
  }) => (
    <button
      type={(type as "button" | "submit" | "reset") ?? "button"}
      onClick={onClick}
      className={className}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      {...rest}
    >
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: ({
    name,
    placeholder,
    disabled,
    onKeyDown,
    rows,
    className,
    ...rest
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea
      name={name}
      placeholder={placeholder}
      disabled={disabled}
      onKeyDown={onKeyDown}
      rows={rows}
      className={className}
      {...rest}
    />
  ),
}));

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select">{children}</div>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="select-trigger">{children}</div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim
    <img alt={alt} src={src} />
  ),
}));

vi.mock("./extract-video-frames", () => ({
  extractVideoFrames: vi.fn().mockResolvedValue([]),
}));

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "default" }),
}));

import { MessageComposer } from "./message-composer";
import { ChatSessionProvider, useChatSession } from "./session/session-store";
import type { SessionSeed } from "./session/session-state";

const DEFAULT_MODEL_CONFIG: ResolvedTierCatalog = {
  text: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-5",
    precise: "claude-opus-4-5",
  },
  image: {
    basic: "gpt-image-1",
    standard: "gpt-image-1",
    premium: "flux-2-max",
  },
  video: {
    basic: "veo-3.0-fast",
    standard: "veo-3.0",
    premium: "veo-3.0",
  },
} as unknown as ResolvedTierCatalog;

function makeAction(result: { ok: boolean } = { ok: true }) {
  return vi.fn().mockResolvedValue(result);
}

const BASE_SEED: SessionSeed = {
  defaultAgentId: null,
  defaultRepoKey: null,
  defaultEnvId: null,
  textModel: null,
  textTier: "fast",
  budgetUsd: null,
};

/** A sibling that exposes a button to mutate the session store directly —
 * the condensed v2Mobile row has no model/effort/budget controls of its own
 * to drive a real divergence from defaults, so tests use this to simulate
 * "the user changed something in the session-settings drawer". */
function DirtyTrigger() {
  const { updateSession } = useChatSession();
  return (
    <button
      type="button"
      data-testid="dirty-trigger"
      onClick={() => updateSession({ effort: "high" })}
    >
      make dirty
    </button>
  );
}

function renderWithSession(
  props: Partial<React.ComponentProps<typeof MessageComposer>> = {},
  seed: SessionSeed = BASE_SEED,
  extraChildren?: React.ReactNode,
) {
  return render(
    <ChatSessionProvider
      workspaceSlug="acme-ws"
      conversationId={null}
      boundAgentId={null}
      isNewConversation={true}
      hasMessages={false}
      seed={seed}
    >
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="default"
        {...props}
      />
      {extraChildren}
    </ChatSessionProvider>,
  );
}

describe("MessageComposer — chat_ux_v2 mobile row", () => {
  it("renders exactly the four condensed controls (plus, textarea, cog, send)", () => {
    mockViewport.isMobile = true;
    renderWithSession();
    expect(screen.getByTestId("composer-v2-mobile-row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Send a message…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Session settings" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("hides the model/agent/effort/budget/MCP/overflow controls in the condensed row", () => {
    mockViewport.isMobile = true;
    renderWithSession();
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-selector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("budget-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-server-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-trigger")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More composer options" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate video" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Collapse composer" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Expand composer" }),
    ).not.toBeInTheDocument();
  });

  it("renders no cog dot when the session matches the workspace defaults", () => {
    mockViewport.isMobile = true;
    renderWithSession();
    expect(screen.queryByTestId("composer-cog-dot")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Session settings" })).toBeInTheDocument();
  });

  it("shows an accent cog dot once a setting diverges from the workspace defaults", () => {
    mockViewport.isMobile = true;
    renderWithSession({}, BASE_SEED, <DirtyTrigger />);
    expect(screen.queryByTestId("composer-cog-dot")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dirty-trigger"));
    const dot = screen.getByTestId("composer-cog-dot");
    expect(dot.className).toContain("bg-primary");
    expect(
      screen.getByRole("button", { name: "Session settings, settings changed" }),
    ).toBeInTheDocument();
  });

  it("shows a destructive cog dot (taking precedence over the dirty accent) when the session has a broken selection", () => {
    mockViewport.isMobile = true;
    // A repoKey the composer's `availableRepos` doesn't resolve is a broken
    // selection per sessionSelectionIssues — availableRepos is omitted here
    // (defaults to []), so the seeded key never resolves.
    renderWithSession({}, { ...BASE_SEED, defaultRepoKey: "con_x::ghost/repo" });
    const dot = screen.getByTestId("composer-cog-dot");
    expect(dot.className).toContain("bg-destructive");
    expect(
      screen.getByRole("button", { name: "Session settings, attention needed" }),
    ).toBeInTheDocument();
  });

  it("disables send while the input is empty — no native required validation", () => {
    mockViewport.isMobile = true;
    renderWithSession();
    const textarea = screen.getByPlaceholderText("Send a message…");
    // The spec bans the browser "Please fill out this field." tooltip: the
    // field must NOT be `required`; emptiness gates the button instead.
    expect(textarea).not.toBeRequired();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(send).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(send).toBeDisabled();
  });

  it("keeps the at-rest row within the 64px budget paddings (py-2 on the form)", () => {
    mockViewport.isMobile = true;
    renderWithSession();
    const row = screen.getByTestId("composer-v2-mobile-row");
    const form = row.closest("form");
    expect(form?.className).toContain("py-2");
  });

  it("calls onOpenSessionSettings when the cog button is tapped", () => {
    mockViewport.isMobile = true;
    const onOpenSessionSettings = vi.fn();
    renderWithSession({ onOpenSessionSettings });
    fireEvent.click(screen.getByRole("button", { name: "Session settings" }));
    expect(onOpenSessionSettings).toHaveBeenCalledTimes(1);
  });

  it("submits through the condensed row's Send button like the legacy composer", async () => {
    mockViewport.isMobile = true;
    const action = makeAction();
    renderWithSession({ action });
    const textarea = screen.getByPlaceholderText("Send a message…");
    fireEvent.change(textarea, { target: { value: "Hello from v2 mobile" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0]![0] as FormData;
    expect(fd.get("content")).toBe("Hello from v2 mobile");
  });
});

describe("MessageComposer — chat_ux_v2 desktop condensed row", () => {
  it("renders exactly plus/textarea/send with no cog by default (rail visible, showComposerCog omitted)", () => {
    mockViewport.isMobile = false;
    renderWithSession();
    expect(screen.getByTestId("composer-v2-desktop-row")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-v2-mobile-row")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add attachment" })).toBeInTheDocument();
    expect(screen.getByPlaceholderText("Send a message…")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Session settings" })).not.toBeInTheDocument();
  });

  it("shows the cog when showComposerCog is true (mid-width, rail hidden)", () => {
    mockViewport.isMobile = false;
    renderWithSession({ showComposerCog: true, onOpenSessionSettings: vi.fn() });
    expect(screen.getByRole("button", { name: "Session settings" })).toBeInTheDocument();
  });

  it("calls onOpenSessionSettings when the cog is clicked", () => {
    mockViewport.isMobile = false;
    const onOpenSessionSettings = vi.fn();
    renderWithSession({ showComposerCog: true, onOpenSessionSettings });
    fireEvent.click(screen.getByRole("button", { name: "Session settings" }));
    expect(onOpenSessionSettings).toHaveBeenCalledTimes(1);
  });

  it("shows the accent cog dot once a setting diverges from the workspace defaults", () => {
    mockViewport.isMobile = false;
    renderWithSession({ showComposerCog: true }, BASE_SEED, <DirtyTrigger />);
    expect(screen.queryByTestId("composer-cog-dot")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dirty-trigger"));
    const dot = screen.getByTestId("composer-cog-dot");
    expect(dot.className).toContain("bg-primary");
  });

  it("hides the legacy model/agent/effort/budget/MCP/collapse/generate controls", () => {
    mockViewport.isMobile = false;
    renderWithSession();
    expect(screen.queryByTestId("model-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-selector")).not.toBeInTheDocument();
    expect(screen.queryByTestId("budget-control")).not.toBeInTheDocument();
    expect(screen.queryByTestId("mcp-server-picker")).not.toBeInTheDocument();
    expect(screen.queryByTestId("select-trigger")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate image" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate video" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse composer" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Expand composer" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "More composer options" }),
    ).not.toBeInTheDocument();
  });

  it("disables send while the input is empty — textarea is not required", () => {
    mockViewport.isMobile = false;
    renderWithSession();
    const textarea = screen.getByPlaceholderText("Send a message…");
    expect(textarea).not.toBeRequired();
    const send = screen.getByRole("button", { name: "Send message" });
    expect(send).toBeDisabled();
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(send).not.toBeDisabled();
    fireEvent.change(textarea, { target: { value: "   " } });
    expect(send).toBeDisabled();
  });

  it("submits through the condensed row's Send button", async () => {
    mockViewport.isMobile = false;
    const action = makeAction();
    renderWithSession({ action });
    const textarea = screen.getByPlaceholderText("Send a message…");
    fireEvent.change(textarea, { target: { value: "Hello from v2 desktop" } });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await vi.waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0]![0] as FormData;
    expect(fd.get("content")).toBe("Hello from v2 desktop");
  });
});

describe("MessageComposer — legacy mobile toolbar is unchanged without chat_ux_v2", () => {
  it("renders the legacy mobile toolbar (overflow button, no condensed row) with no session provider mounted", () => {
    mockViewport.isMobile = true;
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.queryByTestId("composer-v2-mobile-row")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "More composer options" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });

  it("does not render the MOBILE condensed row on desktop even with a session provider mounted (v2Desktop renders its own row instead)", () => {
    mockViewport.isMobile = false;
    renderWithSession();
    expect(screen.queryByTestId("composer-v2-mobile-row")).not.toBeInTheDocument();
  });

  it("renders the full legacy desktop toolbar unchanged with no session provider mounted", () => {
    mockViewport.isMobile = false;
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.queryByTestId("composer-v2-desktop-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("composer-v2-mobile-row")).not.toBeInTheDocument();
    expect(screen.getByTestId("model-picker")).toBeInTheDocument();
    expect(screen.getByTestId("budget-control")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate video" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Collapse composer" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
  });
});

describe("MessageComposer — v2 wallet gate", () => {
  it("disables send with inline copy when the cap exceeds the wallet balance", () => {
    mockViewport.isMobile = true;
    renderWithSession(
      { walletBalanceUsd: 1 },
      { ...BASE_SEED, budgetUsd: 2 },
    );
    expect(
      screen.getByText(
        "Wallet balance is below your cap. Add funds or lower the cap.",
      ),
    ).toBeInTheDocument();
    const textarea = screen.getByPlaceholderText("Send a message…");
    fireEvent.change(textarea, { target: { value: "hello" } });
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("no gate when the wallet covers the cap or no cap is set", () => {
    mockViewport.isMobile = true;
    renderWithSession(
      { walletBalanceUsd: 5 },
      { ...BASE_SEED, budgetUsd: 2 },
    );
    expect(screen.queryByTestId("wallet-gate-hint")).toBeNull();
    cleanup();
    mockViewport.isMobile = true;
    renderWithSession({ walletBalanceUsd: 1 }, BASE_SEED);
    expect(screen.queryByTestId("wallet-gate-hint")).toBeNull();
  });

  it("an unknown balance (null) never blocks sending", () => {
    mockViewport.isMobile = true;
    renderWithSession(
      { walletBalanceUsd: null },
      { ...BASE_SEED, budgetUsd: 2 },
    );
    expect(screen.queryByTestId("wallet-gate-hint")).toBeNull();
  });
});
