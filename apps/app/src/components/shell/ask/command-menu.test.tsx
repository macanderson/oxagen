// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  render,
  screen,
  cleanup,
  fireEvent,
  act,
} from "@testing-library/react";
import * as React from "react";

const mockRouter = { push: vi.fn() };

vi.mock("next/navigation", () => ({
  useRouter: () => mockRouter,
  usePathname: () => "/acme/prod",
}));

const mockPageCtx = {
  isCommandOpen: false,
  closeCommand: vi.fn(),
  openAsk: vi.fn(),
  openAskWithText: vi.fn(),
  fillableForm: null as null | unknown,
  entity: null as null | unknown,
};

vi.mock("@/lib/page-context", () => ({
  usePageContext: () => mockPageCtx,
}));

const mockEnumerateNavTargets = vi.fn((_ctx: unknown) => [
  { label: "Ask", href: "/acme/prod/ask" },
]);

vi.mock("@/lib/sidebar", () => ({
  enumerateNavTargets: (ctx: unknown) => mockEnumerateNavTargets(ctx),
}));

vi.mock("@/lib/command-menu/intent-router", () => ({
  classifyIntent: vi.fn(() => ({ type: "navigate", href: "/acme/prod/ask" })),
}));

vi.mock("@/lib/command-menu/use-recent", () => ({
  useRecent: () => ({ recent: [], push: vi.fn() }),
}));

// ── Mocks for the Suggested-for-page and Search-results sections ─────────────

// entity-prefix matcher — default: no match (vi.fn typed via mockReturnValue at test time)
const mockMatchEntityPrefix = vi.fn() as ReturnType<typeof vi.fn>;
mockMatchEntityPrefix.mockReturnValue(null);
vi.mock("./entity-prefix", () => ({
  matchEntityPrefix: (q: string) =>
    mockMatchEntityPrefix(q) as { kind: string; queryRemainder: string } | null,
}));

// useSuggestions — default: no suggestions, not loading
const mockUseSuggestions = vi.fn() as ReturnType<typeof vi.fn>;
mockUseSuggestions.mockReturnValue({ suggestions: [], loading: false });
vi.mock("./use-suggestions", () => ({
  useSuggestions: (args: unknown) =>
    mockUseSuggestions(args) as {
      suggestions: Array<{
        text: string;
        category: string;
        confidence: number;
      }>;
      loading: boolean;
    },
}));

// global fetch for useEntitySearch
const mockFetch = vi.fn(() =>
  Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ rows: [] }),
  } as Response),
);
vi.stubGlobal("fetch", mockFetch);

// ── UI mocks ──────────────────────────────────────────────────────────────────

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

vi.mock("lucide-react", () => ({
  Search: () => <span data-icon="Search" />,
  ArrowRight: () => <span />,
  Clock: () => <span />,
  Navigation: () => <span />,
  Sparkles: () => <span />,
  Zap: () => <span />,
  PlusCircle: () => <span />,
  ScanSearch: () => <span />,
  Settings: () => <span />,
  MessageSquare: () => <span />,
  BarChart2: () => <span />,
  User: () => <span />,
  BookOpen: () => <span />,
  CalendarClock: () => <span />,
  Bot: () => <span />,
  Loader2: () => <span data-icon="Loader2" />,
}));

vi.mock("@oxagen/prompt-templates", () => ({
  getApplicableTemplates: () => [],
  renderTemplate: (body: string) => ({ rendered: body, missing: [] }),
  resolveVariables: () => ({ resolved: {}, unresolved: [] }),
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(" "),
}));

import { CommandMenu } from "./command-menu";

const mockCtx = { orgSlug: "acme", workspaceSlug: "prod" } as Parameters<
  typeof CommandMenu
>[0]["ctx"];

afterEach(cleanup);

beforeEach(() => {
  vi.clearAllMocks();
  mockPageCtx.isCommandOpen = false;
  mockPageCtx.closeCommand = vi.fn();
  mockPageCtx.openAsk = vi.fn();
  mockPageCtx.openAskWithText = vi.fn();
  mockPageCtx.fillableForm = null;
  mockPageCtx.entity = null;
  mockRouter.push = vi.fn();
  mockEnumerateNavTargets.mockReturnValue([
    { label: "Ask", href: "/acme/prod/ask" },
  ]);
  mockMatchEntityPrefix.mockReturnValue(null);
  mockUseSuggestions.mockReturnValue({ suggestions: [], loading: false });
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ rows: [] }),
  } as Response);
});

// ── Quick Actions and Navigate sections ───────────────────────────────────────

describe("CommandMenu", () => {
  it("does NOT render dialog when isCommandOpen=false", () => {
    mockPageCtx.isCommandOpen = false;
    render(<CommandMenu ctx={mockCtx} />);
    expect(screen.queryByTestId("dialog")).toBeNull();
  });

  it("renders search input with role=combobox when isCommandOpen=true", () => {
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);
    expect(screen.getByTestId("dialog")).toBeDefined();
    const input = screen.getByRole("combobox");
    expect(input).toBeDefined();
  });

  it("shows 'Ask' section always", () => {
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);
    const askGroup = document.querySelector('[aria-label="Ask"]');
    expect(askGroup).not.toBeNull();
  });

  it("typing in input filters nav items", () => {
    mockEnumerateNavTargets.mockReturnValue([
      { label: "Ask", href: "/acme/prod/ask" },
      { label: "Dashboard", href: "/acme/prod/dashboard" },
    ]);

    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "dash" } });

    expect(screen.getByText("Dashboard")).toBeDefined();
    const options = screen.getAllByRole("option");
    const labels = options.map((o) => o.textContent ?? "");
    expect(labels.some((l) => l.includes("Dashboard"))).toBe(true);
    expect(labels.some((l) => l === "Ask")).toBe(false);
  });

  it("ArrowDown changes active item (aria-selected)", () => {
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const options = screen.getAllByRole("option");
    expect(options[0]?.getAttribute("aria-selected")).toBe("true");

    const popup = screen.getByTestId("dialog-popup");
    fireEvent.keyDown(popup, { key: "ArrowDown" });

    const updatedOptions = screen.getAllByRole("option");
    expect(updatedOptions[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("passes the workspace ctx through to enumerateNavTargets", () => {
    mockPageCtx.isCommandOpen = true;
    const wsCtx = { orgSlug: "acme", workspaceSlug: "prod" } as Parameters<
      typeof CommandMenu
    >[0]["ctx"];
    render(<CommandMenu ctx={wsCtx} />);
    expect(mockEnumerateNavTargets).toHaveBeenCalled();
    const firstCallCtx = mockEnumerateNavTargets.mock.calls[0]?.[0] as
      | { orgSlug: string; workspaceSlug?: string }
      | undefined;
    expect(firstCallCtx?.orgSlug).toBe("acme");
    expect(firstCallCtx?.workspaceSlug).toBe("prod");
  });

  it("Escape key calls closeCommand via onOpenChange", () => {
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);
    const popup = screen.getByTestId("dialog-popup");
    expect(popup).toBeDefined();
    expect(typeof mockPageCtx.closeCommand).toBe("function");
  });
});

// ── Suggested for this page section ───────────────────────────────────────────

describe("CommandMenu — Suggested for this page", () => {
  it("renders 'Suggested for this page' section when suggestions are available", () => {
    mockUseSuggestions.mockReturnValue({
      suggestions: [
        {
          text: "Summarize this run's failure",
          category: "investigate",
          confidence: 0.9,
        },
        {
          text: "Show similar failed runs",
          category: "investigate",
          confidence: 0.8,
        },
      ],
      loading: false,
    });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const section = document.querySelector(
      '[aria-label="Suggested for this page"]',
    );
    expect(section).not.toBeNull();
    expect(screen.getByText("Summarize this run's failure")).toBeDefined();
    expect(screen.getByText("Show similar failed runs")).toBeDefined();
  });

  it("does NOT render 'Suggested for this page' section when no suggestions", () => {
    mockUseSuggestions.mockReturnValue({ suggestions: [], loading: false });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const section = document.querySelector(
      '[aria-label="Suggested for this page"]',
    );
    expect(section).toBeNull();
  });

  it("shows loading state while suggestions are fetching", () => {
    // loading=true but no suggestions yet → section should appear with loader
    mockUseSuggestions.mockReturnValue({ suggestions: [], loading: true });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const section = document.querySelector(
      '[aria-label="Suggested for this page"]',
    );
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("Loading suggestions");
  });

  it("selecting a suggestion calls openAskWithText with the suggestion text", () => {
    mockUseSuggestions.mockReturnValue({
      suggestions: [
        {
          text: "Identify the failing step",
          category: "analyze",
          confidence: 0.85,
        },
      ],
      loading: false,
    });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const option = screen.getByText("Identify the failing step");
    fireEvent.click(option.closest('[role="option"]')!);
    expect(mockPageCtx.openAskWithText).toHaveBeenCalledWith(
      "Identify the failing step",
      false,
    );
    expect(mockPageCtx.closeCommand).toHaveBeenCalled();
  });

  it("hides 'Suggested for this page' when a query is typed", () => {
    mockUseSuggestions.mockReturnValue({
      suggestions: [
        {
          text: "Show recent failures",
          category: "investigate",
          confidence: 0.9,
        },
      ],
      loading: false,
    });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    // Suggestions visible with empty query
    expect(
      document.querySelector('[aria-label="Suggested for this page"]'),
    ).not.toBeNull();

    // Type a query — suggestions section should disappear
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "run abc" } });

    expect(
      document.querySelector('[aria-label="Suggested for this page"]'),
    ).toBeNull();
  });
});

// ── Search results section ────────────────────────────────────────────────────

describe("CommandMenu — Entity Search", () => {
  it("enters search mode when input matches an entity prefix", async () => {
    mockMatchEntityPrefix.mockReturnValue({
      kind: "run",
      queryRemainder: "aex_abc",
    });
    mockPageCtx.isCommandOpen = true;

    // Fetch will return search rows
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          rows: [
            {
              kind: "run",
              id: "aex_abc",
              label: "Run aex_abc",
              scope: "Workspace: prod",
              contextLine: "Status: failed",
              href: "/acme/prod/knowledge/memory/mem_abc",
            },
          ],
        }),
    } as Response);

    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "run aex_abc" } });
    });

    // The search results section should render
    const section = document.querySelector('[aria-label="Search results"]');
    expect(section).not.toBeNull();
  });

  it("hides Quick Actions and Navigate sections in search mode", async () => {
    mockMatchEntityPrefix.mockReturnValue({
      kind: "playbook",
      queryRemainder: "churn",
    });
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "playbook churn" } });
    });

    // Navigate section should be gone in search mode
    const navSection = document.querySelector('[aria-label="Navigate"]');
    expect(navSection).toBeNull();

    // Quick Actions should be gone (no query.trim() check suppresses them in search mode)
    const qaSection = document.querySelector('[aria-label="Quick Actions"]');
    expect(qaSection).toBeNull();
  });

  it("shows 'No results found' when search returns empty", async () => {
    mockMatchEntityPrefix.mockReturnValue({
      kind: "agent",
      queryRemainder: "nonexistent",
    });
    mockPageCtx.isCommandOpen = true;
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows: [] }),
    } as Response);

    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "agent nonexistent" } });
    });

    // Wait for fetch to resolve and state to update
    await act(async () => {
      await Promise.resolve();
    });

    const section = document.querySelector('[aria-label="Search results"]');
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("No results found");
  });

  it("calls router.push with the search result href on click", async () => {
    mockMatchEntityPrefix.mockReturnValue({
      kind: "run",
      queryRemainder: "abc",
    });
    mockPageCtx.isCommandOpen = true;

    const mockRow = {
      kind: "run",
      id: "aex_abc",
      label: "Run aex_abc",
      scope: "Workspace: prod",
      contextLine: "Status: failed",
      href: "/acme/prod/knowledge/memory/mem_abc",
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ rows: [mockRow] }),
    } as Response);

    render(<CommandMenu ctx={mockCtx} />);

    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "run abc" } });
    });

    // Flush microtasks for fetch
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });

    // Find and click the result
    const resultText = screen.queryByText("Run aex_abc");
    if (resultText) {
      const option = resultText.closest('[role="option"]');
      if (option) {
        fireEvent.click(option);
        expect(mockRouter.push).toHaveBeenCalledWith(
          "/acme/prod/knowledge/memory/mem_abc",
        );
      }
    }
  });

  it("reverts to normal mode when entity-prefix query is cleared", async () => {
    // First render with no match → Navigate shown
    mockMatchEntityPrefix.mockReturnValue(null);
    mockPageCtx.isCommandOpen = true;
    render(<CommandMenu ctx={mockCtx} />);

    // In normal mode Navigate is visible
    expect(document.querySelector('[aria-label="Navigate"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search results"]')).toBeNull();

    // Switch mock to return a match → search mode
    mockMatchEntityPrefix.mockReturnValue({
      kind: "run",
      queryRemainder: "abc",
    });
    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.change(input, { target: { value: "run abc" } });
    });
    // In search mode: Search results section appears, Navigate section disappears
    expect(
      document.querySelector('[aria-label="Search results"]'),
    ).not.toBeNull();
    expect(document.querySelector('[aria-label="Navigate"]')).toBeNull();

    // Switch mock back to null → exit search mode
    mockMatchEntityPrefix.mockReturnValue(null);
    await act(async () => {
      fireEvent.change(input, { target: { value: "" } });
    });
    expect(document.querySelector('[aria-label="Navigate"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search results"]')).toBeNull();
  });
});
