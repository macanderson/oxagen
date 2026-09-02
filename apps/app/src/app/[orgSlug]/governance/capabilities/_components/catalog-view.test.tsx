// @vitest-environment jsdom
/**
 * catalog-view.test.tsx — unit tests for CatalogView.
 *
 * The ContractDrawer child is mocked to a thin probe (its own rendering is
 * covered by contract-drawer.test.tsx) so these tests focus on CatalogView's
 * own responsibilities: rendering the filterable table from `rows`, applying
 * search/domain/gap filters client-side, seeding filters from
 * `initialFilter` (the hub's ?missingLayer= deep link), and opening a row —
 * which must call fetchCapabilityInsights and pass its result to the drawer.
 */
import * as React from "react";
import { render, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import { CatalogView } from "./catalog-view";

afterEach(() => cleanup());

const mockFetchInsights = vi.fn();

vi.mock("../actions", () => ({
  fetchCapabilityInsights: (...args: unknown[]) => mockFetchInsights(...args),
}));

vi.mock("./contract-drawer", () => ({
  ContractDrawer: ({
    open,
    summary,
    insights,
  }: {
    open: boolean;
    summary: CapabilityRegistrySummary | null;
    insights: { detail: unknown } | null;
  }) =>
    open ? (
      <div data-testid="drawer-probe">
        <span>{summary?.name}</span>
        <span>{insights ? "insights-loaded" : "insights-pending"}</span>
      </div>
    ) : null,
}));

function row(
  over: Partial<CapabilityRegistrySummary>,
): CapabilityRegistrySummary {
  return {
    name: "cap_x",
    domain: "test",
    description: "does x",
    mode: "sync",
    surfaces: ["api", "mcp"],
    layers: ["api", "mcp", "docs", "app"],
    sensitivity: "low",
    defaultEffect: "deny",
    scoped: true,
    noBillingGate: false,
    agent: null,
    auditTargetKind: null,
    plugin: null,
    orgRoles: { Owner: "allow" },
    workspaceRoles: {},
    ...over,
  };
}

const ROWS: CapabilityRegistrySummary[] = [
  row({
    name: "query_audit_log",
    domain: "audit",
    description: "query the spine",
  }),
  row({ name: "list_iam_roles", domain: "iam", layers: ["api", "mcp"] }),
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchInsights.mockResolvedValue({
    detail: null,
    usage: null,
    audit: null,
  });
});

describe("CatalogView", () => {
  it("renders one row per capability with the total count", () => {
    const { getByTestId, getByText } = render(
      <CatalogView orgSlug="acme" rows={ROWS} domains={["audit", "iam"]} />,
    );
    expect(getByTestId("capability-row-query_audit_log")).toBeDefined();
    expect(getByTestId("capability-row-list_iam_roles")).toBeDefined();
    expect(getByText("2 of 2 contracts")).toBeDefined();
  });

  it("filters rows by search text", () => {
    const { getByLabelText, getByTestId, queryByTestId, getByText } = render(
      <CatalogView orgSlug="acme" rows={ROWS} domains={["audit", "iam"]} />,
    );
    fireEvent.change(getByLabelText("Search capabilities"), {
      target: { value: "spine" },
    });
    expect(getByTestId("capability-row-query_audit_log")).toBeDefined();
    expect(queryByTestId("capability-row-list_iam_roles")).toBeNull();
    expect(getByText("1 of 2 contracts")).toBeDefined();
  });

  it("shows the empty state when no rows match", () => {
    const { getByLabelText, getByText, queryByTestId } = render(
      <CatalogView orgSlug="acme" rows={ROWS} domains={["audit", "iam"]} />,
    );
    fireEvent.change(getByLabelText("Search capabilities"), {
      target: { value: "no-such-capability" },
    });
    expect(getByText("No capabilities match your filters")).toBeDefined();
    expect(queryByTestId("capability-row-query_audit_log")).toBeNull();
  });

  it("seeds the filter from initialFilter (the governance-hub deep link)", () => {
    const { getByText } = render(
      <CatalogView
        orgSlug="acme"
        rows={ROWS}
        domains={["audit", "iam"]}
        initialFilter={{ missingLayer: "docs" }}
      />,
    );
    // Only list_iam_roles is missing "docs"; query_audit_log has it.
    expect(getByText("1 of 2 contracts")).toBeDefined();
    expect(getByText(/missing layer: docs/)).toBeDefined();
  });

  it("opens the drawer immediately with the clicked row's summary, then loads insights", async () => {
    const { getByTestId } = render(
      <CatalogView orgSlug="acme" rows={ROWS} domains={["audit", "iam"]} />,
    );
    fireEvent.click(getByTestId("capability-row-query_audit_log"));

    const probe = getByTestId("drawer-probe");
    expect(probe.textContent).toContain("query_audit_log");
    expect(probe.textContent).toContain("insights-pending");

    await waitFor(() => {
      expect(mockFetchInsights).toHaveBeenCalledWith("acme", "query_audit_log");
    });
    await waitFor(() => {
      expect(getByTestId("drawer-probe").textContent).toContain(
        "insights-loaded",
      );
    });
  });
});
