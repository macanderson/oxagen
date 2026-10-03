// @vitest-environment jsdom
// The Work page over a fake DataSource: one item on each tab with every status
// word, each tab's columns and order, the empty tabs, a refused and a failed
// item read, a failing collector, a viewer whose roles cannot send, and the
// Send link. Each state runs the axe check (INV-26). The New work item dialog
// is proven in new-item.test.tsx.
import { cleanup, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkItemRow, WorkPriority } from "@/data/contracts/work";
import { readError } from "@/data/read";
import type { WorkPageTab } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  collector,
  collectorList,
  HEAD,
  priorities,
  sendSummary,
  type WorkReads,
  workItem,
  workList,
  workSource,
} from "./work-list.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { push } = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), refresh: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({ createWorkItem: vi.fn() }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkPage } = await import("./work-page");

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

const NO_PRIORITY: WorkPriority = {
  label: null,
  by: null,
  reason: null,
  cites: [],
  setBy: null,
};
const P = (label: "P0" | "P1" | "P2" | "P3"): WorkPriority => ({
  label,
  by: "oxagen",
  reason: `Triage ranked it ${label}.`,
  cites: ["a-intel.work.priorities#2"],
  setBy: null,
});
const PR = {
  repository: "a-intel/platform",
  number: 612,
  url: "https://github.com/a-intel/platform/pull/612",
  head: HEAD,
};

/** Ten Inbox items, one for each Inbox status word, handed over out of order. */
const INBOX: WorkItemRow[] = [
  workItem({
    id: "wki_triaging",
    number: "WI-1",
    title: "Archive old invoices",
    state: "new",
    status: "triaging",
    priority: NO_PRIORITY,
    wait: { kind: "triaging" },
    arrivedAt: "2026-09-30T08:00:00Z",
  }),
  workItem({
    id: "wki_failed",
    number: "WI-2",
    state: "new",
    status: "triage_failed",
    priority: NO_PRIORITY,
    wait: { kind: "triage_failed", reason: "The output cited rule 31." },
    arrivedAt: "2026-09-30T12:00:00Z",
  }),
  workItem({
    id: "wki_ready",
    number: "WI-3",
    state: "ready",
    status: "ready",
    priority: P("P1"),
    wait: { kind: "ready", lastSend: null },
    arrivedAt: "2026-09-29T10:00:00Z",
  }),
  workItem({
    id: "wki_needsinfo",
    number: "WI-4",
    state: "needs_info",
    status: "needs_info",
    priority: P("P0"),
    wait: { kind: "needs_info", question: "Should an Owner see archived workspaces?" },
    arrivedAt: "2026-09-30T10:00:00Z",
  }),
  workItem({
    id: "wki_duplicate",
    number: "WI-5",
    status: "possible_duplicate",
    priority: P("P2"),
    wait: { kind: "possible_duplicate", of: { id: "wki_ready", number: "WI-3" } },
    arrivedAt: "2026-09-30T07:00:00Z",
  }),
  workItem({
    id: "wki_outofscope",
    number: "WI-6",
    status: "out_of_scope",
    priority: P("P3"),
    wait: { kind: "out_of_scope" },
    arrivedAt: "2026-09-30T07:30:00Z",
  }),
  workItem({
    id: "wki_brief",
    number: "WI-7",
    labels: ["billing", "ui"],
    arrivedAt: "2026-09-30T09:00:00Z",
  }),
  workItem({
    id: "wki_changed",
    number: "WI-8",
    state: "changed",
    status: "changed",
    priority: P("P1"),
    wait: {
      kind: "changed",
      cause: "source",
      at: "2026-09-30T12:58:00Z",
      approvedRevision: 1,
    },
    arrivedAt: "2026-09-30T09:30:00Z",
  }),
  workItem({
    id: "wki_rejected",
    number: "WI-9",
    state: "ready",
    status: "send_rejected",
    priority: P("P1"),
    wait: {
      kind: "send_rejected",
      at: "2026-09-30T12:48:00Z",
      reason: "Claude Code on that runner is signed out.",
    },
    arrivedAt: "2026-09-30T11:00:00Z",
  }),
  workItem({
    id: "wki_unranked",
    number: "WI-10",
    priority: NO_PRIORITY,
    arrivedAt: "2026-09-30T06:00:00Z",
  }),
];

const RUNNING: WorkItemRow[] = [
  workItem({
    id: "wki_waiting",
    number: "WI-11",
    tab: "running",
    state: "sent",
    status: "waiting_for_claim",
    wait: {
      kind: "waiting_for_claim",
      runtime: "CI runner 6",
      sentAt: "2026-09-30T13:02:00Z",
      lastPollAt: "2026-09-30T13:01:00Z",
    },
    send: sendSummary({ delivery: "waiting_for_claim" }),
  }),
  workItem({
    id: "wki_noanswer",
    number: "WI-12",
    tab: "running",
    state: "sent",
    status: "no_answer",
    wait: { kind: "no_answer", runtime: "CI runner 5", lastPollAt: null },
    send: sendSummary({ delivery: "waiting_for_claim", noAnswer: true }),
  }),
  workItem({
    id: "wki_running",
    number: "WI-13",
    tab: "running",
    state: "running",
    status: "running",
    wait: {
      kind: "running",
      changedSinceSend: false,
      changedAt: null,
      briefRevision: 1,
    },
    send: sendSummary(),
    cost: {
      runs: 2,
      knownRuns: 1,
      total: { micros: "1250000", currency: "USD" },
    },
  }),
  workItem({
    id: "wki_stopping",
    number: "WI-14",
    tab: "running",
    state: "running",
    status: "stopping",
    wait: { kind: "stopping", runtime: "CI runner 6" },
    send: sendSummary({ delivery: "stopping" }),
    cost: { runs: 1, knownRuns: 0, total: null },
  }),
];

const REVIEW: WorkItemRow[] = [
  workItem({
    id: "wki_inreview",
    number: "WI-15",
    tab: "review",
    state: "review",
    status: "in_review",
    wait: { kind: "ready_for_review", head: HEAD },
    send: sendSummary({
      delivery: "run_ended",
      pullRequest: PR,
      checks: "passing",
      gate: { open: true, block: null, detail: null },
    }),
  }),
  workItem({
    id: "wki_accepted",
    number: "WI-16",
    tab: "review",
    state: "review",
    status: "accepted",
    wait: { kind: "accepted_waiting_merge", by: "Marcus Bell", head: HEAD },
    send: sendSummary({
      delivery: "run_ended",
      pullRequest: PR,
      checks: "passing",
      accepted: true,
    }),
  }),
];

const DONE: WorkItemRow[] = [
  workItem({
    id: "wki_done",
    number: "WI-17",
    tab: "done",
    state: "done",
    status: "done",
    finishedAt: "2026-09-29T10:31:00Z",
    wait: {
      kind: "done",
      accepted: { by: "Marcus Bell", at: "2026-09-29T10:20:00Z", head: HEAD },
      mergedAt: "2026-09-29T10:31:00Z",
    },
    send: sendSummary({ delivery: "run_ended" }),
  }),
  workItem({
    id: "wki_closed",
    number: "WI-18",
    tab: "done",
    state: "closed",
    status: "closed",
    finishedAt: "2026-09-30T09:14:00Z",
    wait: {
      kind: "closed",
      resolution: "duplicate",
      by: "Marcus Bell",
      at: "2026-09-30T09:14:00Z",
      reason: "Same as WI-3.",
    },
  }),
];

const ALL = [...INBOX, ...RUNNING, ...REVIEW, ...DONE];

async function renderWork(reads: WorkReads, tab: WorkPageTab = "inbox") {
  const { source, calls } = workSource({
    collectors: collectorList([collector()]),
    priorities: priorities(),
    ...reads,
  });
  const element = await WorkPage({ ctx, source, tab });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

/** The work item numbers of the open table's rows, in order. */
const rowNumbers = () =>
  [...document.querySelectorAll("tr[data-work-item]")].map((row) =>
    row.getAttribute("data-work-item"),
  );

const headers = (name: string) =>
  within(screen.getByRole("table", { name }))
    .getAllByRole("columnheader")
    .map((th) => th.textContent || th.getAttribute("aria-label"));

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Work › loaded", () => {
  it("reads the items, the collectors and the priorities record", async () => {
    const { calls } = await renderWork({ list: workList(ALL) });
    expect(calls.map((call) => call.read).sort()).toEqual([
      "work.collectors",
      "work.list",
      "work.priorities",
    ]);
    expect(calls.every((call) => call.args[0] === ctx)).toBe(true);
  });

  it("names the page and cites the priorities record with a link to Setup", async () => {
    await renderWork({ list: workList(ALL) });
    expect(
      screen.getByRole("heading", { level: 1, name: "Work" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Core platform")).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "a-intel.work.priorities v7" }),
    ).toHaveAttribute("href", "/a-intel/core-platform/work/setup?tab=priorities");
    expect(screen.getByTestId("work-open-setup")).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work/setup",
    );
    expect(screen.getByTestId("work-open-outcomes")).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work/outcomes",
    );
  });

  it("counts the three tiles from the server's states and words", async () => {
    await renderWork({ list: workList(ALL) });
    const ready = screen.getByTestId("work-tile-ready");
    expect(within(ready).getByText("2")).toBeInTheDocument();
    expect(
      within(ready).getByText("8 items still in triage or approval"),
    ).toBeInTheDocument();
    const running = screen.getByTestId("work-tile-running");
    expect(within(running).getByText("4")).toBeInTheDocument();
    expect(
      within(running).getByText("2 sends waiting for a runtime"),
    ).toBeInTheDocument();
    const review = screen.getByTestId("work-tile-review");
    expect(within(review).getByText("1")).toBeInTheDocument();
    expect(
      within(review).getByText("1 accepted item waiting for the merge"),
    ).toBeInTheDocument();
  });

  it("counts each tab and marks the open one", async () => {
    await renderWork({ list: workList(ALL) }, "running");
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.getAttribute("data-tab"))).toEqual([
      "inbox",
      "running",
      "review",
      "done",
    ]);
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Inbox10",
      "Running4",
      "Review2",
      "Done2",
    ]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("aria-selected", "false");
    expect(tabs[2]).toHaveAttribute("href", "/a-intel/core-platform/work?tab=review");
    expect(tabs[0]).toHaveAttribute("href", "/a-intel/core-platform/work");
  });

  it("orders the Inbox: a failed triage, P0 to P3, no priority, then triage", async () => {
    await renderWork({ list: workList(ALL) });
    expect(rowNumbers()).toEqual([
      "WI-2",
      "WI-4",
      "WI-3",
      "WI-8",
      "WI-9",
      "WI-5",
      "WI-7",
      "WI-6",
      "WI-10",
      "WI-1",
    ]);
  });

  it("draws the Inbox columns and a status word on every row", async () => {
    await renderWork({ list: workList(ALL) });
    expect(headers("Inbox")).toEqual(["Work item", "Priority", "State", "Send"]);
    const words = [...document.querySelectorAll("tr[data-work-item] [data-status]")].map(
      (badge) => badge.textContent,
    );
    expect(words).toEqual([
      "Triage failed",
      "Needs info",
      "Ready",
      "Changed",
      "Send rejected",
      "Possible duplicate",
      "Brief to approve",
      "Out of scope",
      "Brief to approve",
      "Triaging",
    ]);
  });

  it("links every row to its item and draws the title and labels as text", async () => {
    await renderWork({
      list: workList([
        workItem({ title: "<b>Bold</b> & co", labels: ["billing"] }),
      ]),
    });
    const link = screen.getByRole("link", { name: "WI-1 <b>Bold</b> & co" });
    expect(link).toHaveAttribute("href", "/a-intel/core-platform/work/WI-1");
    expect(screen.getByText("<b>Bold</b> & co")).toBeInTheDocument();
    expect(document.querySelector('[data-work-label="billing"]')).not.toBeNull();
    expect(
      screen.getByText("Triage drafted a brief. It waits for a person to approve it."),
    ).toBeInTheDocument();
  });

  it("offers Send on each ready Inbox row, to the item's Send dialog", async () => {
    await renderWork({ list: workList(ALL) });
    const sends = screen.getAllByTestId("work-send-row");
    expect(sends.map((send) => send.getAttribute("href"))).toEqual([
      "/a-intel/core-platform/work/WI-3?dialog=send",
      "/a-intel/core-platform/work/WI-9?dialog=send",
    ]);
    expect(
      screen.getByRole("link", { name: "Send WI-3 to an agent" }),
    ).toBeInTheDocument();
  });

  it("points Send to an agent at the first ready item in Inbox order", async () => {
    await renderWork({ list: workList(ALL) });
    const send = screen.getByTestId("work-send");
    expect(send.tagName).toBe("A");
    expect(send).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work/WI-3?dialog=send",
    );
    expect(send).toHaveTextContent("Send to an agent");
    expect(screen.queryByTestId("work-viewer-note")).toBeNull();
  });

  it("draws Running with its target, status and cost coverage", async () => {
    await renderWork({ list: workList(ALL) }, "running");
    expect(headers("Running")).toEqual(["Work item", "Target", "Status", "Cost"]);
    expect(rowNumbers()).toEqual(["WI-11", "WI-12", "WI-13", "WI-14"]);
    const running = document.querySelector('tr[data-work-item="WI-13"]');
    if (!(running instanceof HTMLElement)) throw new Error("no WI-13 row");
    expect(within(running).getByText("Release manager")).toBeInTheDocument();
    expect(within(running).getByText("CI runner 6")).toBeInTheDocument();
    expect(within(running).getByText("$1.25")).toBeInTheDocument();
    expect(within(running).getByText("1 of 2 runs known")).toBeInTheDocument();
    const stopping = document.querySelector('tr[data-work-item="WI-14"]');
    if (!(stopping instanceof HTMLElement)) throw new Error("no WI-14 row");
    expect(within(stopping).getByText("unknown")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("$0.00");
    const words = [
      ...document.querySelectorAll("tr[data-work-item] [data-status]"),
    ].map((badge) => badge.textContent);
    expect(words).toEqual([
      "Waiting for claim",
      "No answer",
      "Running",
      "Stopping",
    ]);
  });

  it("draws Review with the pull request, its head and the checks word", async () => {
    await renderWork({ list: workList(ALL) }, "review");
    expect(headers("Review")).toEqual([
      "Work item",
      "Pull request",
      "Required checks",
      "Cost",
    ]);
    const row = document.querySelector('tr[data-work-item="WI-15"]');
    if (!(row instanceof HTMLElement)) throw new Error("no WI-15 row");
    expect(within(row).getByText("#612")).toBeInTheDocument();
    expect(within(row).getByText("9e41b07")).toBeInTheDocument();
    expect(row.querySelector('[data-checks="passing"]')).toHaveTextContent(
      "Passing",
    );
    expect(
      screen.getByText("Accepted by Marcus Bell on 9e41b07. Waiting for the merge."),
    ).toBeInTheDocument();
  });

  it("draws every pull request the forge store holds for the send, each with its state", async () => {
    const pull = {
      id: "fpr_612",
      provider: "github" as const,
      repository: "a-intel/platform",
      number: 612,
      url: "https://github.com/a-intel/platform/pull/612",
      title: "Renew the certificate",
      state: "merged" as const,
      head: HEAD,
      stateSeenAt: "2026-09-30T14:00:00Z",
    };
    const item = workItem({
      id: "wki_twopulls",
      number: "WI-21",
      tab: "review",
      state: "review",
      status: "in_review",
      wait: { kind: "ready_for_review", head: HEAD },
      send: sendSummary({
        delivery: "run_ended",
        pullRequest: PR,
        pullRequests: [{ ...pull, id: "fpr_613", number: 613, state: "draft" }, pull],
        checks: "passing",
        gate: { open: true, block: null, detail: null },
      }),
    });
    await renderWork({ list: workList([item]) }, "review");
    const row = document.querySelector('tr[data-work-item="WI-21"]');
    if (!(row instanceof HTMLElement)) throw new Error("no WI-21 row");
    const pulls = [...row.querySelectorAll("[data-pull-request]")];
    expect(pulls.map((entry) => entry.getAttribute("data-pull-request"))).toEqual(["613", "612"]);
    expect(pulls[0]?.querySelector('[data-pull-state="draft"]')).toHaveTextContent("Draft");
    expect(pulls[1]?.querySelector('[data-pull-state="merged"]')).toHaveTextContent("Merged");
    // The head under them is the one the send's facts judge acceptance on.
    expect(within(row).getByText("9e41b07")).toBeInTheDocument();
    await expectNoAxe(document.body);
  });

  it("draws Done newest first with its result, agent and finish", async () => {
    await renderWork({ list: workList(ALL) }, "done");
    expect(headers("Done")).toEqual([
      "Work item",
      "Result",
      "Agent",
      "Cost",
      "Finished",
    ]);
    expect(rowNumbers()).toEqual(["WI-18", "WI-17"]);
    expect(
      document.querySelector('tr[data-work-item="WI-18"] [data-status="closed"]'),
    ).toHaveTextContent("Closed");
    expect(
      document.querySelector('tr[data-work-item="WI-17"] [data-status="done"]'),
    ).toHaveTextContent("Done");
    expect(screen.getByText("Release manager")).toBeInTheDocument();
  });

  it("never draws a Held or Proven word on any tab", async () => {
    for (const tab of ["inbox", "running", "review", "done"] as const) {
      await renderWork({ list: workList(ALL) }, tab);
      expect(document.body.textContent).not.toMatch(/\bHeld\b|\bProven\b/);
      cleanup();
    }
    await renderWork({ list: workList(ALL) });
  });

  it("says when the list holds only the first items", async () => {
    await renderWork({ list: workList(INBOX, undefined, true) });
    expect(screen.getByTestId("work-truncated")).toHaveTextContent(
      "Work lists the first 10 items here. The workspace holds more.",
    );
  });
});

describe("Work › empty", () => {
  it.each([
    ["inbox", "No items in the inbox"],
    ["running", "No running items"],
    ["review", "No items waiting for review"],
    ["done", "No finished items"],
  ] as const)("draws the %s tab's empty state", async (tab, title) => {
    await renderWork({ list: workList([]) }, tab);
    const empty = screen.getByTestId(`work-empty-${tab}`);
    expect(within(empty).getByRole("heading", { name: title })).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
    if (tab === "inbox") {
      expect(within(empty).getByTestId("work-new-item-empty")).toBeEnabled();
    } else {
      expect(within(empty).queryByTestId("work-new-item-empty")).toBeNull();
    }
  });

  it("disables Send to an agent and says nothing is ready", async () => {
    await renderWork({ list: workList([workItem()]) });
    const send = screen.getByTestId("work-send");
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      "Nothing in the inbox is ready to send. Approve a brief first.",
    );
  });
});

describe("Work › a viewer whose roles cannot send", () => {
  it("disables New work item and Send, hides row Send, and says why", async () => {
    await renderWork({
      list: workList(ALL, { canControl: false, canApprove: false }),
    });
    expect(screen.getByTestId("work-new-item")).toBeDisabled();
    expect(screen.getByTestId("work-new-item")).toHaveAccessibleDescription(
      "Your role cannot enter work in this workspace.",
    );
    const send = screen.getByTestId("work-send");
    expect(send).toBeDisabled();
    expect(send).toHaveAccessibleDescription(
      "Your role cannot send work in this workspace.",
    );
    expect(screen.queryAllByTestId("work-send-row")).toEqual([]);
    expect(screen.getByTestId("work-viewer-note")).toHaveTextContent(
      "Your role can read Work here. Entering and sending work takes the run.control permission.",
    );
  });
});

describe("Work › read failures", () => {
  it("replaces the body when the item read is refused and keeps the header", async () => {
    await renderWork({
      list: { ok: false, reason: "denied", permission: "run.read" },
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Work" }),
    ).toBeInTheDocument();
    const denied = screen.getByTestId("work-denied");
    expect(denied).toHaveTextContent("No access to Work");
    expect(denied).toHaveTextContent("run.read");
    expect(screen.queryByTestId("work-tile-ready")).toBeNull();
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(screen.queryByTestId("work-send")).toBeNull();
  });

  it("names the code and offers Try again when the item read fails", async () => {
    await renderWork(
      { list: readError("work_records_unavailable", 503) },
      "review",
    );
    const error = screen.getByTestId("work-error");
    expect(error).toHaveTextContent("Work could not be loaded");
    expect(error).toHaveTextContent("503 work_records_unavailable");
    expect(within(error).getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work?tab=review",
    );
  });

  it("drops only the banner and the line when the other two reads fail", async () => {
    await renderWork({
      list: workList(ALL),
      collectors: readError("work_records_unavailable", 503),
      priorities: readError("work_records_unavailable", 503),
    });
    expect(screen.queryByTestId("work-collector-banner")).toBeNull();
    expect(screen.queryByText(/Triage suggests priorities/)).toBeNull();
    expect(screen.getByTestId("work-tile-ready")).toBeInTheDocument();
  });

  it("says triage cannot rank work while no priorities record is merged, and links to writing one", async () => {
    await renderWork({
      list: workList(ALL),
      priorities: priorities({ record: null, problem: "No record is published." }),
    });
    const link = screen.getByTestId("work-write-priorities");
    expect(link).toHaveTextContent("Write the priorities record");
    expect(link).toHaveAttribute("href", "/a-intel/core-platform/work/setup?tab=priorities");
    expect(link.parentElement).toHaveTextContent(
      "Triage cannot rank work until a priorities record is merged. Write the priorities record.",
    );
  });
});

describe("Work › a failing collector", () => {
  it("raises a banner with what it reads, its last good read and a link to Setup", async () => {
    await renderWork({
      list: workList(ALL),
      collectors: collectorList([
        collector({ health: "failing", failedStreak: 3 }),
        collector({
          name: "github-mobile",
          repos: ["a-intel/mobile"],
        }),
      ]),
    });
    const banner = screen.getByTestId("work-collector-banner");
    expect(banner).toHaveTextContent("Collector github is failing");
    expect(banner).toHaveTextContent(
      "It reads a-intel/platform and a-intel/billing-service.",
    );
    expect(banner).toHaveTextContent(/Last good read on Sep 30/);
    expect(banner).not.toHaveTextContent("github-mobile");
    expect(
      within(banner).getByRole("link", { name: "Open collectors" }),
    ).toHaveAttribute("href", "/a-intel/core-platform/work/setup");
  });

  it("raises no banner while every collector reads", async () => {
    await renderWork({ list: workList(ALL) });
    expect(screen.queryByTestId("work-collector-banner")).toBeNull();
  });
});
