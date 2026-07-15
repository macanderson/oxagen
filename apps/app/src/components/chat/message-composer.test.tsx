// @vitest-environment jsdom
/**
 * message-composer.test.tsx
 *
 * Unit tests for MessageComposer:
 *   - Renders textarea, image/video toggles, send button
 *   - MCP picker shown only when availableMcpServers is non-empty
 *   - Submit encodes conversationId, parentMessageId, model tier, activeServerIds
 *   - disabled prop blocks submit
 *   - Empty textarea submit is a no-op
 *   - disabledReason renders when disabled
 *   - enterToSubmit: Enter submits, Shift+Enter inserts newline
 *   - enterToSubmit=false (default): Cmd/Ctrl+Enter submits
 *   - IME guard: no submit during composition
 *   - Queue mode: submitting while streaming adds chip; remove chip works
 *   - Interrupt mode: calls onInterrupt then submits
 *   - Queue drain: isStreaming false→true→false dispatches queued message
 *   - activeServerIds encoded in queue-drain FormData via ref
 *   - Error message shown on action failure
 *   - Image/video toggle changes placeholder
 *   - Effort select shown when model supports reasoning
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  act,
  waitFor,
  fireEvent,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type { McpServerSummary } from "./mcp-types";

afterEach(cleanup);

// ── mocks ──────────────────────────────────────────────────────────────────────

// Spread the real module so every other util (truncate, formatBytes, …) the
// composer tree calls stays intact — a full-replacement mock silently drops
// them and throws "No X export is defined on the mock" at render time.
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

// Sheet shim — renders children inline when open (the real component portals
// a Base UI dialog; these tests assert the composer's own composition).
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
  SheetHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetPanel: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SheetTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  SheetDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
}));

// AgentContextChip stub — renders null when there are no agents (matching the
// real chip) and, otherwise, one button per agent (+ a default) so a test can
// drive the selection deterministically without opening a real popover portal.
// Calls the real `onApply` (the composer's shared-store applyAgentSelection) so
// the code-mode gating derivations run exactly as in production.
vi.mock("./agent-picker/agent-context-chip", () => ({
  AgentContextChip: ({
    agents,
    onApply,
    locked,
  }: {
    agents: Array<{ agentId: string; isCode: boolean }>;
    onApply: (sel: { agentId: string | null }) => void;
    locked?: boolean;
  }) =>
    agents.length === 0 ? null : (
      <div
        data-testid="agent-selector"
        data-count={agents.length}
        data-locked={locked ? "true" : undefined}
      >
        {agents.map((a) => (
          <button
            key={a.agentId}
            type="button"
            data-testid={`pick-${a.agentId}`}
            disabled={locked}
            onClick={() => onApply({ agentId: a.agentId })}
          >
            pick {a.agentId}
          </button>
        ))}
        <button
          type="button"
          data-testid="pick-default"
          disabled={locked}
          onClick={() => onApply({ agentId: null })}
        >
          pick default
        </button>
      </div>
    ),
}));

afterEach(() => {
  mockViewport.isMobile = false;
  window.localStorage.clear();
});

const mockSupportsReasoning = vi.fn((_model: unknown) => false);
const mockGetModel = vi.fn((_id: unknown) => undefined);

vi.mock("@oxagen/ai/catalog", () => ({
  supportsReasoning: (model: unknown) => mockSupportsReasoning(model),
  getModel: (id: unknown) => mockGetModel(id),
}));

// model-picker re-exports its pure state helpers (defaultModelState,
// buildSeededModelState, applyWorkspaceBudgetGovernance) from model-state.ts,
// which has no UI imports. Pull the REAL implementations from there so the
// composer's budget-governance path runs faithfully — only the interactive
// ModelPicker component itself is stubbed. Listing helpers by hand here is how
// this mock silently dropped applyWorkspaceBudgetGovernance when PR #630 added
// it (→ undefined at call time); spreading the real module keeps it in sync.
// Clamp/strip behaviour is covered by model-state.test.ts.
vi.mock("./model-picker", async () => {
  const state =
    await vi.importActual<typeof import("./model-state")>("./model-state");
  return {
    ...state,
    ModelPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
      <div
        data-testid="model-picker"
        onClick={() =>
          onChange({
            tier: "fast",
            generate: null,
            model: null,
            effort: null,
            mediaTier: null,
            mediaModel: null,
            seededImageModel: null,
            seededVideoModel: null,
          })
        }
      />
    ),
  };
});

// McpServerPicker stub that exposes a button to change active server IDs
vi.mock("./mcp-server-picker", () => ({
  McpServerPicker: ({
    servers,
    activeServerIds,
    onActiveServerIdsChange,
  }: {
    servers: McpServerSummary[];
    activeServerIds: Set<string>;
    onActiveServerIdsChange: (ids: Set<string>) => void;
  }) => (
    <div data-testid="mcp-server-picker">
      <button
        type="button"
        data-testid="mcp-activate-first"
        onClick={() => {
          const next = new Set(activeServerIds);
          if (servers[0]) next.add(servers[0].publicId);
          onActiveServerIdsChange(next);
        }}
      >
        Activate first
      </button>
    </div>
  ),
}));

// BudgetControl stub — the real component pulls in Base UI Popover/Switch,
// which aren't otherwise exercised in this file (mirrors the McpServerPicker
// stub above: these tests isolate MessageComposer's own submit/queue/dispatch
// logic, not the toolbar controls' internal rendering).
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
  Select: ({
    children,
    onValueChange,
    value,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
    value?: string;
  }) => (
    <div
      data-testid="select"
      data-value={value}
      onClick={() => onValueChange?.("high")}
    >
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
    size?: string;
    className?: string;
  }) => (
    <div data-testid="select-trigger" aria-label={ariaLabel}>
      {children}
    </div>
  ),
  SelectValue: ({ placeholder }: { placeholder?: string }) => (
    <span>{placeholder}</span>
  ),
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    children,
    value,
  }: {
    children: React.ReactNode;
    value: string;
  }) => <div data-value={value}>{children}</div>,
}));

vi.mock("lucide-react", async (importOriginal) => {
  const real = await importOriginal<typeof import("lucide-react")>();
  return {
    ...real,
    Brain: () => <span data-testid="icon-brain" />,
    ImageIcon: () => <span data-testid="icon-image" />,
    Send: () => <span data-testid="icon-send" />,
    Video: () => <span data-testid="icon-video" />,
    X: () => <span data-testid="icon-x" />,
    Paperclip: () => <span data-testid="icon-paperclip" />,
  };
});

// AttachmentChip renders next/image for image previews — stub it the same way
// the registry's own image-preview.test.tsx does (jsdom has no image loader).
vi.mock("next/image", () => ({
  default: ({ alt, src }: { alt: string; src: string }) => (
    // eslint-disable-next-line @next/next/no-img-element -- jsdom test shim
    <img alt={alt} src={src} data-testid="attachment-thumbnail" />
  ),
}));

// Client-side keyframe extraction needs a real <video>/<canvas> (absent in
// jsdom) — mock it so a video test can control how many frames come back.
const { mockExtractVideoFrames } = vi.hoisted(() => ({
  mockExtractVideoFrames:
    vi.fn<() => Promise<Array<{ blob: Blob; atSeconds: number }>>>(),
}));
vi.mock("./extract-video-frames", () => ({
  extractVideoFrames: mockExtractVideoFrames,
}));

// MentionChip reads org/workspace slugs for hover hydration via useParams —
// give it a stable router context. Spread the real module so sibling imports
// (useRouter, usePathname, …) keep working (full-replacement mocks drop them).
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useParams: () => ({ orgSlug: "acme", workspaceSlug: "default" }),
}));

// ── helpers ────────────────────────────────────────────────────────────────────

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

const makeMcpServer = (
  overrides: Partial<McpServerSummary> = {},
): McpServerSummary => ({
  publicId: "mcs_test",
  name: "Test Server",
  toolCount: 3,
  healthStatus: "healthy",
  ...overrides,
});

type ActionResult = {
  ok: boolean;
  error?: string;
  conversationId?: string;
  conversationPublicId?: string;
  userMessageId?: string;
};

// Returns a plain vi.fn() mock; cast to ComposerAction at prop-site so .mock
// is accessible for call inspection without losing the mock type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeAction(result: ActionResult = { ok: true }): any {
  return vi.fn().mockResolvedValue(result);
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe("MessageComposer — rendering", () => {
  it("renders textarea with default placeholder", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.getByPlaceholderText("Send a message…")).toBeInTheDocument();
  });

  it("renders image and video toggle buttons", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Generate image" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate video" }),
    ).toBeInTheDocument();
  });

  it("renders send button with 'Send message' label", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });

  it("does NOT render MCP picker when availableMcpServers is empty", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[]}
      />,
    );
    expect(screen.queryByTestId("mcp-server-picker")).not.toBeInTheDocument();
  });

  it("renders MCP picker when availableMcpServers is non-empty", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer()]}
      />,
    );
    expect(screen.getByTestId("mcp-server-picker")).toBeInTheDocument();
  });

  it("does NOT render MCP picker when availableMcpServers is undefined", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.queryByTestId("mcp-server-picker")).not.toBeInTheDocument();
  });

  it("renders disabledReason when disabled", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        disabled
        disabledReason="No credits left"
      />,
    );
    expect(screen.getByText("No credits left")).toBeInTheDocument();
  });

  it("shows Composer paused placeholder when disabled with no disabledReason", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        disabled
      />,
    );
    expect(screen.getByPlaceholderText("Composer paused.")).toBeInTheDocument();
  });

  it("shows 'Queue message' send button label when streaming in queue mode", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Queue message" }),
    ).toBeInTheDocument();
  });

  it("shows 'Interrupt and send' label when streaming in interrupt mode", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="interrupt"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Interrupt and send" }),
    ).toBeInTheDocument();
  });

  it("shows effort control when model supports reasoning", async () => {
    mockSupportsReasoning.mockReturnValue(true);
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.getByTestId("select-trigger")).toBeInTheDocument();
    mockSupportsReasoning.mockReturnValue(false);
  });

  it("hides effort control when model does NOT support reasoning", async () => {
    mockSupportsReasoning.mockReturnValue(false);
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(screen.queryByTestId("select-trigger")).not.toBeInTheDocument();
  });
});

describe("MessageComposer — submit", () => {
  it("calls action with FormData on submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    const textarea = screen.getByRole("textbox");
    await userEvent.type(textarea, "Hello world");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("content")).toBe("Hello world");
  });

  it("encodes conversationId and parentMessageId into FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId="conv-123"
        parentMessageId="msg-456"
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "test");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("conversationId")).toBe("conv-123");
    expect(fd.get("parentMessageId")).toBe("msg-456");
  });

  it("encodes activeServerIds when MCP servers are active", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer({ publicId: "mcs_abc" })]}
      />,
    );
    // Activate the first server via the stub picker
    await userEvent.click(screen.getByTestId("mcp-activate-first"));
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(JSON.parse(fd.get("activeServerIds") as string)).toEqual([
      "mcs_abc",
    ]);
  });

  it("does NOT encode activeServerIds when none are active", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer()]}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("activeServerIds")).toBeNull();
  });

  it("does NOT call action when disabled", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        disabled
      />,
    );
    // Submit button is disabled, clicking it should not fire action
    const submitBtn = screen.getByRole("button", { name: "Send message" });
    expect(submitBtn).toBeDisabled();
  });

  it("does NOT call action when textarea is empty", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    // Don't type anything — just submit
    const form = screen.getByRole("textbox").closest("form")!;
    await act(async () => {
      form.dispatchEvent(
        new Event("submit", { bubbles: true, cancelable: true }),
      );
    });
    expect(action).not.toHaveBeenCalled();
  });

  it("shows error message when action returns ok: false", async () => {
    const action = makeAction({ ok: false, error: "Server exploded" });
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByText("Server exploded")).toBeInTheDocument(),
    );
  });

  it("shows fallback error text when action returns ok: false with no error string", async () => {
    const action = makeAction({ ok: false });
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(screen.getByText("Failed to send message")).toBeInTheDocument(),
    );
  });

  it("encodes model tier in FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("tier")).toBe("fast");
  });
});

describe("MessageComposer — image / video toggles", () => {
  it("changes placeholder to image prompt on image toggle", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    expect(
      screen.getByPlaceholderText("Describe the image you want…"),
    ).toBeInTheDocument();
  });

  it("toggles image mode off when clicked again", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    const imgBtn = screen.getByRole("button", { name: "Generate image" });
    await userEvent.click(imgBtn);
    await userEvent.click(imgBtn);
    expect(screen.getByPlaceholderText("Send a message…")).toBeInTheDocument();
  });

  it("changes placeholder to video prompt on video toggle", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    expect(
      screen.getByPlaceholderText("Describe the video you want…"),
    ).toBeInTheDocument();
  });

  it("switches from image mode to video mode", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    expect(
      screen.getByPlaceholderText("Describe the video you want…"),
    ).toBeInTheDocument();
  });
});

describe("MessageComposer — keyboard", () => {
  it("enterToSubmit=true: Enter triggers submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(action).toHaveBeenCalled());
  });

  it("enterToSubmit=true: Shift+Enter does NOT submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
    expect(action).not.toHaveBeenCalled();
  });

  it("enterToSubmit=true: Enter on empty textarea does NOT submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
      />,
    );
    await userEvent.keyboard("{Enter}");
    expect(action).not.toHaveBeenCalled();
  });

  it("enterToSubmit=false (default): Ctrl+Enter submits", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit={false}
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    await userEvent.keyboard("{Control>}{Enter}{/Control}");
    await waitFor(() => expect(action).toHaveBeenCalled());
  });

  it("enterToSubmit=false: plain Enter does NOT submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit={false}
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    await userEvent.keyboard("{Enter}");
    expect(action).not.toHaveBeenCalled();
  });

  it("IME guard: keyCode 229 blocks submit", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    // Simulate IME composition keydown with keyCode 229
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "nativeEvent", {
      value: { isComposing: false },
    });
    ta.dispatchEvent(event);
    expect(action).not.toHaveBeenCalled();
  });
});

describe("MessageComposer — queue mode", () => {
  it("adds a chip when submitting while streaming", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "queued message");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    expect(screen.getByText("queued message")).toBeInTheDocument();
  });

  it("shows queued count while streaming", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "first");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    expect(screen.getByText("1 queued")).toBeInTheDocument();
  });

  it("clicking remove button removes the chip", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "to remove");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    expect(screen.getByText("to remove")).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Remove queued message 1" }),
    );
    expect(screen.queryByText("to remove")).not.toBeInTheDocument();
  });
});

describe("MessageComposer — interrupt mode", () => {
  it("calls onInterrupt and then action when submitting in interrupt mode", async () => {
    const action = makeAction();
    const onInterrupt = vi.fn();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="interrupt"
        onInterrupt={onInterrupt}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "interrupt this");
    await userEvent.click(
      screen.getByRole("button", { name: "Interrupt and send" }),
    );
    await waitFor(() => {
      expect(onInterrupt).toHaveBeenCalledTimes(1);
      expect(action).toHaveBeenCalledTimes(1);
    });
  });
});

describe("MessageComposer — queue drain", () => {
  it("dispatches queued message when isStreaming transitions to false", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    // Queue a message while streaming
    await userEvent.type(screen.getByRole("textbox"), "queued item");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    expect(action).not.toHaveBeenCalled();

    // Now stream ends
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
      />,
    );
    // Queue drain uses setTimeout(() => dispatch(fd), 0)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("content")).toBe("queued item");
  });

  it("encodes activeServerIds in queue-drain FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        availableMcpServers={[makeMcpServer({ publicId: "mcs_drain" })]}
      />,
    );
    // Activate a server
    await userEvent.click(screen.getByTestId("mcp-activate-first"));
    // Queue a message
    await userEvent.type(screen.getByRole("textbox"), "drain message");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    // End stream
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        availableMcpServers={[makeMcpServer({ publicId: "mcs_drain" })]}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(JSON.parse(fd.get("activeServerIds") as string)).toEqual([
      "mcs_drain",
    ]);
  });
});

describe("MessageComposer — media FormData encoding", () => {
  it("encodes generate=image and mediaTier in FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    await userEvent.type(screen.getByRole("textbox"), "a cat");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("generate")).toBe("image");
    expect(fd.get("mediaTier")).toBe("basic");
  });

  it("encodes generate=video and mediaTier in FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate video" }),
    );
    await userEvent.type(screen.getByRole("textbox"), "a sunset");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("generate")).toBe("video");
    expect(fd.get("mediaTier")).toBe("basic");
  });
});

describe("MessageComposer — keyboard guards", () => {
  it("enterToSubmit=true: Enter while disabled is a no-op", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
        disabled
      />,
    );
    const ta = screen.getByRole("textbox");
    // Dispatch a keydown event directly to trigger the onKeyDown handler
    const event = new KeyboardEvent("keydown", {
      key: "Enter",
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(event, "nativeEvent", {
      value: { isComposing: false },
    });
    Object.defineProperty(event, "currentTarget", {
      value: { value: "hello" },
    });
    ta.dispatchEvent(event);
    expect(action).not.toHaveBeenCalled();
  });

  it("Meta+Enter submits in enterToSubmit=false mode", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit={false}
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "hello");
    await userEvent.keyboard("{Meta>}{Enter}{/Meta}");
    await waitFor(() => expect(action).toHaveBeenCalled());
  });
});

describe("MessageComposer — queue drain with generate mode", () => {
  it("drains a queued image-mode message with generate=image in FormData", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    // Switch to image mode then queue a message
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    await userEvent.type(screen.getByRole("textbox"), "a castle");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    // End stream
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("generate")).toBe("image");
  });

  it("drains a queued message using ms.model when set", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        initialModelState={{
          tier: null,
          generate: null,
          model: "claude-opus-4-5",
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "opus query");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        initialModelState={{
          tier: null,
          generate: null,
          model: "claude-opus-4-5",
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("model")).toBe("claude-opus-4-5");
  });

  it("drains with conversationId and parentMessageId from refs", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId="conv-ref-1"
        parentMessageId="msg-ref-1"
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "ref test");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    // Update refs before drain
    rerender(
      <MessageComposer
        conversationId="conv-ref-2"
        parentMessageId="msg-ref-2"
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("conversationId")).toBe("conv-ref-2");
    expect(fd.get("parentMessageId")).toBe("msg-ref-2");
  });
});

describe("MessageComposer — effort control", () => {
  beforeEach(() => {
    mockSupportsReasoning.mockReturnValue(true);
  });
  afterEach(() => {
    mockSupportsReasoning.mockReturnValue(false);
  });

  it("effort is included in FormData when model supports reasoning", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: "precise",
          generate: null,
          model: null,
          effort: "high",
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "think hard");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("effort")).toBe("high");
  });
});

// ── branch-completion tests ────────────────────────────────────────────────────
// These tests are narrowly targeted at branches V8 detected as uncovered above.

describe("MessageComposer — model branch (explicit model.model)", () => {
  it("encodes model= in FormData when initialModelState has model set", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: null,
          generate: null,
          model: "claude-opus-4-5",
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "use opus");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("model")).toBe("claude-opus-4-5");
    expect(fd.get("tier")).toBeNull();
  });
});

describe("MessageComposer — seeded media model branch", () => {
  it("encodes mediaModel= when seededImageModel is set and image mode toggled on", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: "fast",
          generate: null,
          model: null,
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: "flux-2-max",
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    await userEvent.type(screen.getByRole("textbox"), "A landscape");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("mediaModel")).toBe("flux-2-max");
    expect(fd.get("mediaTier")).toBeNull();
  });
});

describe("MessageComposer — explicit mediaModel in FormData", () => {
  it("encodes mediaModel= when initialModelState has mediaModel set", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: null,
          generate: "image",
          model: null,
          effort: null,
          mediaTier: null,
          mediaModel: "gpt-image-1",
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "A cat");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("generate")).toBe("image");
    expect(fd.get("mediaModel")).toBe("gpt-image-1");
    expect(fd.get("mediaTier")).toBeNull();
  });
});

describe("MessageComposer — keyboard guard: disabled in onKeyDown", () => {
  it("Enter key while disabled=true in onKeyDown is a no-op", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        disabled
        enterToSubmit
      />,
    );
    const ta = screen.getByRole("textbox");
    // Dispatch the key event manually; userEvent.type respects disabled on <input>
    // but our custom Textarea mock renders a plain textarea that isn't disabled.
    await act(async () => {
      ta.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(action).not.toHaveBeenCalled();
  });
});

// ── proper queue-drain branch tests (replace broken dispatchEvent versions) ─────

describe("MessageComposer — null tier in initialModelState", () => {
  it("uses 'fast' tier fallback when tier is null", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: null,
          generate: null,
          model: null,
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "null tier test");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    // tier=null falls back to "fast" in buildFormData (covers tier ?? "fast" branches)
    expect(fd.get("tier")).toBe("fast");
  });
});

describe("MessageComposer — null mediaTier fallback in buildFormData", () => {
  it("uses 'basic' mediaTier fallback when mediaTier is null and no mediaModel", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        initialModelState={{
          tier: "fast",
          generate: "image",
          model: null,
          effort: null,
          mediaTier: null,
          mediaModel: null,
          seededImageModel: null,
          seededVideoModel: null,
          budgetEnabled: false,
          budgetUsd: null,
          budgetMode: "prompt",
          budgetGracePct: 0.25,
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "image null mediaTier");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("generate")).toBe("image");
    // mediaTier=null falls back to "basic" (covers mediaTier ?? "basic" branch)
    expect(fd.get("mediaTier")).toBe("basic");
  });
});

describe("MessageComposer — onSubmit disabled guard", () => {
  it("onSubmit returns early when disabled=true (via fireEvent.submit)", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        disabled
      />,
    );
    const form = screen.getByRole("textbox").closest("form")!;
    // fireEvent.submit properly triggers the React synthetic onSubmit handler
    fireEvent.submit(form);
    expect(action).not.toHaveBeenCalled();
  });
});

describe("MessageComposer — onKeyDown disabled+content guard", () => {
  it("Enter key with content while disabled=true exits early at pending||disabled guard", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        enterToSubmit
        disabled
      />,
    );
    const ta = screen.getByRole("textbox");
    // Set textarea value directly (userEvent.type respects disabled; fireEvent.change does not)
    fireEvent.change(ta, { target: { value: "some content" } });
    // Fire Enter — isEmpty is false so we reach the pending||disabled guard on line 301
    fireEvent.keyDown(ta, { key: "Enter", bubbles: true, cancelable: true });
    expect(action).not.toHaveBeenCalled();
  });
});

describe("MessageComposer — queue drain: null tier fallback", () => {
  it("uses 'fast' tier fallback when draining a queued message with tier=null", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const nullTierState = {
      tier: null as null,
      generate: null as null,
      model: null as null,
      effort: null as null,
      mediaTier: null as null,
      mediaModel: null as null,
      seededImageModel: null as null,
      seededVideoModel: null as null,
      budgetEnabled: false as const,
      budgetUsd: null as null,
      budgetMode: "prompt" as const,
      budgetGracePct: 0.25 as const,
    };
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        initialModelState={nullTierState}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "null tier queued");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        initialModelState={nullTierState}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    // Drain path: ms.tier=null → ms.tier ?? "fast" = "fast" (covers lines 251, 253)
    expect(fd.get("tier")).toBe("fast");
  });
});

describe("MessageComposer — queue drain: mediaModel set", () => {
  it("encodes mediaModel in drained FormData when ms.mediaModel is set", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const mediaModelState = {
      tier: "fast" as const,
      generate: "image" as const,
      model: null as null,
      effort: null as null,
      mediaTier: null as null,
      mediaModel: "flux-2-max",
      seededImageModel: null as null,
      seededVideoModel: null as null,
      budgetEnabled: false as const,
      budgetUsd: null as null,
      budgetMode: "prompt" as const,
      budgetGracePct: 0.25 as const,
    };
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        initialModelState={mediaModelState}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "image with mediaModel");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        initialModelState={mediaModelState}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    // Drain path: ms.mediaModel is set → fd.set("mediaModel", ...) (covers line 260-261)
    expect(fd.get("generate")).toBe("image");
    expect(fd.get("mediaModel")).toBe("flux-2-max");
  });
});

describe("MessageComposer — queue drain: null mediaTier fallback", () => {
  it("uses 'basic' mediaTier fallback when draining a queued message with null mediaTier", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const nullMediaTierState = {
      tier: "fast" as const,
      generate: "image" as const,
      model: null as null,
      effort: null as null,
      mediaTier: null as null,
      mediaModel: null as null,
      seededImageModel: null as null,
      seededVideoModel: null as null,
      budgetEnabled: false as const,
      budgetUsd: null as null,
      budgetMode: "prompt" as const,
      budgetGracePct: 0.25 as const,
    };
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        initialModelState={nullMediaTierState}
      />,
    );
    await userEvent.type(
      screen.getByRole("textbox"),
      "image null mediaTier drain",
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        initialModelState={nullMediaTierState}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    // Drain path: ms.mediaTier=null → ms.mediaTier ?? "basic" = "basic" (covers line 263)
    expect(fd.get("generate")).toBe("image");
    expect(fd.get("mediaTier")).toBe("basic");
  });
});

describe("MessageComposer — queue drain: effort in drained message", () => {
  it("encodes effort when ms.effort is set and model supports reasoning", async () => {
    mockSupportsReasoning.mockReturnValue(true);
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const effortState = {
      tier: "precise" as const,
      generate: null as null,
      model: null as null,
      effort: "high" as const,
      mediaTier: null as null,
      mediaModel: null as null,
      seededImageModel: null as null,
      seededVideoModel: null as null,
      budgetEnabled: false as const,
      budgetUsd: null as null,
      budgetMode: "prompt" as const,
      budgetGracePct: 0.25 as const,
    };
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
        initialModelState={effortState}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "reasoning drain");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
        initialModelState={effortState}
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    // Drain path: supportsReasoning=true && ms.effort="high" → fd.set("effort", "high") (lines 254-255)
    expect(fd.get("effort")).toBe("high");
    mockSupportsReasoning.mockReturnValue(false);
  });
});

// ── queue management: reorder / edit / send-now / multi-drain ───────────────────

describe("MessageComposer — queue management", () => {
  async function queueTwo() {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const utils = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "alpha");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    await userEvent.type(ta, "beta");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    return { action, ...utils };
  }

  it("renders queued messages as an ordered list", async () => {
    await queueTwo();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText("beta")).toBeInTheDocument();
    expect(screen.getByText("2 messages queued")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
  });

  it("reorders: moving the second item up swaps the order", async () => {
    await queueTwo();
    // Before: [alpha, beta] → item 1 = alpha, item 2 = beta.
    await userEvent.click(
      screen.getByRole("button", { name: "Move queued message 2 up" }),
    );
    // After: [beta, alpha] → item 1 button label now references beta.
    expect(
      screen.getByRole("button", { name: /Edit queued message 1: beta/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edit queued message 2: alpha/ }),
    ).toBeInTheDocument();
  });

  it("reorders: moving the first item down swaps the order", async () => {
    await queueTwo();
    await userEvent.click(
      screen.getByRole("button", { name: "Move queued message 1 down" }),
    );
    expect(
      screen.getByRole("button", { name: /Edit queued message 1: beta/ }),
    ).toBeInTheDocument();
  });

  it("edits a queued message's content inline", async () => {
    await queueTwo();
    await userEvent.click(
      screen.getByRole("button", { name: "Edit queued message 1" }),
    );
    const editor = screen.getByRole("textbox", {
      name: "Edit queued message 1",
    });
    await userEvent.clear(editor);
    await userEvent.type(editor, "alpha-edited");
    fireEvent.keyDown(editor, { key: "Enter" });
    expect(screen.getByText("alpha-edited")).toBeInTheDocument();
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
  });

  it("send-now while streaming promotes the item to the front of the queue", async () => {
    await queueTwo();
    // Send-now on item 2 (beta) → it jumps to position 1.
    await userEvent.click(
      screen.getByRole("button", { name: "Send queued message 2 now" }),
    );
    expect(
      screen.getByRole("button", { name: /Edit queued message 1: beta/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Edit queued message 2: alpha/ }),
    ).toBeInTheDocument();
  });

  it("send-now while NOT streaming dispatches the item immediately", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { rerender } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "alpha");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    await userEvent.type(screen.getByRole("textbox"), "beta");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    // Stream ends; the head (alpha) drains automatically. Re-render with the
    // post-drain streaming=true (drain restarts the stream).
    rerender(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming={false}
        pendingPromptBehavior="queue"
      />,
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0][0] as FormData).get("content")).toBe("alpha");

    // beta remains queued; send it now (not streaming) → dispatches immediately.
    await userEvent.click(
      screen.getByRole("button", { name: "Send queued message 1 now" }),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect((action.mock.calls[1][0] as FormData).get("content")).toBe("beta");
  });

  it("drains the FULL queue sequentially across stream toggles", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const baseProps = {
      conversationId: null,
      parentMessageId: null,
      action,
      modelConfig: DEFAULT_MODEL_CONFIG,
      pendingPromptBehavior: "queue" as const,
    };
    const { rerender } = render(<MessageComposer {...baseProps} isStreaming />);
    const ta = screen.getByRole("textbox");
    await userEvent.type(ta, "one");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );
    await userEvent.type(ta, "two");
    await userEvent.click(
      screen.getByRole("button", { name: "Queue message" }),
    );

    // Turn 1 ends → drains "one".
    rerender(<MessageComposer {...baseProps} isStreaming={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0][0] as FormData).get("content")).toBe("one");

    // Drain restarted the stream → simulate isStreaming true then false again.
    rerender(<MessageComposer {...baseProps} isStreaming />);
    rerender(<MessageComposer {...baseProps} isStreaming={false} />);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect((action.mock.calls[1][0] as FormData).get("content")).toBe("two");
  });

  it("does not render the queue panel when the queue is empty", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        isStreaming
        pendingPromptBehavior="queue"
      />,
    );
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
    expect(screen.queryByText(/messages? queued/)).not.toBeInTheDocument();
  });
});

// ── attachments ──────────────────────────────────────────────────────────────

/**
 * Minimal fake XMLHttpRequest — message-composer.tsx uses XHR (not fetch) so
 * it can report upload progress. Each `send()` call is captured in
 * `FakeXHR.instances` so a test can manually resolve it with `respond()`.
 */
class FakeXHR {
  static instances: FakeXHR[] = [];
  upload: {
    onprogress:
      | ((e: {
          lengthComputable: boolean;
          loaded: number;
          total: number;
        }) => void)
      | null;
  } = {
    onprogress: null,
  };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  status = 0;
  responseText = "";
  aborted = false;
  method = "";
  url = "";
  body: FormData | null = null;

  open(method: string, url: string): void {
    this.method = method;
    this.url = url;
  }
  send(body: FormData): void {
    this.body = body;
    FakeXHR.instances.push(this);
  }
  abort(): void {
    this.aborted = true;
    this.onabort?.();
  }
  /** Test helper: resolve this request as if the server responded. */
  respond(status: number, json: unknown): void {
    this.status = status;
    this.responseText = JSON.stringify(json);
    this.onload?.();
  }
}

const UPLOADED_ITEM = {
  publicId: "gen_abc123",
  kind: "image",
  name: "photo.png",
  mimeType: "image/png",
  url: "/api/v1/assets/gen_abc123",
};

describe("MessageComposer — attachments", () => {
  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal("XMLHttpRequest", FakeXHR);
    URL.createObjectURL = vi.fn(() => "blob:mock-preview");
    URL.revokeObjectURL = vi.fn();
    // Default: no keyframes (image-only tests never attach a video).
    mockExtractVideoFrames.mockResolvedValue([]);
  });

  it("hides the attach button when orgSlug/workspaceSlug are not provided", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Attach image or video" }),
    ).not.toBeInTheDocument();
  });

  it("shows the attach button when orgSlug/workspaceSlug are provided", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Attach image or video" }),
    ).toBeInTheDocument();
  });

  it("uploads a picked file, shows progress, then renders the sent chip", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const file = new File(["bytes"], "photo.png", { type: "image/png" });
    await user.upload(fileInput, file);

    const chip = await screen.findByTestId("attachment-chip");
    expect(chip).toHaveAttribute("data-status", "uploading");
    expect(FakeXHR.instances).toHaveLength(1);
    expect(FakeXHR.instances[0]!.url).toBe("/api/v1/upload/attachment");
    expect(FakeXHR.instances[0]!.body?.get("kind")).toBe("image");
    expect(FakeXHR.instances[0]!.body?.get("orgSlug")).toBe("acme");
    expect(FakeXHR.instances[0]!.body?.get("workspaceSlug")).toBe("main");

    // Server responds with the persisted asset.
    act(() => {
      FakeXHR.instances[0]!.respond(201, UPLOADED_ITEM);
    });

    await waitFor(() =>
      expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
        "data-status",
        "uploaded",
      ),
    );
  });

  it("disables the send button while an upload is in flight", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );

    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();

    act(() => {
      FakeXHR.instances[0]!.respond(201, UPLOADED_ITEM);
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toBeDisabled(),
    );
  });

  it("includes the uploaded attachment in the submitted FormData", async () => {
    const user = userEvent.setup();
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );
    act(() => {
      FakeXHR.instances[0]!.respond(201, UPLOADED_ITEM);
    });
    await waitFor(() =>
      expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
        "data-status",
        "uploaded",
      ),
    );

    await user.type(screen.getByRole("textbox"), "check this out");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    const attachmentsRaw = fd.get("attachments") as string;
    expect(JSON.parse(attachmentsRaw)).toEqual([UPLOADED_ITEM]);

    // The pending strip clears after a successful send.
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });

  it("removing a chip mid-upload aborts the XHR and drops the attachment", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );
    await screen.findByTestId("attachment-chip");

    await user.click(
      screen.getByRole("button", { name: /remove photo\.png/i }),
    );

    expect(FakeXHR.instances[0]!.aborted).toBe(true);
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });

  it("shows an error chip when the upload fails", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );
    act(() => {
      FakeXHR.instances[0]!.respond(415, { error: "Unsupported image type" });
    });

    await waitFor(() =>
      expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
        "data-status",
        "error",
      ),
    );
  });

  it("attaches a video as one visible chip and uploads its sampled keyframes hidden", async () => {
    const user = userEvent.setup();
    mockExtractVideoFrames.mockResolvedValue([
      { blob: new Blob(["f1"], { type: "image/webp" }), atSeconds: 1 },
      { blob: new Blob(["f2"], { type: "image/webp" }), atSeconds: 2 },
    ]);
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["v"], "clip.mp4", { type: "video/mp4" }),
    );

    // The video uploads as kind=video and its keyframes upload as kind=image.
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(3));
    expect(FakeXHR.instances[0]!.body?.get("kind")).toBe("video");
    expect(FakeXHR.instances[1]!.body?.get("kind")).toBe("image");
    expect(FakeXHR.instances[2]!.body?.get("kind")).toBe("image");

    // Only the video shows a chip; the keyframes are hidden derived attachments.
    expect(screen.getAllByTestId("attachment-chip")).toHaveLength(1);
  });

  it("links keyframes to their video via keyframeForVideo in the submitted FormData", async () => {
    const user = userEvent.setup();
    const action = makeAction();
    mockExtractVideoFrames.mockResolvedValue([
      { blob: new Blob(["f1"], { type: "image/webp" }), atSeconds: 1 },
      { blob: new Blob(["f2"], { type: "image/webp" }), atSeconds: 2 },
    ]);
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["v"], "clip.mp4", { type: "video/mp4" }),
    );
    await waitFor(() => expect(FakeXHR.instances).toHaveLength(3));

    act(() => {
      FakeXHR.instances[0]!.respond(201, {
        publicId: "gen_vid",
        kind: "video",
        name: "clip.mp4",
        mimeType: "video/mp4",
        url: "/api/v1/assets/gen_vid",
      });
      FakeXHR.instances[1]!.respond(201, {
        publicId: "gen_kf1",
        kind: "image",
        name: "clip-frame-1.webp",
        mimeType: "image/webp",
        url: "/api/v1/assets/gen_kf1",
      });
      FakeXHR.instances[2]!.respond(201, {
        publicId: "gen_kf2",
        kind: "image",
        name: "clip-frame-2.webp",
        mimeType: "image/webp",
        url: "/api/v1/assets/gen_kf2",
      });
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toBeDisabled(),
    );

    await user.type(screen.getByRole("textbox"), "what happens in this clip?");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    const parsed = JSON.parse(fd.get("attachments") as string) as Array<{
      publicId: string;
      kind: string;
      keyframeForVideo?: string;
    }>;
    expect(parsed).toEqual([
      expect.objectContaining({ publicId: "gen_vid", kind: "video" }),
      expect.objectContaining({
        publicId: "gen_kf1",
        kind: "image",
        keyframeForVideo: "gen_vid",
      }),
      expect.objectContaining({
        publicId: "gen_kf2",
        kind: "image",
        keyframeForVideo: "gen_vid",
      }),
    ]);
    // The video carries no keyframeForVideo of its own.
    expect(parsed[0]!.keyframeForVideo).toBeUndefined();
  });

  it("shows an inline size error and never uploads a file over the kind's limit", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    // Images cap at 5 MiB (packages/storage/src/assets.ts ASSET_LIMITS.image).
    const oversizeBytes = new Uint8Array(5 * 1024 * 1024 + 1);
    const oversized = new File([oversizeBytes], "huge.png", {
      type: "image/png",
    });
    await user.upload(fileInput, oversized);

    expect(
      screen.getByTestId("attachment-size-error"),
    ).toHaveTextContent("That file is over 5 MB. Try a smaller one.");
    // Never dispatched — the pre-check rejects it before any XHR is opened.
    expect(FakeXHR.instances).toHaveLength(0);
    expect(screen.queryByTestId("attachment-chip")).not.toBeInTheDocument();
  });

  it("clears the size error once a valid file is picked afterward", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const oversized = new File(
      [new Uint8Array(5 * 1024 * 1024 + 1)],
      "huge.png",
      { type: "image/png" },
    );
    await user.upload(fileInput, oversized);
    expect(screen.getByTestId("attachment-size-error")).toBeInTheDocument();

    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );
    expect(screen.queryByTestId("attachment-size-error")).not.toBeInTheDocument();
  });

  it("retrying a failed upload re-sends the same file and kind, and can succeed", async () => {
    const user = userEvent.setup();
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );

    const fileInput = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    await user.upload(
      fileInput,
      new File(["bytes"], "photo.png", { type: "image/png" }),
    );
    act(() => {
      FakeXHR.instances[0]!.respond(415, { error: "Unsupported image type" });
    });
    await waitFor(() =>
      expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
        "data-status",
        "error",
      ),
    );

    await user.click(
      screen.getByRole("button", { name: /retry upload for photo\.png/i }),
    );

    // Retry re-sends through the SAME upload pipeline: a fresh XHR, same kind.
    expect(FakeXHR.instances).toHaveLength(2);
    expect(FakeXHR.instances[1]!.body?.get("kind")).toBe("image");
    expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
      "data-status",
      "uploading",
    );

    act(() => {
      FakeXHR.instances[1]!.respond(201, UPLOADED_ITEM);
    });
    await waitFor(() =>
      expect(screen.getByTestId("attachment-chip")).toHaveAttribute(
        "data-status",
        "uploaded",
      ),
    );
  });
});

// ── code mode ──────────────────────────────────────────────────────────────────
//
// ComposerContextControls/RepoSelector/EnvironmentSelector are NOT mocked here
// — they render for real on top of the shared `@/components/ui/select` mock above,
// whose onValueChange always fires with "high" (see the reasoning-effort
// tests). A single-repo fixture with key "high" lets a click on the repo
// Select resolve deterministically through that shared mock.
const CODE_REPO = {
  key: "high",
  connectionId: "con_1",
  owner: "acme",
  name: "widgets",
  defaultBranch: "main",
};
const CODE_ENV_DEFAULT = {
  id: "env_default",
  name: "Default",
  isDefault: true,
};

// Code mode is governed SOLELY by the selected agent's identity — there is no
// manual toggle. These fixtures drive it via the stubbed AgentContextChip's
// `pick-agt_code` / `pick-agt_chat` buttons (see the mock at the top).
const CODE_AGENT = {
  agentId: "agt_code",
  slug: "coder",
  name: "Coder",
  description: null,
  agentType: "code",
  isCode: true,
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};
const CHAT_AGENT = {
  agentId: "agt_chat",
  slug: "chatter",
  name: "Chatter",
  description: null,
  agentType: "custom",
  isCode: false,
  avatarUrl: null,
  summary: null,
  managed: false,
  toolRefs: [],
};
// A second repo used to prove the "exactly one obvious default" auto-fill rule:
// with >1 repo and no default, code mode must NOT auto-pick a repo.
const CODE_REPO_2 = {
  key: "second",
  connectionId: "con_2",
  owner: "acme",
  name: "docs",
  defaultBranch: "main",
};

describe("MessageComposer — code mode (agent-governed)", () => {
  it("keeps code-mode pickers hidden for a chat agent (pin mode, not code)", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_chat"));
    // A chat agent forces code mode off — the compact controls stay in pin mode
    // (the code-mode "Select repository" label must not appear).
    expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
      "data-mode",
      "pin",
    );
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).toBeNull();
  });

  it("selecting a code agent reveals the repo + environment pickers with code labels", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Select repository"]'),
      ).not.toBeNull(),
    );
    expect(
      container.querySelector('[aria-label="Select environment"]'),
    ).not.toBeNull();
    expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
      "data-mode",
      "code",
    );
  });

  it("auto-fills the sole repo + default environment and opens the send gate for a code agent", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "fix the bug");
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    // The sole repo + the isDefault environment both auto-fill, so the gate
    // opens without any manual selection — the user just SEES the target.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toBeDisabled(),
    );
    expect(screen.queryByTestId("code-mode-gate-hint")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    const code = JSON.parse(fd.get("code") as string) as Record<string, unknown>;
    expect(code).toEqual({
      connectionId: "con_1",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
      environmentId: "env_default",
      environmentName: "Default",
      sandboxSessionId: null,
    });
    // The bound agent id rides along too.
    expect(fd.get("agentId")).toBe("agt_code");
  });

  it("does NOT auto-fill a repo when there is more than one and no default (gate stays blocked)", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO, CODE_REPO_2]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "fix the bug");
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    // Environment auto-fills (isDefault) but the repo is ambiguous (2 options,
    // no default) — the gate stays blocked until the user picks a repo.
    await waitFor(() =>
      expect(
        screen.getByTestId("code-mode-gate-hint"),
      ).toHaveTextContent("Select a repository and environment to start coding."),
    );
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
  });

  it("blocks send with a hint for a code agent when no environment is available", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[]}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "fix the bug");
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    // The sole repo auto-fills, but there is no environment to pick — the gate
    // stays blocked. A coding agent REQUIRES both a repo and an environment.
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).toBeDisabled(),
    );
    expect(screen.getByTestId("code-mode-gate-hint")).toHaveTextContent(
      "Select a repository and environment to start coding.",
    );
  });

  it("does NOT encode a code field for a chat agent (code mode off)", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_chat"));
    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("code")).toBeNull();
  });

  it("locks the agent + repo + environment pickers after a code turn is sent", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    await userEvent.type(screen.getByRole("textbox"), "fix the bug");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Send message" }),
      ).not.toBeDisabled(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    // After the first code turn the pickers lock: the composer passes locked=true
    // down to the agent chip (mocked here → data-locked) and to the context
    // controls (real → data-locked + a locked wrapper on each selector).
    await waitFor(() =>
      expect(screen.getByTestId("agent-selector")).toHaveAttribute(
        "data-locked",
        "true",
      ),
    );
    expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
      "data-locked",
      "true",
    );
    // The repo/env selectors are wrapped with the locked hint affordance.
    expect(
      screen.getAllByTestId("locked-context-control").length,
    ).toBeGreaterThan(0);
    const lockedRepo = container.querySelector('[aria-label="Select repository"]');
    expect(lockedRepo).not.toBeNull();
  });
});

// ── collapsible composer (OXA mobile-agent-ux) ─────────────────────────────────

const COLLAPSED_KEY = "oxagen.chat.composerCollapsed";

describe("MessageComposer — collapsible composer", () => {
  it("starts expanded and collapses via the toggle, persisting the preference", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    const ta = screen.getByRole("textbox");
    expect(ta.className).not.toContain("hidden");
    expect(screen.queryByTestId("composer-expand-affordance")).toBeNull();

    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));

    expect(ta.className).toContain("hidden");
    expect(
      screen.getByTestId("composer-expand-affordance"),
    ).toBeInTheDocument();
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("1");
    // Send stays reachable in the slim row.
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
  });

  it("expands via the affordance, restores the textarea, and focuses it", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));
    await userEvent.click(screen.getByTestId("composer-expand-affordance"));

    const ta = screen.getByRole("textbox");
    expect(ta.className).not.toContain("hidden");
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("0");
    // Focus lands on the frame after the expanded layout commits (rAF).
    await waitFor(() => expect(ta).toHaveFocus());
  });

  it("restores the persisted collapsed state on mount (hydration-safe)", async () => {
    window.localStorage.setItem(COLLAPSED_KEY, "1");
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    expect(
      screen.getByTestId("composer-expand-affordance"),
    ).toBeInTheDocument();
    expect(screen.getByRole("textbox").className).toContain("hidden");
  });

  it("exports the storage key used for persistence", async () => {
    const { COMPOSER_COLLAPSED_STORAGE_KEY } = await import(
      "./message-composer"
    );
    expect(COMPOSER_COLLAPSED_STORAGE_KEY).toBe(COLLAPSED_KEY);
  });

  it("keeps the draft and submits it while collapsed", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(
      screen.getByRole("textbox"),
      "draft survives collapse",
    );
    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("content")).toBe("draft survives collapse");
  });

  it("auto-expands when a printable key is pressed outside editable controls", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));
    expect(
      screen.getByTestId("composer-expand-affordance"),
    ).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "a" });

    await waitFor(() =>
      expect(screen.queryByTestId("composer-expand-affordance")).toBeNull(),
    );
    expect(window.localStorage.getItem(COLLAPSED_KEY)).toBe("0");
  });

  it("does NOT auto-expand on modifier combos or non-printable keys", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));

    fireEvent.keyDown(document.body, { key: "Escape" });
    fireEvent.keyDown(document.body, { key: "a", ctrlKey: true });
    fireEvent.keyDown(document.body, { key: "c", metaKey: true });

    expect(
      screen.getByTestId("composer-expand-affordance"),
    ).toBeInTheDocument();
  });

  it("hides the code-mode agent toolbar and gate hint while collapsed", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    await waitFor(() =>
      expect(
        container.querySelector('[aria-label="Select repository"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByTestId("code-mode-gate-hint")).toBeInTheDocument();

    await userEvent.click(screen.getByTestId("composer-collapse-toggle"));
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).toBeNull();
    expect(screen.queryByTestId("code-mode-gate-hint")).toBeNull();
  });
});

describe("MessageComposer — compact context controls in code mode", () => {
  it("shows the compact context controls in code mode with 'Select …' labels and no pin toggle", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    const controls = screen.getByTestId("composer-context-controls");
    expect(controls).toHaveAttribute("data-mode", "code");
    // Code mode uses the default "Select …" labels for the compact selectors.
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Select environment"]'),
    ).not.toBeNull();
    // Both selections are required to send in code mode, so no pin affordance.
    expect(screen.queryByTestId("pin-to-chat")).toBeNull();
  });
});

// ── mobile toolbar (OXA mobile-agent-ux) ───────────────────────────────────────

describe("MessageComposer — mobile toolbar", () => {
  beforeEach(() => {
    mockViewport.isMobile = true;
  });
  afterEach(() => {
    mockViewport.isMobile = false;
  });

  it("keeps only the essentials inline and moves the rest behind the overflow button", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer()]}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    // Essentials inline (there is no manual code toggle anymore — code mode is
    // agent-governed):
    expect(
      screen.getByRole("button", { name: "Attach image or video" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Toggle code mode" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Send message" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("composer-overflow-btn")).toBeInTheDocument();
    // Overflow controls NOT inline (sheet is closed):
    expect(screen.queryByTestId("model-picker")).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate image" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Generate video" })).toBeNull();
    expect(screen.queryByTestId("mcp-server-picker")).toBeNull();
    expect(screen.queryByTestId("budget-control")).toBeNull();
  });

  it("opens the bottom sheet with the overflow controls", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer()]}
      />,
    );
    expect(screen.queryByTestId("composer-overflow-sheet")).toBeNull();
    await userEvent.click(screen.getByTestId("composer-overflow-btn"));
    expect(screen.getByTestId("composer-overflow-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("model-picker")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate image" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate video" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mcp-server-picker")).toBeInTheDocument();
    expect(screen.getByTestId("budget-control")).toBeInTheDocument();
  });

  it("toggling image generation from the sheet switches the composer to image mode", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.click(screen.getByTestId("composer-overflow-btn"));
    await userEvent.click(
      screen.getByRole("button", { name: "Generate image" }),
    );
    expect(
      screen.getByPlaceholderText("Describe the image you want…"),
    ).toBeInTheDocument();
  });

  it("uses a 2-row textarea and 44px inline touch targets on mobile", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="main"
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("rows", "2");
    expect(
      screen.getByRole("button", { name: "Attach image or video" }).className,
    ).toContain("h-11");
  });

  it("keeps a 3-row textarea and the full inline control row on desktop", async () => {
    mockViewport.isMobile = false;
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableMcpServers={[makeMcpServer()]}
      />,
    );
    expect(screen.getByRole("textbox")).toHaveAttribute("rows", "3");
    expect(screen.getByTestId("model-picker")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Generate image" }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("mcp-server-picker")).toBeInTheDocument();
    expect(screen.getByTestId("budget-control")).toBeInTheDocument();
    expect(screen.queryByTestId("composer-overflow-btn")).toBeNull();
  });
});

describe("MessageComposer — pin context & slash commands", () => {
  // Pin persistence writes to localStorage keyed by a workspace-scoped draft
  // key. Clear it between tests so a pin written by one test can't rehydrate
  // (and auto-select/auto-pin) in the next.
  beforeEach(() => {
    try {
      window.localStorage.clear();
    } catch {
      // jsdom without a real localStorage — pinning degrades to in-memory,
      // which is exactly what these single-render assertions exercise.
    }
  });

  it("renders the compact context controls in PIN mode when NOT in code mode and repos are available", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    const controls = screen.getByTestId("composer-context-controls");
    expect(controls).toHaveAttribute("data-mode", "pin");
    // Pin mode's selectors use the "Pinned …" labels and expose the pin toggle;
    // the code-mode "Select repository" label must NOT be present yet.
    expect(
      container.querySelector('[aria-label="Pinned repository"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).toBeNull();
    expect(screen.getByTestId("pin-to-chat")).toBeInTheDocument();
  });

  it("switches the controls from pin mode to code mode once a code agent is selected", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
      "data-mode",
      "pin",
    );

    fireEvent.click(screen.getByTestId("pick-agt_code"));

    // Same single control row, now in code mode (default "Select …" labels, no pin).
    await waitFor(() =>
      expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
        "data-mode",
        "code",
      ),
    );
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).not.toBeNull();
    expect(screen.queryByTestId("pin-to-chat")).toBeNull();
  });

  it("opens the slash-command menu when the input is a lone slash token", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "/");
    expect(await screen.findByTestId("slash-command-menu")).toBeInTheDocument();
  });

  it("filters the slash menu to the matching command as the query narrows", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "/ci");
    const options = await screen.findAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("/ci");
  });

  it("closes the slash menu when the input is no longer a lone slash token", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "/");
    expect(screen.getByTestId("slash-command-menu")).toBeInTheDocument();
    // Typing normal text after the slash (a space breaks the lone-slash token).
    await userEvent.type(textbox, " deploy the app");
    await waitFor(() =>
      expect(
        screen.queryByTestId("slash-command-menu"),
      ).not.toBeInTheDocument(),
    );
  });

  it("closes the slash menu when Escape is pressed", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
      />,
    );
    const textbox = screen.getByRole("textbox");
    await userEvent.type(textbox, "/");
    expect(screen.getByTestId("slash-command-menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByTestId("slash-command-menu"),
      ).not.toBeInTheDocument(),
    );
  });

  it("encodes pinnedContext in FormData when a repo is pinned (not code mode)", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    // Select the repo via the context bar's repo selector (the first Select;
    // the shared Select mock fires onValueChange("high") === CODE_REPO.key).
    const repoSelect = screen.getAllByTestId("select")[0];
    expect(repoSelect).toBeDefined();
    await userEvent.click(repoSelect!);

    // Pin the selection — enabled now that a repo is chosen.
    const pinButton = screen.getByTestId("pin-to-chat");
    await waitFor(() => expect(pinButton).not.toBeDisabled());
    await userEvent.click(pinButton);

    await userEvent.type(screen.getByRole("textbox"), "look at this repo");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    const pinned = JSON.parse(fd.get("pinnedContext") as string) as {
      repo: {
        connectionId: string;
        owner: string;
        name: string;
        defaultBranch: string | null;
      } | null;
      environment: { id: string; name: string } | null;
    };
    expect(pinned.repo).toEqual({
      connectionId: "con_1",
      owner: "acme",
      name: "widgets",
      defaultBranch: "main",
    });
  });

  it("does NOT encode pinnedContext when nothing is pinned", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    // Select a repo but leave it unpinned — pinnedContext only rides along when
    // the selection is explicitly pinned.
    const repoSelect = screen.getAllByTestId("select")[0];
    expect(repoSelect).toBeDefined();
    await userEvent.click(repoSelect!);

    await userEvent.type(screen.getByRole("textbox"), "hello");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("pinnedContext")).toBeNull();
  });
});

describe("MessageComposer — agent selection gating", () => {
  it("shows no agent selector and no code toggle when no agents exist", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    // The manual code toggle is gone entirely — code mode is agent-governed, and
    // an agentless workspace can never enter it.
    expect(
      screen.queryByRole("button", { name: "Toggle code mode" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByTestId("agent-selector")).not.toBeInTheDocument();
    // With no code agent, the compact controls stay in pin mode (no code labels).
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).toBeNull();
  });

  it("renders the agent selector (and no manual toggle) when agents exist", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
      />,
    );
    expect(screen.getByTestId("agent-selector")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Toggle code mode" }),
    ).not.toBeInTheDocument();
  });

  it("selecting a code agent turns code mode ON (code pickers appear)", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    await waitFor(() =>
      expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
        "data-mode",
        "code",
      ),
    );
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).not.toBeNull();
  });

  it("selecting a chat agent keeps code mode OFF (pin mode)", async () => {
    const { MessageComposer } = await import("./message-composer");
    const { container } = render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_chat"));
    expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
      "data-mode",
      "pin",
    );
    expect(
      container.querySelector('[aria-label="Select repository"]'),
    ).toBeNull();
  });

  it("re-selecting the default (no agent) turns code mode OFF again", async () => {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={makeAction()}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
        availableRepos={[CODE_REPO]}
        availableEnvironments={[CODE_ENV_DEFAULT]}
      />,
    );
    fireEvent.click(screen.getByTestId("pick-agt_code"));
    await waitFor(() =>
      expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
        "data-mode",
        "code",
      ),
    );
    fireEvent.click(screen.getByTestId("pick-default"));
    await waitFor(() =>
      expect(screen.getByTestId("composer-context-controls")).toHaveAttribute(
        "data-mode",
        "pin",
      ),
    );
  });

  it("forwards the selected agentId in the submit payload", async () => {
    const action = makeAction();
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        availableAgents={[CODE_AGENT, CHAT_AGENT]}
      />,
    );
    // A chat agent keeps code mode off, so send isn't gated on a repo/env.
    fireEvent.click(screen.getByTestId("pick-agt_chat"));
    await userEvent.type(screen.getByRole("textbox"), "hi");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalled());
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("agentId")).toBe("agt_chat");
  });
});

describe("MessageComposer — @-mentions", () => {
  const FILE_ROW = {
    type: "file",
    slug: "apps/app/src/proxy.ts",
    location: "apps/app/src/proxy.ts",
    label: "proxy.ts",
    description: "Source file",
    properties: { path: "apps/app/src/proxy.ts" },
  };

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ results: [FILE_ROW] }),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function renderMentionComposer(action = makeAction()) {
    const { MessageComposer } = await import("./message-composer");
    render(
      <MessageComposer
        conversationId={null}
        parentMessageId={null}
        action={action}
        modelConfig={DEFAULT_MODEL_CONFIG}
        orgSlug="acme"
        workspaceSlug="default"
      />,
    );
    return { action, textarea: screen.getByRole("textbox") };
  }

  it("typing @ opens the type menu and a prefix filters it", async () => {
    const { textarea } = await renderMentionComposer();
    await userEvent.type(textarea, "@");
    expect(screen.getByTestId("mention-menu")).toBeTruthy();
    expect(screen.getByTestId("mention-type-repository")).toBeTruthy();
    expect(screen.getByTestId("mention-type-node")).toBeTruthy();

    await userEvent.type(textarea, "cap");
    expect(screen.getByTestId("mention-type-capability")).toBeTruthy();
    expect(screen.queryByTestId("mention-type-repository")).toBeNull();
  });

  it("does not trigger mid-word (email addresses stay plain text)", async () => {
    const { textarea } = await renderMentionComposer();
    await userEvent.type(textarea, "mac@ox");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
  });

  it("Escape dismisses the menu without inserting anything", async () => {
    const { textarea } = await renderMentionComposer();
    await userEvent.type(textarea, "@");
    expect(screen.getByTestId("mention-menu")).toBeTruthy();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe("@");
  });

  it("keyboard flow: type filter → Enter → scoped search → Enter inserts placeholder + chip, submit carries the token", async () => {
    const { action, textarea } = await renderMentionComposer();
    // "@fil" narrows the type list to Files; Enter enters search stage.
    await userEvent.type(textarea, "@fil");
    expect(screen.getByTestId("mention-type-file")).toBeTruthy();
    await userEvent.keyboard("{Enter}");
    // The typed filter is reset to a bare "@" and the scoped search runs
    // (empty-query browse) — the mocked /api/reference-search returns one row.
    await waitFor(
      () => expect(screen.getByTestId("mention-result-0")).toBeTruthy(),
      {
        timeout: 3_000,
      },
    );
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe("/api/reference-search");

    await userEvent.keyboard("{Enter}");
    expect(screen.queryByTestId("mention-menu")).toBeNull();
    expect((textarea as HTMLTextAreaElement).value).toBe("@proxy.ts ");
    expect(screen.getByTestId("mention-strip")).toBeTruthy();
    expect(screen.getByTestId("mention-chip-file")).toBeTruthy();

    // Submit: the placeholder is swapped for the full reference token and the
    // pending strip clears.
    await userEvent.type(textarea, "explain this");
    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("content")).toBe(
      "[:file|:apps/app/src/proxy.ts|:apps/app/src/proxy.ts|:proxy.ts] explain this",
    );
    await waitFor(() =>
      expect(screen.queryByTestId("mention-strip")).toBeNull(),
    );
  });

  it("arrow keys move the active row", async () => {
    const { textarea } = await renderMentionComposer();
    await userEvent.type(textarea, "@");
    expect(
      screen
        .getByTestId("mention-type-repository")
        .getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(
      screen.getByTestId("mention-type-branch").getAttribute("aria-selected"),
    ).toBe("true");
    await userEvent.keyboard("{ArrowUp}");
    expect(
      screen
        .getByTestId("mention-type-repository")
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("removing a chip detaches the reference — submit keeps the plain text", async () => {
    const { action, textarea } = await renderMentionComposer();
    await userEvent.type(textarea, "@fil");
    await userEvent.keyboard("{Enter}");
    await waitFor(
      () => expect(screen.getByTestId("mention-result-0")).toBeTruthy(),
      {
        timeout: 3_000,
      },
    );
    await userEvent.keyboard("{Enter}");
    expect(screen.getByTestId("mention-chip-file")).toBeTruthy();

    await userEvent.click(
      screen.getByRole("button", { name: "Remove mention proxy.ts" }),
    );
    expect(screen.queryByTestId("mention-strip")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][0] as FormData;
    expect(fd.get("content")).toBe("@proxy.ts ");
  });
});
