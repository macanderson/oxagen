// @vitest-environment jsdom
/**
 * list-toolbar.test.tsx — smoke tests for ListToolbar.
 *
 * `@/components/ui/select` is mocked to a plain, clickable stand-in (the
 * established pattern in this repo — see environment-selector.test.tsx —
 * since the real Base UI Select renders through a portal and isn't worth
 * exercising again here; `select.tsx` itself already has render tests in
 * `packages/ui`).
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ListToolbar } from "./list-toolbar";

afterEach(cleanup);

vi.mock("@/components/ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: React.ReactNode;
    onValueChange?: (v: string) => void;
  }) => (
    <div data-testid="sort-select" onClick={() => onValueChange?.("newest")}>
      {children}
    </div>
  ),
  SelectTrigger: ({
    children,
    "aria-label": ariaLabel,
  }: {
    children: React.ReactNode;
    "aria-label"?: string;
  }) => <div aria-label={ariaLabel}>{children}</div>,
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

describe("ListToolbar — search", () => {
  it("renders the search input with the given placeholder", () => {
    render(
      <ListToolbar
        query=""
        onQueryChange={vi.fn()}
        searchPlaceholder="Search agents…"
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByPlaceholderText("Search agents…")).toBeInTheDocument();
  });

  it("calls onQueryChange as the user types", async () => {
    const onQueryChange = vi.fn();
    render(
      <ListToolbar query="" onQueryChange={onQueryChange} onExport={vi.fn()} />,
    );
    await userEvent.type(screen.getByPlaceholderText("Search…"), "ab");
    expect(onQueryChange).toHaveBeenCalledWith("a");
    expect(onQueryChange).toHaveBeenCalledWith("b");
  });

  it("uses searchLabel for the accessible name when provided", () => {
    render(
      <ListToolbar
        query=""
        onQueryChange={vi.fn()}
        searchPlaceholder="Search…"
        searchLabel="Search the agent list"
        onExport={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Search the agent list")).toBeInTheDocument();
  });
});

describe("ListToolbar — sort", () => {
  it("does not render a sort control with zero sort options", () => {
    render(<ListToolbar query="" onQueryChange={vi.fn()} onExport={vi.fn()} />);
    expect(screen.queryByTestId("sort-select")).toBeNull();
  });

  it("does not render a sort control with exactly one sort option", () => {
    render(
      <ListToolbar
        query=""
        onQueryChange={vi.fn()}
        sortOptions={[{ id: "name", label: "Name" }]}
        sortId="name"
        onSortChange={vi.fn()}
        onExport={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("sort-select")).toBeNull();
  });

  it("renders the sort control with more than one sort option and calls onSortChange", async () => {
    const onSortChange = vi.fn();
    render(
      <ListToolbar
        query=""
        onQueryChange={vi.fn()}
        sortOptions={[
          { id: "name", label: "Name" },
          { id: "newest", label: "Newest" },
        ]}
        sortId="name"
        onSortChange={onSortChange}
        onExport={vi.fn()}
      />,
    );
    await userEvent.click(screen.getByTestId("sort-select"));
    expect(onSortChange).toHaveBeenCalledWith("newest");
  });
});

describe("ListToolbar — export + children", () => {
  it("renders an Export button that calls onExport when clicked", async () => {
    const onExport = vi.fn();
    render(
      <ListToolbar query="" onQueryChange={vi.fn()} onExport={onExport} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(onExport).toHaveBeenCalledOnce();
  });

  it("supports a custom export label", () => {
    render(
      <ListToolbar
        query=""
        onQueryChange={vi.fn()}
        onExport={vi.fn()}
        exportLabel="Download CSV"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Download CSV" }),
    ).toBeInTheDocument();
  });

  it("renders the children slot", () => {
    render(
      <ListToolbar query="" onQueryChange={vi.fn()} onExport={vi.fn()}>
        <button type="button">New agent</button>
      </ListToolbar>,
    );
    expect(
      screen.getByRole("button", { name: "New agent" }),
    ).toBeInTheDocument();
  });
});
