// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import * as React from "react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn() }),
}));

const mockPageCtx = {
  openCommand: vi.fn(),
  openAsk: vi.fn(),
  fillableForm: null as null | { formId: string; title: string; fields: unknown[]; apply: ReturnType<typeof vi.fn> },
  entity: null as null | { summary: string },
  _setIsFilling: vi.fn(),
  _setFillResult: vi.fn(),
  isFilling: false,
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

vi.mock("@/lib/command-menu/intent-router", () => ({
  classifyIntent: vi.fn(() => ({ type: "ask" })),
}));

vi.mock("@/lib/command-menu/use-recent", () => ({
  useRecent: () => ({ recent: [], push: vi.fn() }),
}));

vi.mock("@/lib/ask/fill-action", () => ({
  fillFormAction: vi.fn(),
}));

vi.mock("@/components/ui/toast", () => ({
  useToast: () => ({ add: vi.fn() }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

vi.mock("lucide-react", () => ({
  Search: () => <span data-testid="search-icon" />,
  Command: () => <span data-testid="command-icon" />,
}));

// ScopeContext type for the test
import { AskBar } from "./ask-bar";

const mockCtx = { orgSlug: "acme", workspaceSlug: "prod" } as Parameters<typeof AskBar>[0]["ctx"];

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPageCtx.openCommand = vi.fn();
  mockPageCtx.openAsk = vi.fn();
  mockPageCtx.fillableForm = null;
  mockPageCtx.entity = null;
  mockPageCtx._setIsFilling = vi.fn();
  mockPageCtx._setFillResult = vi.fn();
  mockPageCtx.isFilling = false;
});

describe("AskBar", () => {
  it("renders input with role=combobox and aria-label", () => {
    render(<AskBar ctx={mockCtx} />);
    const input = screen.getByRole("combobox");
    expect(input).toBeDefined();
    expect(input.getAttribute("aria-label")).toBe("Ask, navigate, or search");
  });

  it("pressing '/' key globally focuses the input", () => {
    render(<AskBar ctx={mockCtx} />);
    const input = screen.getByRole("combobox");
    const focusSpy = vi.spyOn(input, "focus");
    // Fire on document.body so the handler sees a real element with .tagName
    fireEvent.keyDown(document.body, { key: "/" });
    expect(focusSpy).toHaveBeenCalled();
  });

  it("pressing Escape clears value", () => {
    render(<AskBar ctx={mockCtx} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello" } });
    expect(input.value).toBe("hello");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
  });

  it("pressing Enter with a value calls classifyIntent and routes", async () => {
    const { classifyIntent } = await import("@/lib/command-menu/intent-router");
    vi.mocked(classifyIntent).mockReturnValue({ type: "ask", query: "hello world" });

    render(<AskBar ctx={mockCtx} />);
    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello world" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(classifyIntent).toHaveBeenCalledWith(
        expect.objectContaining({ query: "hello world" }),
      );
    });
  });

  it("shows keyboard hint kbd element when value is empty", () => {
    render(<AskBar ctx={mockCtx} />);
    // kbd is rendered when value is empty
    const kbd = document.querySelector("kbd");
    expect(kbd).not.toBeNull();
  });

  it("shows 'Open command menu' button", () => {
    render(<AskBar ctx={mockCtx} />);
    const btn = screen.getByRole("button", { name: /open command menu/i });
    expect(btn).toBeDefined();
  });

  it("clicking 'Open command menu' calls openCommand", () => {
    render(<AskBar ctx={mockCtx} />);
    const btn = screen.getByRole("button", { name: /open command menu/i });
    fireEvent.click(btn);
    expect(mockPageCtx.openCommand).toHaveBeenCalled();
  });
});
