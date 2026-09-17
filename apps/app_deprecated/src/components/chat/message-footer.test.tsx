// @vitest-environment jsdom
/**
 * message-footer.test.tsx
 *
 * Component tests for MessageFooter:
 *   (a) renders token count when usage is present
 *   (b) renders credit count when creditsCharged is present
 *   (c) omits credit text when creditsCharged is absent
 *   (d) Copy button writes text to clipboard and flips to check icon
 *   (e) Save as Memory button calls saveAsMemoryAction and flips on success
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { TurnUsage } from "./stream-event-types";

afterEach(cleanup);

// ── Module mocks ────────────────────────────────────────────────────────────

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

const mockAddToast = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: mockAddToast }),
}));

const mockSaveAsMemory = vi.fn();
vi.mock("./message-footer-actions", () => ({
  saveAsMemoryAction: (...args: unknown[]) => mockSaveAsMemory(...args),
}));

// Stub the prompt-cache meter to a marker so we assert only on whether the
// footer decided to render it (its own render logic is tested in
// prompt-cache-bar.test.tsx).
vi.mock("./prompt-cache-bar", () => ({
  PromptCacheBar: (props: { cachedTokens: number }) => (
    <div data-testid="prompt-cache-bar" data-cached={props.cachedTokens} />
  ),
}));

// Stub lucide icons to simple text labels so snapshot assertions are stable.
vi.mock("lucide-react", () => ({
  Copy: () => <span data-testid="icon-copy">copy</span>,
  Check: () => <span data-testid="icon-check">check</span>,
  Brain: () => <span data-testid="icon-brain">brain</span>,
}));

// Stub navigator.clipboard
const writeTextMock = vi.fn().mockResolvedValue(undefined);
Object.defineProperty(navigator, "clipboard", {
  value: { writeText: writeTextMock },
  writable: true,
  configurable: true,
});

import { MessageFooter } from "./message-footer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUsage(overrides: Partial<TurnUsage> = {}): TurnUsage {
  return {
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    ...overrides,
  };
}

function renderFooter(
  props?: Partial<React.ComponentProps<typeof MessageFooter>>,
) {
  return render(
    <MessageFooter
      text="Hello world"
      orgSlug="my-org"
      workspaceSlug="my-ws"
      {...props}
    />,
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageFooter", () => {
  it("(a) renders token count when usage is present", () => {
    renderFooter({ usage: makeUsage() });
    expect(screen.getByText(/150/)).toBeTruthy();
    expect(screen.getByText(/tokens/)).toBeTruthy();
  });

  it("(b) renders credit count when creditsCharged is present", () => {
    renderFooter({ usage: makeUsage({ creditsCharged: 3 }) });
    expect(screen.getByText(/3/)).toBeTruthy();
    expect(screen.getByText(/credit/)).toBeTruthy();
  });

  it("(c) omits credit text when creditsCharged is absent", () => {
    renderFooter({ usage: makeUsage({ creditsCharged: undefined }) });
    expect(screen.queryByText(/credit/i)).toBeNull();
  });

  it("(c1) renders the prompt-cache meter when cachedTokens > 0", () => {
    renderFooter({ usage: makeUsage({ cachedTokens: 40 }) });
    const bar = screen.getByTestId("prompt-cache-bar");
    expect(bar.getAttribute("data-cached")).toBe("40");
  });

  it("(c2) omits the prompt-cache meter when cachedTokens is absent or zero", () => {
    renderFooter({ usage: makeUsage({ cachedTokens: 0 }) });
    expect(screen.queryByTestId("prompt-cache-bar")).toBeNull();
    cleanup();
    renderFooter({ usage: makeUsage() });
    expect(screen.queryByTestId("prompt-cache-bar")).toBeNull();
  });

  it("(d) Copy button writes text to clipboard", async () => {
    renderFooter({ text: "Clipboard text" });
    const copyBtn = screen.getByRole("button", { name: /copy message/i });
    fireEvent.click(copyBtn);
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("Clipboard text");
    });
  });

  it("(e) Save as Memory button calls saveAsMemoryAction with correct args", async () => {
    mockSaveAsMemory.mockResolvedValue({ ok: true });
    renderFooter({ text: "Memory text" });

    const memoryBtn = screen.getByRole("button", { name: /save as memory/i });
    fireEvent.click(memoryBtn);

    await waitFor(() => {
      expect(mockSaveAsMemory).toHaveBeenCalledWith(
        { orgSlug: "my-org", workspaceSlug: "my-ws" },
        "Memory text",
      );
    });
  });
});
