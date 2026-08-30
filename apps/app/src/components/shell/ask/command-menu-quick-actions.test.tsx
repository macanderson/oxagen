// @vitest-environment jsdom
/**
 * Tests for the Quick Actions section in CommandMenu.
 *
 * Verifies:
 *   1. Quick Actions section appears when matching templates exist for the page.
 *   2. Quick Actions section is hidden when no templates match.
 *   3. Selecting a Quick Action calls openAskWithText with the rendered prompt.
 *   4. Typing a query hides the Quick Actions section.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import * as React from "react";

const mockRouter = { push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/acme/prod/knowledge/memory/mem_123",
}));

const mockPageCtx = {
  isCommandOpen: true,
  closeCommand: vi.fn(),
  openAsk: vi.fn(),
  openAskWithText: vi.fn(),
  fillableForm: null as null | unknown,
  entity: null as null | {
    kind: string;
    id: string;
    label?: string;
    summary?: string;
  },
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

vi.mock("@/lib/sidebar", () => ({
  enumerateNavTargets: () => [{ label: "Ask", href: "/acme/prod/ask" }],
}));

vi.mock("@/lib/command-menu/intent-router", () => ({
  classifyIntent: vi.fn(() => ({ type: "navigate", href: "/acme/prod/ask" })),
}));

vi.mock("@/lib/command-menu/use-recent", () => ({
  useRecent: () => ({ recent: [], push: vi.fn() }),
}));

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? <div data-testid="dialog">{children}</div> : null,
  DialogPopup: ({
    children,
    onKeyDown,
  }: {
    children: React.ReactNode;
    onKeyDown?: React.KeyboardEventHandler<HTMLDivElement>;
  }) => (
    <div data-testid="dialog-popup" onKeyDown={onKeyDown}>
      {children}
    </div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}));

vi.mock(
  "lucide-react",
  () =>
    new Proxy({} as Record<string | symbol, unknown>, {
      get: (_t, prop) =>
        prop === "then"
          ? undefined
          : () => <svg aria-hidden="true" data-icon={String(prop)} />,
      has: (_t, prop) => prop !== "then",
    }),
);

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

// Mock prompt-templates to return controlled test data.
const mockGetApplicableTemplates = vi.fn();
const mockRenderTemplate = vi.fn(
  (body: string, vars: Record<string, string>) => ({
    rendered: body.replace(
      /\{\{(\w+)\}\}/g,
      (_: string, name: string) => vars[name] ?? `{{${name}}}`,
    ),
    missing: [] as string[],
  }),
);
const mockResolveVariables = vi.fn((_vars: unknown, _ctx: unknown) => ({
  resolved: { run_id: "run_123" } as Record<string, string>,
  unresolved: [] as string[],
}));

vi.mock("@oxagen/prompt-templates", () => ({
  getApplicableTemplates: (ctx: unknown) => mockGetApplicableTemplates(ctx),
  renderTemplate: (body: string, vars: Record<string, string>) =>
    mockRenderTemplate(body, vars),
  resolveVariables: (vars: unknown[], ctx: unknown) =>
    mockResolveVariables(vars, ctx),
}));

import { CommandMenu } from "./command-menu";

const mockCtx = {
  orgSlug: "acme",
  workspaceSlug: "prod",
} as Parameters<typeof CommandMenu>[0]["ctx"];

// Minimal template fixture.
const mockTemplate = {
  id: "summarize-run-failure",
  title: "Summarize this run's failure",
  description: "Generate a root-cause summary",
  category: "investigate" as const,
  tags: ["run", "failure"],
  applicableTo: [{ routePattern: "/{org}/{ws}/knowledge/memory/:memoryId" }],
  autoSubmit: true,
  body: "Summarize the failure of run {{run_id}}.",
  variables: [
    {
      name: "run_id",
      resolver: "param" as const,
      source: "params.runId",
      required: true,
    },
  ],
};

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPageCtx.isCommandOpen = true;
  mockPageCtx.closeCommand = vi.fn();
  mockPageCtx.openAsk = vi.fn();
  mockPageCtx.openAskWithText = vi.fn();
  mockPageCtx.fillableForm = null;
  mockPageCtx.entity = null;
  mockRouter.push = vi.fn();
  mockGetApplicableTemplates.mockReturnValue([]);
  mockRenderTemplate.mockReturnValue({
    rendered: "Summarize the failure of run run_123.",
    missing: [],
  });
  mockResolveVariables.mockReturnValue({
    resolved: { run_id: "run_123" },
    unresolved: [],
  });
});

describe("CommandMenu — Quick Actions section", () => {
  it("shows Quick Actions section when templates match the current route", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    const qaGroup = document.querySelector('[aria-label="Quick Actions"]');
    expect(qaGroup).not.toBeNull();
    expect(screen.getByText("Summarize this run's failure")).toBeDefined();
  });

  it("does not render Quick Actions section when no templates match", () => {
    mockGetApplicableTemplates.mockReturnValue([]);
    render(<CommandMenu ctx={mockCtx} />);

    const qaGroup = document.querySelector('[aria-label="Quick Actions"]');
    expect(qaGroup).toBeNull();
  });

  it("calls getApplicableTemplates with the current pathname", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    expect(mockGetApplicableTemplates).toHaveBeenCalled();
    const callArg = mockGetApplicableTemplates.mock.calls[0]?.[0] as {
      pathname: string;
    };
    expect(callArg.pathname).toBe("/acme/prod/knowledge/memory/mem_123");
  });

  it("hides Quick Actions section when user types a query", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "some search" } });

    // After typing, Quick Actions should be hidden (they're empty-query only).
    const qaGroup = document.querySelector('[aria-label="Quick Actions"]');
    expect(qaGroup).toBeNull();
  });

  it("selecting a Quick Action calls openAskWithText with rendered prompt", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    mockRenderTemplate.mockReturnValue({
      rendered: "Summarize the failure of run run_123.",
      missing: [],
    });
    mockResolveVariables.mockReturnValue({
      resolved: { run_id: "run_123" },
      unresolved: [],
    });

    render(<CommandMenu ctx={mockCtx} />);

    // Find and click the Quick Action item.
    const qaItem = screen
      .getByText("Summarize this run's failure")
      .closest('[role="option"]');
    expect(qaItem).not.toBeNull();
    fireEvent.click(qaItem!);

    expect(mockPageCtx.closeCommand).toHaveBeenCalled();
    expect(mockPageCtx.openAskWithText).toHaveBeenCalledWith(
      "Summarize the failure of run run_123.",
      true, // autoSubmit
    );
  });

  it("selecting Quick Action via keyboard Enter calls openAskWithText", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    const popup = screen.getByTestId("dialog-popup");
    // Quick Action is index 0 (before navigate items).
    // Initially index 0 is active (first item = the Quick Action).
    fireEvent.keyDown(popup, { key: "Enter" });

    expect(mockPageCtx.openAskWithText).toHaveBeenCalledWith(
      "Summarize the failure of run run_123.",
      true,
    );
    expect(mockPageCtx.closeCommand).toHaveBeenCalled();
  });

  it("renders secondary description for Quick Action items", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    expect(screen.getByText("Generate a root-cause summary")).toBeDefined();
  });

  it("existing Navigate section still renders alongside Quick Actions", () => {
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    // Both sections should coexist.
    const qaGroup = document.querySelector('[aria-label="Quick Actions"]');
    const navGroup = document.querySelector('[aria-label="Navigate"]');
    expect(qaGroup).not.toBeNull();
    expect(navGroup).not.toBeNull();
  });

  it("passes page entity to getApplicableTemplates when entity is registered", () => {
    mockPageCtx.entity = {
      kind: "run",
      id: "run_123",
      label: "Run #123",
      summary: "A failing run",
    };
    mockGetApplicableTemplates.mockReturnValue([mockTemplate]);
    render(<CommandMenu ctx={mockCtx} />);

    const callArg = mockGetApplicableTemplates.mock.calls[0]?.[0] as {
      pageEntity?: { kind: string; id: string };
    };
    expect(callArg.pageEntity?.kind).toBe("run");
    expect(callArg.pageEntity?.id).toBe("run_123");
  });
});
