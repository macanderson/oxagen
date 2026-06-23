// @vitest-environment jsdom
/**
 * message-footer.test.tsx
 *
 * Verifies the assistant message footer:
 *   - Copy button writes to clipboard and flips icon to a check for ~2s.
 *   - Save-as-Knowledge runs the handler, shows a success toast, and flips
 *     to a check icon. The same shape for Save-as-Memory.
 *   - Usage line renders credits + tokens when present, suppresses zero-usage
 *     turns per OXA-1469 acceptance criteria.
 *   - When no handler is wired, the corresponding button is not rendered.
 */

import * as React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor, cleanup, act, fireEvent } from "@testing-library/react";
import { MessageFooter } from "./message-footer";

const toastAdd = vi.fn();
vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: toastAdd }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(" "),
}));

const writeTextMock = vi.fn(async () => undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: writeTextMock,
  },
});

afterEach(() => {
  cleanup();
  toastAdd.mockReset();
  writeTextMock.mockReset();
});

describe("MessageFooter", () => {
  it("renders copy button only when no save handlers are provided", () => {
    render(<MessageFooter text="Hi" />);
    expect(screen.getByTestId("message-footer-copy")).toBeTruthy();
    expect(screen.queryByTestId("message-footer-save-knowledge")).toBeNull();
    expect(screen.queryByTestId("message-footer-save-memory")).toBeNull();
  });

  it("renders save-as-knowledge / save-as-memory icon buttons when handlers are wired", () => {
    const onSaveKnowledge = vi.fn();
    const onSaveMemory = vi.fn();
    render(
      <MessageFooter text="Hello" onSaveKnowledge={onSaveKnowledge} onSaveMemory={onSaveMemory} />,
    );
    expect(screen.getByTestId("message-footer-save-knowledge")).toBeTruthy();
    expect(screen.getByTestId("message-footer-save-memory")).toBeTruthy();
  });

  it("copies to the clipboard and flips the icon to a check", async () => {
    render(<MessageFooter text="Some assistant reply" />);
    const button = screen.getByTestId("message-footer-copy");
    expect(button.getAttribute("data-state")).toBe("idle");
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(writeTextMock).toHaveBeenCalledWith("Some assistant reply");
    });
    expect(button.getAttribute("data-state")).toBe("saved");
  });

  it("invokes save-as-knowledge handler and flips the icon to a check on success", async () => {
    const onSaveKnowledge = vi.fn(async () => ({ ok: true as const }));
    render(<MessageFooter text="Saved reply" onSaveKnowledge={onSaveKnowledge} />);
    const button = screen.getByTestId("message-footer-save-knowledge");
    await act(async () => {
      fireEvent.click(button);
    });
    await waitFor(() => {
      expect(button.getAttribute("data-state")).toBe("saved");
    });
    expect(onSaveKnowledge).toHaveBeenCalledWith("Saved reply");
    expect(toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", title: "Saved to knowledge graph" }),
    );
  });

  it("shows an error toast when save-as-knowledge handler fails", async () => {
    const onSaveKnowledge = vi.fn(async () => ({ ok: false as const, error: "Neo4j down" }));
    render(<MessageFooter text="Saved reply" onSaveKnowledge={onSaveKnowledge} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("message-footer-save-knowledge"));
    });
    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error", description: "Neo4j down" }),
      );
    });
    expect(screen.getByTestId("message-footer-save-knowledge").getAttribute("data-state")).toBe("idle");
  });

  it("invokes save-as-memory handler and surfaces a success toast", async () => {
    const onSaveMemory = vi.fn(async () => ({ ok: true as const }));
    render(<MessageFooter text="Saved reply" onSaveMemory={onSaveMemory} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId("message-footer-save-memory"));
    });
    await waitFor(() => {
      expect(toastAdd).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", title: "Saved as memory" }),
      );
    });
    expect(onSaveMemory).toHaveBeenCalledWith("Saved reply");
  });

  it("renders credits + token count when both are present", () => {
    render(<MessageFooter text="Reply" creditsCharged={3} totalTokens={1240} />);
    const usage = screen.getByTestId("message-footer-usage");
    expect(usage.textContent).toContain("3 credits");
    expect(usage.textContent).toContain("1,240 tokens");
  });

  it("uses singular 'credit' when exactly one credit was charged", () => {
    render(<MessageFooter text="Reply" creditsCharged={1} totalTokens={50} />);
    expect(screen.getByTestId("message-footer-usage").textContent).toContain("1 credit · 50 tokens");
  });

  it("suppresses the usage line entirely on zero-usage turns (the OXA-1469 acceptance criterion)", () => {
    render(<MessageFooter text="Reply" creditsCharged={0} totalTokens={0} />);
    expect(screen.queryByTestId("message-footer-usage")).toBeNull();
  });

  it("disables the copy button when the text is empty (cannot copy nothing)", () => {
    render(<MessageFooter text="   " />);
    const button = screen.getByTestId("message-footer-copy") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
});
