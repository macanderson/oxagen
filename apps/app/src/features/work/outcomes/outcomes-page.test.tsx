// @vitest-environment jsdom
// Outcomes over a fake DataSource: the six tiles and the four panels for the
// last 30 days, the first run with nothing finished, a cost no run reported,
// a lead time with no sample, and a failed read. Each state runs the axe
// check (INV-26).
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkOutcomes } from "@/data/contracts/work";
import { type Read, readError } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { outcomes, workSource } from "../work-list.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkOutcomesPage } = await import("./outcomes-page");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "a-intel",
  orgName: "Anderson Intelligence Corp.",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

async function renderOutcomes(read: Read<WorkOutcomes>) {
  const { source, calls } = workSource({ outcomes: read });
  const element = await WorkOutcomesPage({ ctx, source });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

const tile = (name: string) => screen.getByTestId(`work-outcome-${name}`);

/** Nothing finished and no run in the window. */
const NOTHING: Partial<WorkOutcomes> = {
  acceptedMerged: 0,
  returned: 0,
  closed: { cancelled: 0, declined: 0, duplicate: 0 },
  leadTime: { medianHours: null, p90Hours: null, sample: 0 },
  touches: {
    perItem: null,
    briefApprovals: 0,
    acceptances: 0,
    returns: 0,
    triageOverrides: 0,
    triageCorrections: 0,
  },
  cost: { runs: 0, knownRuns: 0, total: null },
  reopens: { cohort: 0, reopened: 0, waiting: 0 },
  weeks: [],
};

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Outcomes › the last 30 days", () => {
  it("reads the outcomes once and names the window under the heading", async () => {
    const { calls } = await renderOutcomes(outcomes());
    expect(calls).toEqual([{ read: "work.outcomes", args: [ctx] }]);
    expect(
      screen.getByRole("heading", { level: 1, name: "Outcomes" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Work that finished in the last 30 days."),
    ).toBeInTheDocument();
  });

  it("draws six tiles, each with its figure and the fact under it", async () => {
    await renderOutcomes(outcomes());
    expect(tile("accepted")).toHaveTextContent("Accepted and merged23Last 30 days");
    expect(tile("returned")).toHaveTextContent("Returned6Returns before acceptance");
    const closed = tile("closed");
    expect(closed).toHaveTextContent("Closed9");
    expect(closed.querySelector('[data-closed="cancelled"]')).toHaveTextContent("2 cancelled");
    expect(closed.querySelector('[data-closed="declined"]')).toHaveTextContent("3 declined");
    expect(closed.querySelector('[data-closed="duplicate"]')).toHaveTextContent("4 duplicates");
    expect(tile("lead-time")).toHaveTextContent("19.5 h");
    expect(tile("lead-time")).toHaveTextContent("p90 71 h across 23 items");
    expect(tile("touches")).toHaveTextContent("Review touches2.4Per accepted item");
    expect(tile("cost")).toHaveTextContent("$412.37");
    expect(tile("cost")).toHaveTextContent("Known for 61 of 66 runs");
  });

  it("never adds accepted, returned and closed into one figure", async () => {
    await renderOutcomes(outcomes());
    expect(document.body.textContent).not.toContain("38");
    expect(document.body.textContent).not.toMatch(/%/);
  });

  it("draws the weekly trend with a week that has no lead time", async () => {
    await renderOutcomes(outcomes());
    const weeks = screen.getByTestId("work-outcomes-weeks");
    const table = within(weeks).getByRole("table", { name: "Weekly trend" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Week of", "Accepted and merged", "Returned", "Median lead time"]);
    const rows = [...table.querySelectorAll("tr[data-week]")].map((row) =>
      [...row.querySelectorAll("td")].map((td) => td.textContent),
    );
    expect(rows).toEqual([
      ["Sep 7", "5", "2", "22 h"],
      ["Sep 14", "8", "1", "18.5 h"],
      ["Sep 21", "10", "3", "none"],
    ]);
  });

  it("counts the touches by kind", async () => {
    await renderOutcomes(outcomes());
    const touches = screen.getByTestId("work-outcomes-touches");
    expect(touches.querySelector('[data-touch="briefApprovals"]')).toHaveTextContent(
      "Brief approvals25",
    );
    expect(touches.querySelector('[data-touch="triageCorrections"]')).toHaveTextContent(
      "Triage corrections8",
    );
  });

  it("says how much of the cost is known and that triage spend is on Billing", async () => {
    await renderOutcomes(outcomes());
    const cost = screen.getByTestId("work-outcomes-cost");
    expect(cost).toHaveTextContent(
      "$412.37 recorded. Cost is known for 61 of 66 runs.",
    );
    expect(cost).toHaveTextContent(
      "An unknown cost stays unknown and adds nothing to the total.",
    );
    expect(within(cost).getByRole("link", { name: "Billing" })).toHaveAttribute(
      "href",
      "/a-intel/billing",
    );
  });

  it("counts reopens in the old cohort and says reverts are not recorded", async () => {
    await renderOutcomes(outcomes());
    const reopens = screen.getByTestId("work-outcomes-reopens");
    expect(reopens.querySelector('[data-figure="cohort"]')).toHaveTextContent("14");
    expect(reopens.querySelector('[data-figure="reopened"]')).toHaveTextContent("1");
    expect(reopens).toHaveTextContent(
      "9 newer items wait for their 30 days before counting here.",
    );
    expect(reopens).toHaveTextContent("oxagen does not record reverts yet.");
  });
});

describe("Outcomes › unknown figures", () => {
  it("reads an unknown cost as unknown and never as $0.00", async () => {
    await renderOutcomes(
      outcomes({ cost: { runs: 5, knownRuns: 0, total: null } }),
    );
    expect(tile("cost")).toHaveTextContent("Unknown");
    expect(tile("cost")).toHaveTextContent("Known for 0 of 5 runs");
    expect(screen.getByTestId("work-outcomes-cost")).toHaveTextContent(
      "Cost is unknown for all 5 runs in this window.",
    );
    expect(document.body.textContent).not.toContain("$0.00");
  });

  it("says a lead time has no sample when nothing finished", async () => {
    await renderOutcomes(
      outcomes({
        leadTime: { medianHours: null, p90Hours: null, sample: 0 },
        touches: {
          perItem: null,
          briefApprovals: 3,
          acceptances: 0,
          returns: 2,
          triageOverrides: 0,
          triageCorrections: 1,
        },
      }),
    );
    expect(tile("lead-time")).toHaveTextContent("No sample");
    expect(tile("lead-time")).toHaveTextContent("No item finished in this window");
    expect(tile("touches")).toHaveTextContent("No sample");
  });
});

describe("Outcomes › first run and failures", () => {
  it("says nothing finished yet and points at Work setup", async () => {
    await renderOutcomes(outcomes(NOTHING));
    const empty = screen.getByTestId("work-outcomes-empty");
    expect(empty).toHaveTextContent("No finished work");
    expect(within(empty).getByRole("link", { name: "Open Work setup" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work/setup",
    );
    expect(screen.queryByTestId("work-outcome-accepted")).toBeNull();
  });

  it("names the code when the outcomes read fails", async () => {
    await renderOutcomes(readError("work_records_unavailable", 503));
    const error = screen.getByTestId("work-error");
    expect(error).toHaveTextContent("Outcomes could not be loaded");
    expect(error).toHaveTextContent("503 work_records_unavailable");
    expect(
      screen.queryByText("Work that finished in the last 30 days."),
    ).toBeNull();
  });

  it("names the permission when the outcomes read is refused", async () => {
    await renderOutcomes({ ok: false, reason: "denied", permission: "run.read" });
    expect(screen.getByTestId("work-denied")).toHaveTextContent("No access to Outcomes");
  });
});
