// @vitest-environment jsdom
// Fleet over a fake DataSource: the two-tile stat strip, the approvals panel
// and the runs table, each in its ok, empty, denied and error states, with an
// axe check in every one. The tiles count the rows the sections render, and a
// card whose parked call drew on a mandate carries the mandate bar.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalItem } from "@/data/contracts/approvals";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  mandateAuthority,
  mandateList,
  mandateRow,
} from "@/test/mandate-views";
import {
  approvalItem,
  fleetSource,
  NOW,
  runPage,
  runRow,
} from "./fleet.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { Fleet } = await import("./fleet");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "owner",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const DENIED = {
  ok: false,
  reason: "denied",
  permission: "workspace.read",
} as const;
const DOWN = readError("run_index_unavailable", 503);
const NO_APPROVALS = readOk<ApprovalItem[]>([]);
const NO_RUNS = runPage([]);

async function renderFleet(
  reads: Parameters<typeof fleetSource>[0],
  cursor: string | null = null,
) {
  const { source, calls } = fleetSource(reads);
  const element = await Fleet({ ctx, source, cursor });
  const { container } = render(<IntlProvider>{element}</IntlProvider>);
  return { container, calls };
}

const strip = () => screen.queryByRole("region", { name: "Fleet summary" });
const tile = (title: string) => {
  const found = screen
    .getAllByTestId("tile")
    .find((t) => within(t).queryByText(title) !== null);
  if (found === undefined) throw new Error(`no ${title} tile`);
  return found;
};
const approvalsSection = () =>
  screen.getByRole("region", { name: "Approvals" });
const runsSection = () => screen.getByRole("region", { name: "Runs" });

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
});

describe("Fleet reads", () => {
  it("reads one runs page at the URL's cursor and the workspace's pending approvals", async () => {
    const { calls } = await renderFleet(
      { runs: NO_RUNS, approvals: NO_APPROVALS },
      "c1",
    );
    expect(calls.runs).toEqual([[ctx, { cursor: "c1" }]]);
    expect(calls.approvals).toEqual([[ctx, { runId: null }]]);
  });
});

describe("stat strip", () => {
  it("draws exactly the Live runs and Waiting on a human tiles, counted from the rows on the page", async () => {
    await renderFleet({
      runs: runPage([
        runRow({ id: "arun_a1", status: "live" }),
        runRow({ id: "arun_a2", status: "live", agentKey: "acme.core.docs" }),
        runRow({ id: "arun_a3", status: "sealed", agentKey: null }),
      ]),
      approvals: readOk([
        approvalItem({
          id: "apr_new",
          createdAt: new Date(NOW - 30_000).toISOString(),
        }),
        approvalItem({ id: "apr_old" }),
      ]),
    });
    expect(screen.getAllByTestId("tile")).toHaveLength(2);
    expect(tile("Live runs")).toHaveTextContent(
      "Live runs2of 2 agents in this workspace",
    );
    expect(tile("Waiting on a human")).toHaveTextContent(
      "Waiting on a human2oldest approval has waited 2:30 of 10:00",
    );
    expect(strip()).not.toHaveTextContent(/spend|cache/i);
  });

  it("counts an empty workspace as zero and says nothing is parked", async () => {
    await renderFleet({ runs: NO_RUNS, approvals: NO_APPROVALS });
    expect(tile("Live runs")).toHaveTextContent(
      "Live runs0of 0 agents in this workspace",
    );
    expect(tile("Waiting on a human")).toHaveTextContent(
      "Waiting on a human0nothing is parked",
    );
  });

  it("drops the tile whose read was denied and keeps the other (negative)", async () => {
    await renderFleet({ runs: DENIED, approvals: NO_APPROVALS });
    expect(screen.getAllByTestId("tile")).toHaveLength(1);
    expect(strip()).not.toHaveTextContent("Live runs");
    expect(strip()).toHaveTextContent("Waiting on a human");
  });

  it("drops the tile whose read failed, and the whole strip when both did (negative)", async () => {
    await renderFleet({ runs: runPage([runRow()]), approvals: DOWN });
    expect(strip()).not.toHaveTextContent("Waiting on a human");
    cleanup();
    await renderFleet({ runs: DOWN, approvals: DENIED });
    expect(strip()).toBeNull();
  });
});

describe("approvals panel", () => {
  it("draws one card per pending approval with its tool, agent, requester and expiry clock", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([
        approvalItem(),
        approvalItem({
          id: "apr_r2",
          runId: "arun_7k2m9q",
          tool: "merge_pull_request",
          agentKey: "acme.core.release-bot",
          requester: null,
        }),
      ]),
    });
    const section = approvalsSection();
    expect(section).toHaveTextContent("2 parked");
    const [first, second] = within(section).getAllByTestId("approval");
    expect(first).toHaveTextContent(
      "create_releaseAgentnot recordedRequested byusr_marcusbellTimes out in 7:30, then the call ends",
    );
    expect(within(first ?? section).queryByRole("link")).toBeNull();
    expect(second).toHaveTextContent("Agentacme.core.release-bot");
    expect(second).toHaveTextContent("Requested bynot recorded");
    expect(
      within(second ?? section).getByRole("link", { name: "Open run" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_7k2m9q");
    expect(section).not.toHaveTextContent(/auto-approv/i);
  });

  it("says nothing is waiting on a human when the queue is empty", async () => {
    await renderFleet({ runs: NO_RUNS, approvals: NO_APPROVALS });
    expect(approvalsSection()).toHaveTextContent(
      "Nothing is waiting on a human.",
    );
    expect(within(approvalsSection()).queryAllByTestId("approval")).toEqual([]);
  });

  it("names the permission a denied read needed, with no cards (negative)", async () => {
    await renderFleet({ runs: NO_RUNS, approvals: DENIED });
    expect(approvalsSection()).toHaveTextContent(
      "You cannot see Approvals in this workspace. Your roles do not include workspace.read",
    );
    expect(approvalsSection()).not.toHaveTextContent("parked");
  });

  it("names the code a failed read answered (negative)", async () => {
    await renderFleet({ runs: NO_RUNS, approvals: DOWN });
    expect(approvalsSection()).toHaveTextContent(
      "Approvals could not be loaded: the control plane answered run_index_unavailable.",
    );
  });

  it("carries the request id of an access request still waiting (negative)", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: {
        ok: false,
        reason: "pending_approval",
        accessRequestId: "acr_91",
      },
    });
    expect(approvalsSection()).toHaveTextContent(
      "Access to Approvals is waiting for approval, request acr_91.",
    );
  });
});

describe("runs table", () => {
  it("draws a row per run: the generated name over the id, the agent identity, operator, status, replay grade, cost with its basis, frames and start", async () => {
    await renderFleet({
      runs: runPage([runRow()]),
      approvals: NO_APPROVALS,
    });
    const [row] = within(runsSection()).getAllByTestId("run-row");
    const cells = within(row ?? runsSection()).getAllByRole("cell");
    expect(cells.map((c) => c.textContent).slice(1)).toEqual([
      "reacme.core.release-botevidence ledger",
      "usr_marcusbell",
      "live",
      "fork",
      "$4.13gateway_observed",
      "1,204",
      "Sep 15, 2026, 8:00 AM",
    ]);
    // The run cell leads with what the run was, keeps the id under it, and
    // labels the model's sentence so it cannot read as the record.
    expect(cells[0]).toHaveTextContent("Cut the 3.2 release branch");
    expect(cells[0]).toHaveTextContent("arun_7k2m9q");
    expect(cells[0]).toHaveTextContent("ENG-4121 cut the 3.2 release");
    expect(cells[0]).toHaveTextContent("Cut release/3.2 from main");
    expect(cells[0]).toHaveTextContent("generated");
    expect(cells[0]).toHaveTextContent("Written by z-ai/glm-flash-latest on");
    expect(
      within(runsSection()).getByRole("link", {
        name: "Cut the 3.2 release branch",
      }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_7k2m9q");
  });

  it("heads a run with no generated name by its id, and says no summary was written", async () => {
    await renderFleet({
      runs: runPage([runRow({ name: null, summary: null })]),
      approvals: NO_APPROVALS,
    });
    const [row] = within(runsSection()).getAllByTestId("run-row");
    const cells = within(row ?? runsSection()).getAllByRole("cell");
    expect(cells[0]).toHaveTextContent(
      "No summary yet. Open the run to read its frames.",
    );
    expect(
      within(row ?? runsSection()).queryByTestId("generated-summary"),
    ).toBeNull();
    expect(
      within(runsSection()).getByRole("link", { name: "arun_7k2m9q" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_7k2m9q");
  });

  it("reads 'not recorded' for a null operator, cost and agent, and never draws a pill beside the agent", async () => {
    await renderFleet({
      runs: runPage([
        runRow({
          source: "tacho",
          agentKey: null,
          operatorId: null,
          cost: null,
          taskRef: null,
        }),
        runRow({
          id: "arun_b2",
          cost: { micros: "0", currency: "USD", basis: null },
        }),
      ]),
      approvals: NO_APPROVALS,
    });
    const [unrecorded, noBasis] = within(runsSection()).getAllByTestId(
      "run-row",
    );
    const cells = within(unrecorded ?? runsSection()).getAllByRole("cell");
    expect(cells[1]).toHaveTextContent(/^not recordedwrapped agent$/);
    expect(cells[2]).toHaveTextContent(/^not recorded$/);
    expect(cells[5]).toHaveTextContent(/^not recorded$/);
    expect(noBasis).toHaveTextContent("$0.00basis not recorded");
    expect(runsSection()).not.toHaveTextContent(/trust/i);
  });

  it("tells an empty workspace how its first run arrives, with the enroll command and no table", async () => {
    await renderFleet({ runs: NO_RUNS, approvals: NO_APPROVALS });
    expect(within(runsSection()).getByTestId("runs-empty")).toHaveTextContent(
      "No runs yet in Core platform",
    );
    expect(
      within(runsSection()).getByText("oxagen tacho enroll"),
    ).toBeInTheDocument();
    expect(within(runsSection()).queryByRole("table")).toBeNull();
  });

  it("links to the next page and, on a later page, back to the newest", async () => {
    await renderFleet({
      runs: runPage([runRow()], "c2"),
      approvals: NO_APPROVALS,
    });
    const pager = within(runsSection()).getByRole("navigation", {
      name: "Runs pages",
    });
    expect(
      within(pager).getByRole("link", { name: "Older runs" }),
    ).toHaveAttribute("href", "/acme/core-platform?cursor=c2");
    expect(
      within(pager).queryByRole("link", { name: "Newest runs" }),
    ).toBeNull();
    cleanup();
    await renderFleet({ runs: NO_RUNS, approvals: NO_APPROVALS }, "c2");
    expect(within(runsSection()).queryByTestId("runs-empty")).toBeNull();
    expect(
      within(runsSection()).getByRole("link", { name: "Newest runs" }),
    ).toHaveAttribute("href", "/acme/core-platform");
  });

  it("draws no pager on a single page (negative)", async () => {
    await renderFleet({ runs: runPage([runRow()]), approvals: NO_APPROVALS });
    expect(within(runsSection()).queryByRole("navigation")).toBeNull();
  });

  it("names the permission a denied read needed, with no table (negative)", async () => {
    await renderFleet({ runs: DENIED, approvals: NO_APPROVALS });
    expect(runsSection()).toHaveTextContent(
      "You cannot see Runs in this workspace.",
    );
    expect(within(runsSection()).queryByRole("table")).toBeNull();
    expect(within(runsSection()).queryByTestId("runs-empty")).toBeNull();
  });

  it("names the code a failed read answered, with no table (negative)", async () => {
    await renderFleet({ runs: DOWN, approvals: NO_APPROVALS });
    expect(runsSection()).toHaveTextContent(
      "Runs could not be loaded: the control plane answered run_index_unavailable.",
    );
    expect(within(runsSection()).queryByRole("table")).toBeNull();
  });
});

describe("Fleet approvals › the mandate bar", () => {
  const parked = approvalItem({ mandateId: "mnd_4f2a9c" });

  it("draws the bar of the mandate a parked call drew on", async () => {
    const { container, calls } = await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: mandateList([mandateRow()]),
    });
    expect(calls.mandates).toEqual([[ctx, { agentId: null }]]);
    const bar = within(approvalsSection()).getByTestId("mandate-bar");
    expect(bar).toHaveAttribute("data-measure", "amount");
    expect(bar).toHaveTextContent("$615.82");
    // The measure is on the card, not only in a data attribute: this panel is
    // where a mandate draws one bar per measure.
    expect(bar).toHaveTextContent("Remaining authority · amount · monthly");
    expect(within(bar).getByRole("img")).toHaveAccessibleName(
      "amount: $1,204.18 settled, $180.00 reserved by calls in flight, $615.82 remaining of $2,000.00",
    );
    await expectNoAxe(container);
  });

  it("says what the bar's figures are counted over, since a parked call can outlive a period", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: mandateList([mandateRow()]),
    });
    expect(
      within(approvalsSection()).getByTestId("mandate-period-basis"),
    ).toHaveTextContent("A reservation this call made in an earlier period");
  });

  it("says nothing about a period on a card with no bar (negative)", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([approvalItem()]),
    });
    expect(
      within(approvalsSection()).queryByTestId("mandate-period-basis"),
    ).toBeNull();
  });

  it("reads no mandate at all when no parked call names one (negative)", async () => {
    const { calls } = await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([approvalItem()]),
    });
    expect(calls.mandates).toEqual([]);
    expect(within(approvalsSection()).queryByTestId("mandate-bar")).toBeNull();
  });

  it("draws the card without its bar when the ledger refuses the viewer (negative)", async () => {
    const { container } = await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: { ok: false, reason: "denied", permission: "org.billing" },
    });
    expect(
      within(approvalsSection()).getByTestId("approval"),
    ).toBeInTheDocument();
    expect(within(approvalsSection()).queryByTestId("mandate-bar")).toBeNull();
    await expectNoAxe(container);
  });

  it("names a mandate the page did not read rather than drawing nothing (negative)", async () => {
    const { container } = await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([approvalItem({ mandateId: "mnd_absent" })]),
      mandates: mandateList([mandateRow()], 100),
    });
    const section = approvalsSection();
    expect(within(section).queryByTestId("mandate-bar")).toBeNull();
    expect(within(section).getByTestId("mandate-unread")).toHaveTextContent(
      "Drew on mandate mnd_absent",
    );
    await expectNoAxe(container);
  });

  it("names the mandate on a card the viewer may not read the ledger for (negative)", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: { ok: false, reason: "denied", permission: "org.billing" },
    });
    expect(
      within(approvalsSection()).getByTestId("mandate-unread"),
    ).toHaveTextContent("mnd_4f2a9c");
  });

  it("names no mandate on a card that drew on none (negative)", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([approvalItem()]),
    });
    expect(
      within(approvalsSection()).queryByTestId("mandate-unread"),
    ).toBeNull();
  });

  // A mandate limited per call only has no denominator, so every `MandateBar`
  // draws nothing — and the card used to print a caveat about the period it
  // was not counting, over that emptiness, while suppressing the fallback that
  // would at least have named the mandate.
  it("names a per-call-only mandate instead of drawing an empty card", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: mandateList([
        mandateRow({
          authority: [
            mandateAuthority({
              perPeriod: null,
              remaining: null,
              settledRatio: null,
              reservedRatio: null,
            }),
          ],
        }),
      ]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    expect(within(card).queryByTestId("mandate-bar")).toBeNull();
    expect(within(card).queryByTestId("mandate-period-basis")).toBeNull();
    const line = within(card).getByTestId("mandate-per-call-only");
    expect(line.textContent).toContain("mnd_4f2a9c");
    expect(line.textContent).toContain("limits these per call only");
    expect(line.textContent).toContain("$250.00");
    expect(line.textContent).toContain("amount");
  });

  it("keeps the period caveat when a measure does have a period limit", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: mandateList([mandateRow()]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    expect(
      within(card).getByTestId("mandate-period-basis"),
    ).toBeInTheDocument();
    expect(within(card).queryByTestId("mandate-per-call-only")).toBeNull();
  });

  // A mandate's measures are a partition, not an either/or. Keying the
  // fallback on "are there any bars" hid the per-call measures of a mandate
  // that had one of each.
  it("draws the bars and names the per-call-only measures beside them", async () => {
    await renderFleet({
      runs: NO_RUNS,
      approvals: readOk([parked]),
      mandates: mandateList([
        mandateRow({
          authority: [
            mandateAuthority(),
            mandateAuthority({
              measure: "tax",
              perPeriod: null,
              remaining: null,
              settledRatio: null,
              reservedRatio: null,
            }),
          ],
        }),
      ]),
    });
    const card = within(approvalsSection()).getByTestId("approval");
    const bars = within(card).getAllByTestId("mandate-bar");
    expect(bars).toHaveLength(1);
    expect(bars[0]).toHaveAttribute("data-measure", "amount");
    // The period caveat belongs to the bar, and the bar is there.
    expect(
      within(card).getByTestId("mandate-period-basis"),
    ).toBeInTheDocument();
    // And the measure with no period is named rather than dropped.
    const line = within(card).getByTestId("mandate-per-call-only");
    expect(line.textContent).toContain("tax");
    expect(line.textContent).toContain("$250.00");
    expect(line.textContent).not.toContain("amount");
  });
});
