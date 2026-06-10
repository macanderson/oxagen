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
import { render, screen, cleanup, act, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ResolvedTierCatalog } from "@oxagen/ai/catalog";
import type { McpServerSummary } from "./mcp-types";

afterEach(cleanup);

// ── mocks ──────────────────────────────────────────────────────────────────────

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const mockSupportsReasoning = vi.fn(() => false);
const mockGetModel = vi.fn(() => undefined);

vi.mock("@oxagen/ai/catalog", () => ({
  supportsReasoning: (...args: unknown[]) => mockSupportsReasoning(...args),
  getModel: (...args: unknown[]) => mockGetModel(...args),
}));

vi.mock("./model-picker", () => ({
  ModelPicker: ({ onChange }: { onChange: (v: unknown) => void }) => (
    <div data-testid="model-picker" onClick={() => onChange({ tier: "fast", generate: null, model: null, effort: null, mediaTier: null, mediaModel: null, seededImageModel: null, seededVideoModel: null })} />
  ),
  defaultModelState: {
    tier: "fast",
    generate: null,
    model: null,
    effort: null,
    mediaTier: null,
    mediaModel: null,
    seededImageModel: null,
    seededVideoModel: null,
  },
}));

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
  Select: ({ children, onValueChange, value }: { children: React.ReactNode; onValueChange?: (v: string) => void; value?: string }) => (
    <div data-testid="select" data-value={value} onClick={() => onValueChange?.("high")}>{children}</div>
  ),
  SelectTrigger: ({ children, "aria-label": ariaLabel }: { children: React.ReactNode; "aria-label"?: string; size?: string; className?: string }) => (
    <div data-testid="select-trigger" aria-label={ariaLabel}>{children}</div>
  ),
  SelectValue: () => <span />,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
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
  };
});

// ── helpers ────────────────────────────────────────────────────────────────────

const DEFAULT_MODEL_CONFIG: ResolvedTierCatalog = {
  text: {
    fast: "claude-haiku-4-5",
    balanced: "claude-sonnet-4-5",
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

const makeMcpServer = (overrides: Partial<McpServerSummary> = {}): McpServerSummary => ({
  publicId: "mcs_test",
  name: "Test Server",
  toolCount: 3,
  healthStatus: "healthy",
  ...overrides,
});

function makeAction(result: { ok: boolean; error?: string } = { ok: true }) {
  return vi.fn().mockResolvedValue(result) as (fd: FormData) => Promise<{ ok: boolean; error?: string }>;
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
    expect(screen.getByRole("button", { name: "Generate image" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Generate video" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Send message" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Queue message" })).toBeInTheDocument();
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
    expect(screen.getByRole("button", { name: "Interrupt and send" })).toBeInTheDocument();
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
    expect(JSON.parse(fd.get("activeServerIds") as string)).toEqual(["mcs_abc"]);
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
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
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
    await waitFor(() => expect(screen.getByText("Server exploded")).toBeInTheDocument());
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
    await waitFor(() => expect(screen.getByText("Failed to send message")).toBeInTheDocument());
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
    await userEvent.click(screen.getByRole("button", { name: "Generate image" }));
    expect(screen.getByPlaceholderText("Describe the image you want…")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Generate video" }));
    expect(screen.getByPlaceholderText("Describe the video you want…")).toBeInTheDocument();
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
    await userEvent.click(screen.getByRole("button", { name: "Generate image" }));
    await userEvent.click(screen.getByRole("button", { name: "Generate video" }));
    expect(screen.getByPlaceholderText("Describe the video you want…")).toBeInTheDocument();
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
    Object.defineProperty(event, "nativeEvent", { value: { isComposing: false } });
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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
    expect(screen.getByText("to remove")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove queued message" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Interrupt and send" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));

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
    expect(JSON.parse(fd.get("activeServerIds") as string)).toEqual(["mcs_drain"]);
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
    await userEvent.click(screen.getByRole("button", { name: "Generate image" }));
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
    await userEvent.click(screen.getByRole("button", { name: "Generate video" }));
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
    Object.defineProperty(event, "nativeEvent", { value: { isComposing: false } });
    Object.defineProperty(event, "currentTarget", { value: { value: "hello" } });
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
    await userEvent.click(screen.getByRole("button", { name: "Generate image" }));
    await userEvent.type(screen.getByRole("textbox"), "a castle");
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));

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
        }}
      />,
    );
    await userEvent.type(screen.getByRole("textbox"), "opus query");
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));

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
    await userEvent.click(screen.getByRole("button", { name: "Queue message" }));

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
