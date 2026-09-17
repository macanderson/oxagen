// @vitest-environment jsdom
/**
 * audit-filter-bar.test.tsx — component tests for AuditFilterBar.
 *
 * Covers:
 *   (a) Renders "All events" chip + at least one group chip.
 *   (b) Free-text search input renders with correct aria-label.
 *   (c) Outcome select renders with "All outcomes" default option.
 *   (d) From/To date inputs render with correct aria-labels.
 *   (e) No "Clear" button when no filters are active (hasFilter=false).
 *   (f) "Clear" button appears when selectedEventTypes is non-empty.
 *   (g) Clicking "All events" chip removes event_type params and navigates.
 *   (h) Clicking a group chip adds its event types to search params.
 *   (i) Clicking an active group chip removes its event types.
 *   (j) Submitting the search form commits the text param to the URL.
 *   (k) Changing outcome select updates the outcome param in the URL.
 *   (l) Active event-type badges render below the chips.
 *   (m) External Q change re-syncs the text input (derived state).
 *   (n) "Clear" button clears all filter params and navigates.
 */

import * as React from "react";
import {
  render,
  screen,
  waitFor,
  cleanup,
  fireEvent,
} from "@testing-library/react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockPush, mockPathname, mockSearchParamsValue } = vi.hoisted(() => ({
  mockPush: vi.fn(),
  mockPathname: { value: "/acme/security/audit" },
  mockSearchParamsValue: { value: new URLSearchParams() },
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => mockPathname.value,
  useSearchParams: () => mockSearchParamsValue.value,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onClick,
    variant: _v,
    size: _s,
    className: _c,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    variant?: string;
    size?: string;
    className?: string;
  }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({
    children,
    variant: _v,
    className: _c,
  }: {
    children: React.ReactNode;
    variant?: string;
    className?: string;
  }) => <span data-testid="badge">{children}</span>,
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

// ---------------------------------------------------------------------------
// Import under test + lib constants used in assertions
// ---------------------------------------------------------------------------

import { AuditFilterBar } from "./audit-filter-bar";
import { EVENT_TYPE_GROUPS, eventTypesInGroup } from "@/lib/audit-filters";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PATHNAME = "/acme/security/audit";

function noFiltersProps() {
  return {
    selectedEventTypes: [],
    selectedOutcome: null,
    q: null,
    from: null,
    to: null,
  };
}

// Helper: parse the URL passed to router.push
function parsedPush(callIndex = 0): URLSearchParams {
  const url: string = mockPush.mock.calls[callIndex]![0];
  const qs = url.includes("?") ? url.split("?")[1]! : "";
  return new URLSearchParams(qs);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AuditFilterBar", () => {
  afterEach(() => cleanup());

  beforeEach(() => {
    vi.clearAllMocks();
    mockPathname.value = PATHNAME;
    mockSearchParamsValue.value = new URLSearchParams();
  });

  // (a) Renders "All events" chip + group chips
  it("renders the 'All events' chip and at least one group chip", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);

    expect(
      screen.getByRole("button", { name: "All events" }),
    ).toBeInTheDocument();
    // At least one group chip should be present (e.g. "auth.*")
    expect(EVENT_TYPE_GROUPS.length).toBeGreaterThan(0);
    expect(
      screen.getByRole("button", { name: `${EVENT_TYPE_GROUPS[0]}.*` }),
    ).toBeInTheDocument();
  });

  // (b) Free-text search input
  it("renders the free-text filter input with correct aria-label", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);
    expect(
      screen.getByLabelText(/free-text audit filter/i),
    ).toBeInTheDocument();
  });

  // (c) Outcome select
  it("renders the outcome select with 'All outcomes' as default option", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);

    const select = screen.getByLabelText(
      /outcome filter/i,
    ) as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    // The first option should be "All outcomes"
    expect(select.options[0]!.text).toBe("All outcomes");
    expect(select.value).toBe("");
  });

  // (d) Date inputs
  it("renders from and to date inputs", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);
    expect(screen.getByLabelText(/from date/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/to date/i)).toBeInTheDocument();
  });

  // (e) No Clear button when no filters active
  it("does not render a Clear button when no filters are active", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);
    expect(
      screen.queryByRole("button", { name: /clear/i }),
    ).not.toBeInTheDocument();
  });

  // (f) Clear button appears with active event types
  it("renders a Clear button when selectedEventTypes is non-empty", () => {
    const types = eventTypesInGroup(EVENT_TYPE_GROUPS[0]!);
    render(<AuditFilterBar {...noFiltersProps()} selectedEventTypes={types} />);
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  // (f2) Clear button appears with active outcome
  it("renders a Clear button when selectedOutcome is set", () => {
    render(<AuditFilterBar {...noFiltersProps()} selectedOutcome="allow" />);
    expect(screen.getByRole("button", { name: /clear/i })).toBeInTheDocument();
  });

  // (g) Clicking "All events" removes event_type params
  it("clicking 'All events' deletes event_type params and navigates", () => {
    mockSearchParamsValue.value = new URLSearchParams(
      "event_type=auth.sign_in",
    );

    const types = eventTypesInGroup(EVENT_TYPE_GROUPS[0]!);
    render(<AuditFilterBar {...noFiltersProps()} selectedEventTypes={types} />);

    fireEvent.click(screen.getByRole("button", { name: "All events" }));

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    expect(sp.getAll("event_type")).toHaveLength(0);
  });

  // (h) Clicking an inactive group chip adds its event types
  it("clicking an inactive group chip adds all its event types to the URL", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);

    const group = EVENT_TYPE_GROUPS[0]!;
    const groupTypes = eventTypesInGroup(group);

    fireEvent.click(screen.getByRole("button", { name: `${group}.*` }));

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    const inUrl = sp.getAll("event_type");
    for (const t of groupTypes) {
      expect(inUrl).toContain(t);
    }
  });

  // (i) Clicking an active group chip removes its event types
  it("clicking an active group chip removes its event types from the URL", () => {
    const group = EVENT_TYPE_GROUPS[0]!;
    const types = eventTypesInGroup(group);
    // Pre-seed search params with the group's types
    const sp = new URLSearchParams();
    for (const t of types) sp.append("event_type", t);
    mockSearchParamsValue.value = sp;

    render(<AuditFilterBar {...noFiltersProps()} selectedEventTypes={types} />);

    fireEvent.click(screen.getByRole("button", { name: `${group}.*` }));

    expect(mockPush).toHaveBeenCalledOnce();
    const result = parsedPush();
    expect(result.getAll("event_type")).toHaveLength(0);
  });

  // (j) Submitting the search form commits q param
  it("submitting the search form sets the q param in the URL", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);

    const input = screen.getByLabelText(/free-text audit filter/i);
    fireEvent.change(input, { target: { value: "auth.sign_in" } });

    // Submit the form wrapping the search input
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    expect(sp.get("q")).toBe("auth.sign_in");
  });

  // (j2) Submitting empty text removes q param
  it("submitting empty text removes the q param", () => {
    mockSearchParamsValue.value = new URLSearchParams("q=previous");
    render(<AuditFilterBar {...noFiltersProps()} q="previous" />);

    const input = screen.getByLabelText(
      /free-text audit filter/i,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.submit(input.closest("form")!);

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    expect(sp.has("q")).toBe(false);
  });

  // (k) Outcome select updates outcome param
  it("changing the outcome select updates the outcome param in the URL", () => {
    render(<AuditFilterBar {...noFiltersProps()} />);

    const select = screen.getByLabelText(/outcome filter/i);
    fireEvent.change(select, { target: { value: "deny" } });

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    expect(sp.get("outcome")).toBe("deny");
  });

  it("selecting 'All outcomes' (empty string) removes the outcome param", () => {
    mockSearchParamsValue.value = new URLSearchParams("outcome=allow");
    render(<AuditFilterBar {...noFiltersProps()} selectedOutcome="allow" />);

    const select = screen.getByLabelText(/outcome filter/i);
    fireEvent.change(select, { target: { value: "" } });

    expect(mockPush).toHaveBeenCalledOnce();
    const sp = parsedPush();
    expect(sp.has("outcome")).toBe(false);
  });

  // (l) Active event-type badges
  it("renders badges for each active event type", () => {
    const types = eventTypesInGroup(EVENT_TYPE_GROUPS[0]!);
    render(<AuditFilterBar {...noFiltersProps()} selectedEventTypes={types} />);

    const badges = screen.getAllByTestId("badge");
    expect(badges.length).toBeGreaterThanOrEqual(types.length);
    for (const t of types) {
      expect(
        screen.getAllByTestId("badge").some((b) => b.textContent === t),
      ).toBe(true);
    }
  });

  // (m) External Q change re-syncs the text input
  it("re-syncs text input when the q prop changes (derived state pattern)", () => {
    const { rerender } = render(
      <AuditFilterBar {...noFiltersProps()} q="first" />,
    );

    const input = screen.getByLabelText(
      /free-text audit filter/i,
    ) as HTMLInputElement;
    expect(input.value).toBe("first");

    rerender(<AuditFilterBar {...noFiltersProps()} q="second" />);
    expect(input.value).toBe("second");
  });

  // (n) Clear button clears all params
  it("clicking Clear removes all filter params and navigates", () => {
    const sp = new URLSearchParams();
    sp.set("outcome", "allow");
    sp.set("q", "auth.sign_in");
    mockSearchParamsValue.value = sp;

    render(
      <AuditFilterBar
        selectedEventTypes={[]}
        selectedOutcome="allow"
        q="auth.sign_in"
        from={null}
        to={null}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /clear/i }));

    expect(mockPush).toHaveBeenCalledOnce();
    const result = parsedPush();
    expect(result.has("outcome")).toBe(false);
    expect(result.has("q")).toBe(false);
    expect(result.has("event_type")).toBe(false);
  });

  // cursor is dropped on any filter change
  it("drops the cursor param on every navigation (page reset)", () => {
    const sp = new URLSearchParams("cursor=2026-01-01T00:00:00Z|row-123");
    mockSearchParamsValue.value = sp;

    render(<AuditFilterBar {...noFiltersProps()} />);

    fireEvent.click(screen.getByRole("button", { name: "All events" }));

    const result = parsedPush();
    expect(result.has("cursor")).toBe(false);
  });
});
