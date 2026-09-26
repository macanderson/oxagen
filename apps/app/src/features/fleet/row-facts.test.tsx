// @vitest-environment jsdom
// Fleet's tokens (#3834) and its paused and compacted rows (#3835), over a
// fake DataSource, rendering the whole page as the route does, with an axe
// check after each case. These cases read the board.tsx and view.ts wiring in
// the run-rows lane's handoff.
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  agentPage,
  approvalQueue,
  fleetSource,
  NOW,
  runPage,
  runRow,
} from "./fleet.builders";
import { readFleetPrefs } from "./prefs";

const { push, refresh } = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh }),
}));
vi.mock("./actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./actions")>()),
  resolveApprovalAction: vi.fn(),
  readApprovalEligibility: vi.fn(),
  steerFleet: vi.fn(),
  dispatchRunCommand: vi.fn(),
  exportFleetRun: vi.fn(),
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: vi.fn(() => Promise.resolve(null)),
}));
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

const usd = (micros: string) => ({
  micros,
  currency: "USD",
  basis: "gateway_observed" as const,
});
const counts = (total: number) => ({
  inputUncached: total / 4,
  cacheRead: total / 4,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: total / 2,
  reasoning: 0,
});

async function renderFleet(runs: Parameters<typeof runPage>[0]) {
  const { source } = fleetSource({
    runs: runPage(runs),
    approvals: approvalQueue([]),
    agents: agentPage(["acme.core.release-bot"], 1),
  });
  const element = await Fleet({
    ctx,
    source,
    cursor: null,
    prefs: readFleetPrefs(undefined),
    pullRequests: "any",
  });
  render(<IntlProvider>{element}</IntlProvider>);
}

const runsPanel = () => screen.getByRole("region", { name: "Runs" });
const rows = () => within(runsPanel()).getAllByTestId("run-row");
const rowOf = (id: string) => {
  const found = rows().find((r) => within(r).queryByText(id) !== null);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};
const ids = () =>
  rows().map((r) => within(r).getAllByRole("link")[0]?.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  push.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
});

describe("tokens (#3834)", () => {
  const priced = [
    runRow({
      id: "arun_big",
      status: "sealed",
      outcome: "completed",
      tokens: counts(8_000),
      cost: usd("3000000"),
      cacheHitRate: 0.9,
    }),
    runRow({
      id: "arun_small",
      status: "sealed",
      outcome: "completed",
      tokens: counts(2_000),
      cost: usd("1000000"),
      cacheHitRate: 0.1,
    }),
    runRow({
      id: "arun_none",
      status: "sealed",
      outcome: "completed",
      tokens: null,
      reportedTokens: null,
    }),
  ];

  it("shows each row's total with its cached share, and a tile that sums them", async () => {
    await renderFleet(priced);
    const big = within(rowOf("arun_big")).getByTestId("row-tokens");
    expect(big).toHaveTextContent("8,000");
    expect(big).toHaveTextContent("50% cached");
    expect(
      within(rowOf("arun_none")).getByTestId("row-tokens"),
    ).toHaveTextContent("not recorded");
    // The tile is the sum of the Tokens column over the rows listed, with the
    // cache share weighted by spend: (3 × 0.9 + 1 × 0.1) / 4.
    expect(screen.getByTestId("tokens-shown")).toHaveTextContent("10,000");
    expect(screen.getByTestId("tokens-cache")).toHaveTextContent(
      "70% served from cache · 1 row not recorded",
    );
  });

  // list_runs orders the rows on the server (#3837) and has no tokens sort
  // key, so the header is drawn disabled and keeps the read's order.
  it("draws the Tokens header without a sort, and says why", async () => {
    await renderFleet(priced);
    const sort = screen.getByRole("button", { name: "Sort by Tokens" });
    expect(sort).toBeDisabled();
    expect(sort).toHaveAttribute(
      "title",
      "Runs are ordered on the server, which cannot order them by tokens yet.",
    );
    expect(sort.closest("th")).toHaveAttribute("aria-sort", "none");
  });
});

describe("paused and compacted rows (#3835)", () => {
  const runs = [
    runRow({ id: "tse_live", source: "tacho", status: "live" }),
    runRow({
      id: "tse_paused",
      source: "tacho",
      status: "live",
      ingressPaused: true,
    }),
    runRow({
      id: "arun_sealed",
      status: "sealed",
      outcome: "completed",
      compacted: false,
    }),
    runRow({
      id: "arun_compacted",
      status: "sealed",
      outcome: "completed",
      compacted: true,
    }),
  ];

  it("reads a paused run as paused and sends it to its Run page, never to an export", async () => {
    await renderFleet(runs);
    const paused = rowOf("tse_paused");
    expect(paused.dataset.state).toBe("paused");
    expect(paused.querySelector('[data-status="paused"]')).toHaveTextContent(
      "paused",
    );
    const open = within(paused).getByTestId("row-open");
    expect(open).toHaveAttribute("href", "/acme/core-platform/runs/tse_paused");
    expect(open).toHaveAccessibleName("Open tse_paused");
    expect(within(paused).queryByTestId("row-export")).toBeNull();
    expect(within(paused).queryByTestId("row-pause")).toBeNull();
  });

  it("reads a compacted run as compacted and still exports it", async () => {
    await renderFleet(runs);
    const compacted = rowOf("arun_compacted");
    expect(compacted.dataset.state).toBe("compacted");
    expect(
      compacted.querySelector('[data-status="compacted"]'),
    ).toHaveTextContent("compacted");
    expect(within(compacted).getByTestId("row-export")).toBeInTheDocument();
  });

  it("lists paused under parked and live, and compacted under sealed", async () => {
    await renderFleet(runs);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByTestId("chip-parked"));
    expect(ids()).toEqual(["tse_paused"]);
    await user.click(screen.getByTestId("chip-live"));
    expect(ids()).toEqual(["tse_live", "tse_paused"]);
    await user.click(screen.getByTestId("chip-sealed"));
    expect(ids()).toEqual(["arun_sealed", "arun_compacted"]);
  });

  // The Status facet filters on the server (#3837), which holds the run's
  // lifecycle status only. Paused and compacted are facts beside it (ADR-193),
  // so the parked and sealed chips find them, not the facet.
  it("offers the record's statuses in the Status facet, not paused or compacted", async () => {
    await renderFleet(runs);
    const options = within(screen.getByTestId("facet-status"))
      .getAllByRole("option")
      .map((o) => o.textContent);
    expect(options).not.toContain("paused");
    expect(options).not.toContain("compacted");
    expect(options).toEqual(
      expect.arrayContaining(["live", "sealed", "halted"]),
    );
  });

  it("does not count a paused run in Live runs, as it is waiting on a person (negative)", async () => {
    await renderFleet(runs);
    const tile = screen
      .getAllByTestId("tile")
      .find((t) => t.firstElementChild?.textContent === "Live runs");
    expect(tile).toHaveTextContent("Live runs1");
  });
});
