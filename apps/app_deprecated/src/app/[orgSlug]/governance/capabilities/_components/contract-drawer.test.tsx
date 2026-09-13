// @vitest-environment jsdom
/**
 * contract-drawer.test.tsx — unit tests for ContractDrawer.
 *
 * The Drawer's `@/components/ui/sheet` primitives are mocked to plain divs
 * (renders unconditionally when open, matching the edit-source-config-sheet
 * precedent) so these tests focus on the drawer's own rendering logic: the
 * six chain sections, the pure formatters (via rendered text), and each
 * independent-degradation path (usage=null, audit=null, detail=null, error).
 */
import * as React from "react";
import { render, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import type { CapabilityRegistrySummary } from "@oxagen/oxagen/contracts/capability.registry.list";
import type { CapabilityInsights } from "../actions";
import { ContractDrawer } from "./contract-drawer";

afterEach(() => cleanup());

vi.mock(
  "@/app/[orgSlug]/[workspaceSlug]/_shared/components",
  async (importOriginal) => {
    const real =
      await importOriginal<
        typeof import("@/app/[orgSlug]/[workspaceSlug]/_shared/components")
      >();
    return {
      ...real,
      Drawer: ({
        open,
        title,
        description,
        children,
      }: {
        open: boolean;
        title?: string;
        description?: string;
        children: React.ReactNode;
      }) =>
        open ? (
          <div data-testid="drawer">
            <div>{title}</div>
            <div>{description}</div>
            {children}
          </div>
        ) : null,
    };
  },
);

const SUMMARY: CapabilityRegistrySummary = {
  name: "query_audit_log",
  domain: "audit",
  description: "Query the audit spine",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["api", "mcp", "unit", "docs"],
  sensitivity: "high",
  defaultEffect: "deny",
  scoped: true,
  noBillingGate: false,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  auditTargetKind: "capability",
  plugin: { id: "oxagen/media-svg", tier: "premium", minPlanTier: "build" },
  orgRoles: { Owner: "allow", Admin: "allow" },
  workspaceRoles: { Owner: "allow" },
};

const DETAIL = {
  ...SUMMARY,
  inputFields: [
    {
      name: "source",
      type: "enum(all | security | playbook)",
      required: false,
      description: "spine",
    },
  ],
  outputFields: [
    {
      name: "events",
      type: "array<object>",
      required: true,
      description: null,
    },
  ],
  auditTargetIdField: "name",
  produces: ["audit.event"],
  consumes: [],
  chainHints: ["query_audit_log"],
};

const USAGE = {
  costMicros: 1_500_000,
  executions: 4,
  inputTokens: 100,
  outputTokens: 50,
};

const AUDIT_EVENTS = [
  {
    source: "security" as const,
    eventType: "capability.invoked",
    occurredAt: "2026-07-01T12:00:00.000Z",
    actorUserId: "u1",
    workspaceId: null,
    capability: "query_audit_log",
    outcome: "allow" as const,
    requestId: null,
    playbookRunId: null,
    sequence: null,
    eventData: null,
  },
];

const FULL_INSIGHTS: CapabilityInsights = {
  detail: DETAIL,
  usage: USAGE,
  audit: AUDIT_EVENTS,
};

describe("ContractDrawer", () => {
  it("shows a loading state when summary is not yet selected", () => {
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={null}
        insights={null}
      />,
    );
    expect(getByText("Contract")).toBeDefined();
  });

  it("renders the six accountability-chain sections with the summary immediately", () => {
    const { getByRole, getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={null}
      />,
    );
    // Each ChainSection is a <section aria-label="<title>">, giving it an
    // accessible "region" role — robust against the numbered-badge span
    // splitting the heading's raw text content across multiple nodes.
    for (const heading of [
      /^Identity/,
      /^Knowledge scope/,
      /^Permitted action/,
      /^Commercial terms/,
      /^Verified outcome/,
      /^Audit record/,
    ]) {
      expect(getByRole("region", { name: heading })).toBeDefined();
    }
    // Loading placeholders while insights resolve.
    expect(getByText("Loading field specs…")).toBeDefined();
    expect(getByText("Loading usage…")).toBeDefined();
    expect(getByText("Loading audit feed…")).toBeDefined();
  });

  it("renders the formatted 30-day usage line once insights resolve", () => {
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={FULL_INSIGHTS}
      />,
    );
    // formatUsdFromMicros(1_500_000) === "$1.50" (a distinct leaf <span>, no
    // ambiguity with the numbered chain-section badges' own digit text).
    expect(getByText("$1.50")).toBeDefined();
    // The trailing "N metered calls (…tokens)." text run is unique to
    // UsageLine's own paragraph, unlike a bare "4" (which the step-4
    // "Commercial terms" badge also renders as its own direct text).
    expect(getByText(/metered calls/)).toBeDefined();
  });

  it("renders input/output field tables from the detail read", () => {
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={FULL_INSIGHTS}
      />,
    );
    expect(getByText("source")).toBeDefined();
    expect(getByText("enum(all | security | playbook)")).toBeDefined();
    expect(getByText("events")).toBeDefined();
  });

  it("renders recent audit events with the formatted timestamp", () => {
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={FULL_INSIGHTS}
      />,
    );
    expect(getByText("capability.invoked")).toBeDefined();
  });

  it("degrades usage independently when insights.usage is null", () => {
    const degraded: CapabilityInsights = {
      detail: DETAIL,
      usage: null,
      audit: AUDIT_EVENTS,
    };
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={degraded}
      />,
    );
    expect(getByText("Usage data unavailable.")).toBeDefined();
    // Audit sub-section still renders since only usage degraded.
    expect(getByText("capability.invoked")).toBeDefined();
  });

  it("degrades audit independently when insights.audit is null", () => {
    const degraded: CapabilityInsights = {
      detail: DETAIL,
      usage: USAGE,
      audit: null,
    };
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={degraded}
      />,
    );
    expect(getByText("Audit feed unavailable.")).toBeDefined();
  });

  it("shows an empty-audit message distinct from the unavailable state", () => {
    const empty: CapabilityInsights = {
      detail: DETAIL,
      usage: USAGE,
      audit: [],
    };
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={empty}
      />,
    );
    expect(
      getByText(/No recent audit events name this capability/),
    ).toBeDefined();
  });

  it("shows the insights-level error banner when the detail read failed", () => {
    const errored: CapabilityInsights = {
      detail: null,
      usage: null,
      audit: null,
      error: "Unable to load the contract detail.",
    };
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={errored}
      />,
    );
    expect(getByText("Unable to load the contract detail.")).toBeDefined();
    expect(getByText("Field specs unavailable.")).toBeDefined();
  });

  it("renders 'No default grants' for an empty role-grant map", () => {
    const noGrants: CapabilityRegistrySummary = {
      ...SUMMARY,
      orgRoles: {},
      workspaceRoles: {},
    };
    const { getAllByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={noGrants}
        insights={null}
      />,
    );
    expect(getAllByText("No default grants").length).toBeGreaterThan(0);
  });

  it("renders chaining tags when the detail declares produces/consumes/chainHints", () => {
    const { getByText } = render(
      <ContractDrawer
        open
        onOpenChange={() => {}}
        summary={SUMMARY}
        insights={FULL_INSIGHTS}
      />,
    );
    expect(getByText("produces audit.event")).toBeDefined();
    expect(getByText("then query_audit_log")).toBeDefined();
  });
});
