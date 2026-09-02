// @vitest-environment jsdom
/**
 * memory-citations-panel.test.tsx — Citations view for Knowledge → Memory.
 *
 * Covers: the empty pre-search state, blank-id validation (no server call),
 * the happy path (invoke args include compliance/influence filters, results
 * render via NodeRef — never a raw memoryId), the violation banner, the
 * empty-results state, and the error+retry path.
 *
 * The Base UI Select and Popover primitives are mocked to flat, always-open
 * markup (same convention as inference-pending-list.test.tsx) so interaction
 * tests don't depend on floating-ui positioning in jsdom.
 */

import * as React from "react";
import { describe, it, expect, afterEach, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react";

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => (
    <button type="button" aria-label={ariaLabel}>
      {children}
    </button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

const SelectContext = React.createContext<{
  onValueChange?: (v: string) => void;
}>({});

vi.mock("@/components/ui/select", () => ({
  Select: ({
    value,
    onValueChange,
    children,
  }: {
    value?: string;
    onValueChange?: (v: string) => void;
    children: React.ReactNode;
  }) => (
    <SelectContext.Provider value={{ onValueChange }}>
      <div data-current-value={value}>{children}</div>
    </SelectContext.Provider>
  ),
  SelectTrigger: ({
    children,
    id,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    id?: string;
    "aria-label"?: string;
  }) => (
    <div id={id} aria-label={ariaLabel}>
      {children}
    </div>
  ),
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  SelectItem: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const { onValueChange } = React.useContext(SelectContext);
    return (
      <button type="button" onClick={() => onValueChange?.(value)}>
        {children}
      </button>
    );
  },
}));

import {
  MemoryCitationsPanel,
  type MemoryCitation,
} from "./memory-citations-panel";

afterEach(cleanup);

const BASE = { orgSlug: "oxagen", workspaceSlug: "main" };

function citation(overrides: Partial<MemoryCitation> = {}): MemoryCitation {
  return {
    citationId: "cit-1",
    memoryId: "913d6df1-5dca-4bc7-aff6-193939228260",
    lesson: "Never push directly to main.",
    influence: "DECISIVE",
    compliance: "COMPLIED",
    enforcementAtCite: 95,
    expectedValue: "PR opened",
    observedValue: "PR opened",
    agentRationale: "Followed the branch protection rule.",
    ...overrides,
  };
}

describe("MemoryCitationsPanel", () => {
  it("renders the pre-search empty state and does not call listCitations", () => {
    const listCitations = vi.fn();
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);
    expect(screen.getByText("No execution looked up yet")).toBeInTheDocument();
    expect(listCitations).not.toHaveBeenCalled();
  });

  it("shows a validation error and skips the server call when execution id is blank", () => {
    const listCitations = vi.fn();
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));
    expect(
      screen.getByText("Enter an execution id to look up citations."),
    ).toBeInTheDocument();
    expect(listCitations).not.toHaveBeenCalled();
  });

  it("looks up citations for the entered execution id with no filters by default", async () => {
    const listCitations = vi
      .fn()
      .mockResolvedValue({ ok: true, citations: [citation()] });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    await waitFor(() => expect(listCitations).toHaveBeenCalledTimes(1));
    expect(listCitations.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      executionId: "exec-1",
    });
  });

  it("renders the cited memory via NodeRef (lesson, not the raw memoryId) plus influence/compliance badges", async () => {
    const listCitations = vi.fn().mockResolvedValue({
      ok: true,
      citations: [citation({ lesson: "Always open a PR before merging." })],
    });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    // NodeRef renders the lesson in both its trigger and its (mock-open)
    // popover header, so the label legitimately appears more than once — assert
    // presence with getAllByText, matching inference-pending-list.test.tsx.
    await waitFor(() =>
      expect(
        screen.getAllByText("Always open a PR before merging.").length,
      ).toBeGreaterThan(0),
    );
    expect(
      screen.queryByText("913d6df1-5dca-4bc7-aff6-193939228260"),
    ).not.toBeInTheDocument();

    // Scope to the results table — the influence toggle buttons above the
    // table also render the raw "DECISIVE" label, so an unscoped query would
    // match twice. Within the table, influence/compliance appear only as their
    // badge cells (the NodeRef property bag deliberately omits them).
    const table = screen.getByRole("table");
    expect(within(table).getByText("DECISIVE")).toBeInTheDocument();
    expect(within(table).getByText("COMPLIED")).toBeInTheDocument();
  });

  it("shows the rule-violation banner when a citation's compliance is VIOLATION", async () => {
    const listCitations = vi.fn().mockResolvedValue({
      ok: true,
      citations: [citation({ compliance: "VIOLATION", citationId: "cit-v" })],
    });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-1" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/1 rule violation recorded in this execution/i),
      ).toBeInTheDocument(),
    );
  });

  it("passes the selected compliance filter and toggled influence filters to listCitations", async () => {
    const listCitations = vi
      .fn()
      .mockResolvedValue({ ok: true, citations: [] });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-2" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Violation" }));
    fireEvent.click(screen.getByRole("button", { name: "DECISIVE" }));
    fireEvent.click(screen.getByRole("button", { name: "CONTRIBUTING" }));
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    await waitFor(() => expect(listCitations).toHaveBeenCalledTimes(1));
    expect(listCitations.mock.calls[0]?.[0]).toEqual({
      orgSlug: "oxagen",
      workspaceSlug: "main",
      executionId: "exec-2",
      compliance: "VIOLATION",
      influenceIn: ["DECISIVE", "CONTRIBUTING"],
    });
  });

  it("shows an empty-results state when the execution cited nothing matching the filter", async () => {
    const listCitations = vi
      .fn()
      .mockResolvedValue({ ok: true, citations: [] });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-3" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    await waitFor(() =>
      expect(screen.getByText("No citations recorded")).toBeInTheDocument(),
    );
  });

  it("shows an error state on failure and retries the same lookup", async () => {
    const listCitations = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: "execution not found" })
      .mockResolvedValueOnce({ ok: true, citations: [citation()] });
    render(<MemoryCitationsPanel {...BASE} listCitations={listCitations} />);

    fireEvent.change(screen.getByLabelText("Execution ID"), {
      target: { value: "exec-4" },
    });
    fireEvent.click(screen.getByRole("button", { name: /load citations/i }));

    await waitFor(() =>
      expect(screen.getByText("execution not found")).toBeInTheDocument(),
    );

    const retryButton = within(screen.getByRole("alert")).getByRole("button", {
      name: /try again/i,
    });
    fireEvent.click(retryButton);

    await waitFor(() => expect(listCitations).toHaveBeenCalledTimes(2));
    // NodeRef renders the lesson in trigger + (mock-open) popover header.
    await waitFor(() =>
      expect(
        screen.getAllByText("Never push directly to main.").length,
      ).toBeGreaterThan(0),
    );
  });
});
