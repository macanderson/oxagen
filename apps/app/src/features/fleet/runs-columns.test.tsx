// @vitest-environment jsdom
// The Runs panel's pull requests, lines changed, summary, pull-request filter
// and saved columns, over a fake DataSource. Each case renders the whole
// Fleet page as the route does, with an axe check after each.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
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

const pull = (
  url: string,
  number: number | null,
  repository: string | null,
  state: "open" | "draft" | "merged" | "closed" | null = null,
) => ({ url, number, repository, state });

const GITHUB = pull("https://github.com/acme/api/pull/42", 42, "acme/api");
const GITLAB = pull(
  "https://gitlab.com/acme/platform/web/-/merge_requests/9",
  9,
  "acme/platform/web",
);

async function renderFleet(
  runs: Parameters<typeof runPage>[0],
  view: {
    cursor?: string | null;
    nextCursor?: string | null;
    prefs?: string;
    pullRequests?: "any" | "with" | "without";
    warnings?: ["pull_requests_unread"];
  } = {},
) {
  const page = runPage(runs, view.nextCursor ?? null);
  const { source, calls } = fleetSource({
    runs:
      page.ok && view.warnings !== undefined
        ? { ok: true, value: { ...page.value, warnings: view.warnings } }
        : page,
    approvals: approvalQueue([]),
    agents: agentPage(["acme.core.release-bot"], 1),
  });
  const element = await Fleet({
    ctx,
    source,
    cursor: view.cursor ?? null,
    prefs: readFleetPrefs(view.prefs),
    pullRequests: view.pullRequests ?? "any",
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return { calls };
}

const runsPanel = () => screen.getByRole("region", { name: "Runs" });
const rowOf = (id: string) => {
  const found = within(runsPanel())
    .getAllByTestId("run-row")
    .find((r) => within(r).queryByText(id) !== null);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
};
// `hidden`: while the column picker is open, the page behind the modal is
// out of the accessibility tree, and the headers still need reading.
const heads = () =>
  within(screen.getByTestId("runs-table"))
    .getAllByRole("columnheader", { hidden: true })
    .map((th) => th.textContent);

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ["Date"] });
  push.mockReset();
  refresh.mockReset();
});

afterEach(async () => {
  vi.useRealTimers();
  await expectNoAxe(document.body);
  cleanup();
  document.cookie = "fleet_view=; Path=/; Max-Age=0";
});

describe("pull requests on a Fleet row", () => {
  it("links a GitHub pull request and a GitLab merge request to their forge, in a new tab, with status unknown", async () => {
    await renderFleet([
      runRow({
        id: "tse_prs",
        source: "tacho",
        pullRequests: [GITHUB, GITLAB],
        pullRequestsOpened: 1,
      }),
    ]);
    const row = rowOf("tse_prs");
    const github = within(row).getByRole("link", {
      name: "Open acme/api#42 on GitHub",
    });
    expect(github).toHaveAttribute("href", GITHUB.url);
    expect(github).toHaveAttribute("target", "_blank");
    expect(github).toHaveAttribute("rel", "noopener noreferrer");
    const gitlab = within(row).getByRole("link", {
      name: "Open acme/platform/web!9 on GitLab",
    });
    expect(gitlab).toHaveAttribute("href", GITLAB.url);
    // No forge has reported either state: each says so, never "open".
    const states = within(row).getAllByTestId("row-pr-state");
    expect(states.map((s) => s.textContent)).toEqual([
      "status unknown",
      "status unknown",
    ]);
    expect(states[0]).toHaveAttribute(
      "title",
      "No forge has reported this pull request's status to Oxagen. Open the run to read it from GitHub.",
    );
  });

  it("opens the pull request without opening the run", async () => {
    await renderFleet([
      runRow({ id: "tse_prs", source: "tacho", pullRequests: [GITHUB] }),
    ]);
    fireEvent.click(
      within(rowOf("tse_prs")).getByRole("link", {
        name: "Open acme/api#42 on GitHub",
      }),
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("shows a recorded state as a badge", async () => {
    await renderFleet([
      runRow({
        id: "tse_merged",
        source: "tacho",
        pullRequests: [{ ...GITHUB, state: "merged" }],
      }),
    ]);
    const state = within(rowOf("tse_merged")).getByTestId("row-pr-state");
    expect(state).toHaveAttribute("data-state", "merged");
    expect(state).toHaveTextContent("merged");
  });

  it("names a pull request on a forge Oxagen does not recognise without linking it (negative)", async () => {
    const hosted = pull(
      "https://git.acme.example/acme/api/pull/5",
      5,
      "acme/api",
    );
    await renderFleet([
      runRow({ id: "tse_ghe", source: "tacho", pullRequests: [hosted] }),
    ]);
    const row = rowOf("tse_ghe");
    expect(within(row).getByText("acme/api#5")).toBeInTheDocument();
    expect(within(row).queryByTestId("row-pr-link")).toBeNull();
  });

  it("lists two pull requests and counts the rest", async () => {
    const three = [41, 42, 43].map((n) =>
      pull(`https://github.com/acme/api/pull/${String(n)}`, n, "acme/api"),
    );
    await renderFleet([
      runRow({ id: "tse_many", source: "tacho", pullRequests: three }),
    ]);
    const row = rowOf("tse_many");
    expect(within(row).getAllByTestId("row-pr-link")).toHaveLength(2);
    expect(row).toHaveTextContent("+1 more");
  });

  it("says a pull request was opened when its link was not recorded, and none when there is none", async () => {
    await renderFleet([
      runRow({
        id: "tse_nolink",
        source: "tacho",
        pullRequests: [],
        pullRequestsOpened: 2,
      }),
      runRow({
        id: "tse_none",
        source: "tacho",
        pullRequests: [],
        pullRequestsOpened: 0,
      }),
    ]);
    expect(
      within(rowOf("tse_nolink")).getByTestId("row-prs-nolink"),
    ).toHaveTextContent("2 opened, links not recorded");
    expect(
      within(rowOf("tse_none")).getByTestId("row-prs-none"),
    ).toHaveTextContent("none");
  });

  it("sends a ledger run's reader to the run page, and never reads it as none (negative)", async () => {
    await renderFleet([runRow({ id: "arun_ledger", source: "ledger" })]);
    const cell = within(rowOf("arun_ledger")).getByTestId("row-prs-elsewhere");
    expect(cell).toHaveTextContent("on the run page");
    expect(
      within(rowOf("arun_ledger")).queryByTestId("row-prs-none"),
    ).toBeNull();
  });

  it("says the page's pull requests could not be read, and keeps the rows (negative)", async () => {
    await renderFleet(
      [runRow({ id: "tse_unread", source: "tacho", pullRequestsOpened: 1 })],
      { warnings: ["pull_requests_unread"] },
    );
    expect(screen.getByTestId("prs-unread")).toHaveTextContent(
      "Oxagen could not read this page's pull requests.",
    );
    expect(
      within(rowOf("tse_unread")).getByTestId("row-prs-unread"),
    ).toHaveTextContent("1 opened, link not recorded");
  });
});

describe("lines changed and the summary on a Fleet row", () => {
  it("shows the lines added and removed, and says git's figure is uncommitted", async () => {
    await renderFleet([
      runRow({
        id: "tse_harness",
        source: "tacho",
        diff: { added: 1204, removed: 30, basis: "harness_reported" },
      }),
      runRow({
        id: "tse_git",
        source: "tacho",
        diff: { added: 4, removed: 1, basis: "git_observed" },
      }),
      runRow({ id: "tse_nodiff", source: "tacho", diff: null }),
    ]);
    const harness = within(rowOf("tse_harness")).getByTestId("row-diff");
    expect(harness).toHaveTextContent("+1,204 −30");
    expect(harness).toHaveTextContent("1,204 lines added, 30 removed");
    expect(harness).not.toHaveTextContent("uncommitted");
    expect(within(rowOf("tse_git")).getByTestId("row-diff")).toHaveTextContent(
      "uncommitted",
    );
    expect(rowOf("tse_nodiff")).toHaveTextContent("not recorded");
  });

  it("shows the generated summary, and says when summaries are off", async () => {
    await renderFleet([
      runRow({ id: "arun_summary" }),
      runRow({ id: "arun_off", enrichmentEnabled: false }),
      runRow({ id: "arun_nosummary", summary: null }),
    ]);
    expect(
      within(rowOf("arun_summary")).getByTestId("row-summary"),
    ).toHaveTextContent("Cut release/3.2 from main");
    expect(rowOf("arun_off")).toHaveTextContent("Summaries off");
    expect(within(rowOf("arun_off")).queryByTestId("row-summary")).toBeNull();
    expect(rowOf("arun_nosummary")).toHaveTextContent("No summary yet");
  });

  // #3837: a header sorts only when the read can order the whole workspace
  // by it. Lines changed has no single order across both stores, and sorting
  // the rows of one page would put page 2's largest change out of reach.
  it("draws the Lines header without a sort, since the read cannot order by it", async () => {
    await renderFleet([
      runRow({
        id: "tse_small",
        diff: { added: 1, removed: 0, basis: "git_observed" },
      }),
    ]);
    expect(screen.queryByRole("button", { name: "Sort by Lines" })).toBeNull();
    expect(
      screen.getByRole("columnheader", { name: "Lines" }),
    ).not.toHaveAttribute("aria-sort");
  });
});

describe("the pull-request filter", () => {
  it("reads the page the URL filtered, and carries the filter to older runs", async () => {
    const { calls } = await renderFleet(
      [runRow({ id: "tse_prs", source: "tacho", pullRequests: [GITHUB] })],
      { pullRequests: "with", nextCursor: "c9" },
    );
    expect(calls.runs).toEqual([
      [ctx, { cursor: null, limit: 25, pullRequests: "with" }],
    ]);
    expect(screen.getByTestId("pr-filter")).toHaveValue("with");
    expect(screen.getByTestId("pr-filter-note")).toHaveTextContent(
      "Runs from an external engine are left out.",
    );
    expect(screen.getByRole("link", { name: "Older runs" })).toHaveAttribute(
      "href",
      "/acme/core-platform?prs=with&cursor=c9",
    );
  });

  it("opens the newest runs under the filter chosen", async () => {
    await renderFleet([runRow({ id: "arun_1" })]);
    expect(screen.queryByTestId("pr-filter-note")).toBeNull();
    const user = userEvent.setup();
    await user.selectOptions(screen.getByTestId("pr-filter"), "without");
    expect(push).toHaveBeenCalledWith("/acme/core-platform?prs=without");
  });

  it("keeps the table and its filter when no run matches, rather than the empty workspace (negative)", async () => {
    await renderFleet([], { pullRequests: "with", nextCursor: "c3" });
    expect(screen.queryByTestId("fleet-empty")).toBeNull();
    expect(screen.getByTestId("runs-none")).toHaveTextContent(
      "No run on this page has a pull request. Older runs may.",
    );
    expect(screen.getByTestId("pr-filter")).toHaveValue("with");
  });
});

describe("saved columns", () => {
  it("draws the columns the cookie left, on the first render", async () => {
    await renderFleet([runRow({ id: "arun_1" })], {
      prefs: "v1|50|summary~tier~tokens",
    });
    expect(heads()).toEqual([
      "Run",
      "Agent",
      "Operator",
      "Status",
      "Pull requests",
      "Lines",
      "Replay",
      "Cost",
      "Frames",
      "Started",
      "Actions",
    ]);
    expect(screen.getByTestId("rows-per-page")).toHaveValue("50");
    // Each row draws one cell per column shown, plus its action.
    expect(within(rowOf("arun_1")).getAllByRole("cell")).toHaveLength(11);
  });

  it("hides and shows a column from the picker, and saves the choice in the cookie", async () => {
    await renderFleet([runRow({ id: "arun_1" })]);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("columns-open"));
    const dialog = screen.getByTestId("columns-dialog");
    await user.click(within(dialog).getByTestId("column-tier"));
    expect(heads()).not.toContain("Tier");
    expect(document.cookie).toContain("fleet_view=v1|25|tier");
    await user.click(within(dialog).getByTestId("column-operator"));
    expect(document.cookie).toContain("fleet_view=v1|25|operator~tier");
    await user.click(within(dialog).getByTestId("column-tier"));
    expect(heads()).toContain("Tier");
    expect(document.cookie).toContain("fleet_view=v1|25|operator");
    // Hiding a column changes no read.
    expect(refresh).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("keeps the run column, and restores every column at once", async () => {
    await renderFleet([runRow({ id: "arun_1" })], {
      prefs: "v1|25|agent~cost",
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("columns-open"));
    const dialog = screen.getByTestId("columns-dialog");
    expect(within(dialog).getByTestId("column-run")).toBeDisabled();
    expect(within(dialog).getByTestId("column-run")).toBeChecked();
    expect(within(dialog).getByTestId("column-agent")).not.toBeChecked();
    await user.click(within(dialog).getByTestId("columns-reset"));
    expect(heads()).toContain("Agent");
    expect(heads()).toContain("Cost");
    expect(document.cookie).toContain("fleet_view=v1|25|");
    expect(within(dialog).getByTestId("columns-reset")).toBeDisabled();
  });
});
