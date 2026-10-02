// @vitest-environment jsdom
// Work setup over a fake DataSource: each tab's reads and rows, a collector's
// last read, a failed read, a repository no longer linked, and Read now; Add
// collector picking from the linked repositories with a new and an existing
// name, and with none linked or none readable; the priorities record with and
// without a record, and the editor that writes one; and why each agent can or
// cannot take a send with the budget line its tier earns. Each state runs the
// axe check (INV-26).
import {
  cleanup,
  render,
  screen,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError } from "@/data/read";
import type { WorkSetupTab } from "@/shared/safe-path";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import {
  collector,
  collectorList,
  priorities,
  target,
  targetList,
  type WorkReads,
  workItem,
  workList,
  workSource,
} from "../work-list.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router, setCollector, syncCollector, proposePriorities, openPrioritiesPr } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setCollector: vi.fn(),
  syncCollector: vi.fn(),
  proposePriorities: vi.fn(),
  openPrioritiesPr: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../actions", () => ({ setCollector, syncCollector, proposePriorities, openPrioritiesPr }));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { WorkSetupPage } = await import("./setup-page");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "a-intel",
  orgName: "Anderson Intelligence Corp.",
  orgRole: "member",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "owner",
});

const FAILING = collector({
  health: "failing",
  failedStreak: 3,
  lastReconcile: {
    at: "2026-09-30T11:40:00Z",
    ok: false,
    pages: 1,
    handled: 0,
    missed: 0,
    error: "GitHub answered 401 Bad credentials.",
  },
});

async function renderSetup(tab: WorkSetupTab, reads: WorkReads) {
  const { source, calls } = workSource({
    list: workList([workItem()]),
    ...reads,
  });
  const element = await WorkSetupPage({ ctx, source, tab });
  const view = render(<IntlProvider>{element}</IntlProvider>);
  return { calls, ...view };
}

const row = (selector: string): HTMLElement => {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) throw new Error(`no ${selector}`);
  return found;
};

beforeEach(() => {
  setCollector.mockReset();
  syncCollector.mockReset();
  proposePriorities.mockReset();
  openPrioritiesPr.mockReset();
  router.refresh.mockReset();
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("Work setup › header and tabs", () => {
  it("names the page and opens the tab the address names", async () => {
    await renderSetup("priorities", { priorities: priorities() });
    expect(
      screen.getByRole("heading", { level: 1, name: "Work setup" }),
    ).toBeInTheDocument();
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual([
      "Collectors",
      "Priorities",
      "Runtimes",
    ]);
    expect(tabs[1]).toHaveAttribute("aria-selected", "true");
    expect(tabs[0]).toHaveAttribute("href", "/a-intel/core-platform/work/setup");
    expect(tabs[2]).toHaveAttribute(
      "href",
      "/a-intel/core-platform/work/setup?tab=runtimes",
    );
  });
});

describe("Work setup › Collectors", () => {
  it("reads the collectors with the linked repositories, and the viewer's roles", async () => {
    const { calls } = await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    expect(calls.map((call) => call.read).sort()).toEqual(["work.collectors", "work.list"]);
  });

  it("lists each collector with what it reads, its health, its last read and manual entry", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([
        collector(),
        collector({
          name: "web",
          repos: ["a-intel/web"],
          lastReconcile: { at: "2026-09-30T12:00:00Z", ok: true, pages: 1, handled: 4, missed: 0, error: null },
        }),
      ]),
    });
    const table = screen.getByRole("table", { name: "Collectors" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Collector", "Reads", "Health", "Last read", ""]);
    const github = row('tr[data-collector="github"]');
    expect(github).toHaveTextContent("GitHub Issues");
    expect(github).toHaveTextContent("a-intel/platform");
    expect(github).toHaveTextContent("a-intel/billing-service");
    expect(github.querySelector('[data-health="healthy"]')).toHaveTextContent("Healthy");
    expect(github.querySelector('[data-cell="last-read"]')).toHaveTextContent("Not read yet");
    expect(github.querySelector('[data-linked="false"]')).toBeNull();
    expect(row('tr[data-collector="web"]').querySelector('[data-cell="last-read"]')).toHaveTextContent(
      "4 issues read",
    );
    const manual = row('tr[data-collector="manual"]');
    expect(manual).toHaveTextContent("Manual entry");
    expect(manual).toHaveTextContent("On");
    expect(screen.getByTestId("work-write-back")).toHaveTextContent(
      "oxagen reads issues from GitHub and writes nothing back.",
    );
    expect(document.querySelector("[data-collector-failure]")).toBeNull();
  });

  it("marks a repository the workspace no longer links as not linked", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector({ repos: ["a-intel/platform", "someone/elsewhere"] })]),
    });
    expect(row('li[data-repo="someone/elsewhere"]')).toHaveTextContent("Not linked");
    expect(row('li[data-repo="a-intel/platform"]')).not.toHaveTextContent("Not linked");
  });

  it("shows a failing collector's last good read, its streak and its answer", async () => {
    await renderSetup("collectors", { collectors: collectorList([FAILING]) });
    expect(
      row('tr[data-collector="github"]').querySelector('[data-health="failing"]'),
    ).toHaveTextContent("Failing");
    const failure = row('tr[data-collector-failure="github"]');
    expect(failure).toHaveTextContent(/Last good read on Sep 30/);
    expect(failure).toHaveTextContent("3 failed reads in a row.");
    expect(failure).toHaveTextContent("GitHub answered 401 Bad credentials.");
    expect(failure).toHaveTextContent(
      "Once a read works again, oxagen reads every issue changed since the last good read.",
    );
  });

  it("shows a failed read's answer at once, before the collector turns failing", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([
        collector({
          lastReconcile: {
            at: "2026-09-30T12:00:00Z",
            ok: false,
            pages: 0,
            handled: 0,
            missed: 0,
            error: "The GitHub connection cannot read a-intel/web.",
          },
          failedStreak: 1,
        }),
      ]),
    });
    expect(row('tr[data-collector="github"]').querySelector('[data-cell="last-read"]')).toHaveTextContent(
      "Read failed",
    );
    const failure = row('tr[data-collector-failure="github"]');
    expect(failure).toHaveTextContent("The GitHub connection cannot read a-intel/web.");
    expect(failure).not.toHaveTextContent("in a row");
  });

  it("reads a healthy collector now and says the read started", async () => {
    syncCollector.mockResolvedValue({ ok: true, value: { queued: true } });
    await renderSetup("collectors", { collectors: collectorList([collector()]) });
    const user = userEvent.setup();
    const button = screen.getByRole("button", { name: "Read now: github" });
    expect(button).toHaveTextContent("Read now");
    await user.click(button);
    expect(syncCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "github",
    });
    expect(await screen.findByTestId("work-reconnect-status-github")).toHaveTextContent(
      "oxagen started a new read of github. New issues show up in a few minutes.",
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the refusal when the collector cannot be read now", async () => {
    syncCollector.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "collector_paused",
    });
    await renderSetup("collectors", { collectors: collectorList([FAILING]) });
    await userEvent.setup().click(screen.getByTestId("work-reconnect-github"));
    expect(await screen.findByTestId("work-reconnect-failure-github")).toHaveTextContent(
      "The collector is paused. Resume it before you read it again.",
    );
  });

  it("offers no Read now on a paused collector (negative)", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector({ health: "paused" })]),
    });
    expect(screen.queryByTestId("work-reconnect-github")).toBeNull();
  });

  it("adds a collector from the linked repositories, with no repository typed and no connection chosen", async () => {
    setCollector.mockResolvedValue({
      ok: true,
      value: { created: true, reconcileQueued: true },
    });
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    expect(within(dialog).getByLabelText("Name")).toHaveValue("issues");
    const repos = within(dialog).getByRole("group", { name: "Repositories" });
    expect(
      within(repos)
        .getAllByRole("checkbox")
        .map((box) => box.getAttribute("value")),
    ).toEqual(["a-intel/platform", "a-intel/billing-service", "a-intel/web"]);
    expect(within(dialog).queryByRole("textbox", { name: "Repositories" })).toBeNull();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    await user.click(within(repos).getByRole("checkbox", { name: "a-intel/web" }));
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(setCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "issues",
      repos: ["a-intel/web"],
    });
    expect(await screen.findByTestId("work-add-collector-status")).toHaveTextContent(
      "issues is reading 1 repository now. Open issues show up as work items in a few minutes.",
    );
    expect(router.refresh).toHaveBeenCalled();
  });

  it("ticks what an existing collector reads when its name is typed, and saves the change", async () => {
    setCollector.mockResolvedValue({
      ok: true,
      value: { created: false, reconcileQueued: false },
    });
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "github");
    expect(within(dialog).getByRole("checkbox", { name: "a-intel/platform" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "a-intel/billing-service" })).toBeChecked();
    expect(within(dialog).getByRole("checkbox", { name: "a-intel/web" })).not.toBeChecked();
    expect(dialog).toHaveTextContent("A collector already has this name. Saving changes what it reads.");
    await user.click(within(dialog).getByRole("checkbox", { name: "a-intel/billing-service" }));
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(setCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "github",
      repos: ["a-intel/platform"],
    });
    expect(await screen.findByTestId("work-add-collector-status")).toHaveTextContent(
      "github is saved. It already reads these repositories.",
    );
  });

  it("refuses a bad name or no repository and saves nothing (negative)", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    const submit = within(dialog).getByTestId("work-add-collector-submit");
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "GitHub Mobile");
    await user.click(submit);
    expect(within(dialog).getByTestId("work-action-failure")).toHaveTextContent(
      "Use lowercase words joined by single hyphens.",
    );
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "github-mobile");
    // Typing passes through "github", an existing collector, which ticks its
    // repositories; going past that name clears them again.
    expect(within(dialog).getByRole("checkbox", { name: "a-intel/platform" })).not.toBeChecked();
    await user.click(submit);
    expect(within(dialog).getByTestId("work-action-failure")).toHaveTextContent(
      "Choose at least one repository.",
    );
    expect(setCollector).not.toHaveBeenCalled();
  });

  it("shows the refusal the server answers", async () => {
    setCollector.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "collector_not_found",
    });
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    await user.click(within(dialog).getByRole("checkbox", { name: "a-intel/web" }));
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(
      await within(dialog).findByTestId("work-action-failure"),
    ).toHaveTextContent(
      "oxagen found no such collector or GitHub connection in this workspace. Nothing changed.",
    );
  });

  it("sends a person to Repositories when no repository is linked (negative)", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([], []),
    });
    expect(screen.getByTestId("work-collectors-empty")).toHaveTextContent(
      "No collector yet. People can still add work items by title.",
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    const repos = within(dialog).getByTestId("work-collector-repos");
    expect(repos).toHaveTextContent(
      "No repository is linked to this workspace yet. Link one on the Repositories page, then add a collector.",
    );
    expect(within(repos).getByRole("link", { name: "Repositories" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/repositories",
    );
    expect(within(dialog).queryAllByRole("checkbox")).toEqual([]);
    expect(within(dialog).getByTestId("work-add-collector-submit")).toBeDisabled();
  });

  it("saves nothing when the linked repositories could not be read (negative)", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()], null),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    expect(within(dialog).getByTestId("work-collector-repos")).toHaveTextContent(
      "oxagen could not read this workspace's repositories, so you cannot save now. Try again in a moment.",
    );
    expect(within(dialog).getByTestId("work-add-collector-submit")).toBeDisabled();
    expect(document.querySelector('[data-linked="false"]')).toBeNull();
  });

  it("disables Add collector and Read now for a role that cannot change them", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([FAILING]),
      list: workList([], { canControl: false, canApprove: false }),
    });
    expect(screen.getByTestId("work-add-collector")).toBeDisabled();
    expect(screen.getByTestId("work-add-collector")).toHaveAccessibleDescription(
      "Your role cannot change collectors in this workspace.",
    );
    expect(screen.getByTestId("work-reconnect-github")).toBeDisabled();
  });

  it("leaves the buttons on when the roles read fails, so the server decides", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
      list: readError("work_records_unavailable", 503),
    });
    expect(screen.getByTestId("work-add-collector")).toBeEnabled();
  });

  it("replaces the tab body when the collectors read is refused", async () => {
    await renderSetup("collectors", {
      collectors: { ok: false, reason: "denied", permission: "run.read" },
    });
    expect(screen.getByTestId("work-denied")).toHaveTextContent(
      "No access to Collectors",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Work setup" }),
    ).toBeInTheDocument();
  });
});

const NO_RECORD = priorities({
  record: null,
  problem:
    "This workspace has no priorities record, so triage has no rules to rank by. Add a steering record named work.priorities, or one whose name ends in .work.priorities, with numbered rules, then retry triage.",
});

const STARTER = [
  "Give every work item one Priority label, P0 to P3, and cite the rule you used.",
  "",
  "1. A security hole or a risk of losing customer data is P0.",
  "2. Production is down, or a customer cannot work and has no workaround, is P1.",
  "3. A defect a customer reported ranks one level above the same defect we found ourselves.",
  "4. Work that unblocks a P0 or P1 item takes that item's priority.",
  "5. A defect with a workaround is P2.",
  "6. Docs and chores are P3 unless a rule above says otherwise.",
];

describe("Work setup › Priorities", () => {
  it("shows the record's lineage, version, numbered rules and triage figures", async () => {
    await renderSetup("priorities", { priorities: priorities() });
    const record = screen.getByTestId("work-priorities-record");
    expect(
      within(record).getByRole("heading", { name: "a-intel.work.priorities" }),
    ).toBeInTheDocument();
    expect(record).toHaveTextContent("v7");
    expect(record).toHaveTextContent(/Published on Sep 20, 2026/);
    const rules = within(screen.getByTestId("work-priorities-rules"))
      .getAllByRole("listitem")
      .map((rule) => rule.textContent);
    expect(rules).toEqual([
      "#1Production is down, or customer data is at risk.",
      "#2A customer cannot finish a task and has no workaround.",
      "#3A defect with a workaround.",
    ]);
    expect(screen.getByTestId("work-priorities-edit")).toHaveAttribute(
      "href",
      "/a-intel/core-platform/steering/records/a-intel.work.priorities",
    );
    expect(screen.queryByTestId("work-priorities-editor")).toBeNull();
    const triage = screen.getByTestId("work-priorities-triage");
    expect(triage.querySelector('[data-figure="suggestions"]')).toHaveTextContent("118");
    expect(triage.querySelector('[data-figure="failures"]')).toHaveTextContent("2");
    expect(triage.querySelector('[data-figure="corrections"]')).toHaveTextContent("8");
  });

  it("says why triage cannot rank work while no record is merged, and offers the editor", async () => {
    await renderSetup("priorities", { priorities: NO_RECORD });
    const none = screen.getByTestId("work-priorities-none");
    expect(none).toHaveTextContent("No priorities record");
    expect(none).toHaveTextContent(
      "Triage cannot rank work until a priorities record is merged.",
    );
    expect(screen.getByTestId("work-priorities-problem")).toHaveTextContent(
      "This workspace has no priorities record",
    );
    expect(screen.queryByTestId("work-priorities-edit")).toBeNull();
    const editor = screen.getByTestId("work-priorities-editor");
    expect(within(editor).getByLabelText("Instruction")).toHaveValue(STARTER[0]);
    expect(within(screen.getByTestId("work-priorities-editor-rules")).getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByTestId("work-priorities-preview").textContent).toBe(STARTER.join("\n"));
  });

  it("writes the record with one line per rule, opens its pull request, and links the review", async () => {
    proposePriorities.mockResolvedValue({
      ok: true,
      value: { proposalId: "prp_priorities1", lineageId: "work.priorities" },
    });
    openPrioritiesPr.mockResolvedValue({
      ok: true,
      value: {
        proposalId: "prp_priorities1",
        pr: { number: 12, url: "https://github.com/a-intel/steering/pull/12", repository: "a-intel/steering" },
      },
    });
    await renderSetup("priorities", { priorities: NO_RECORD });
    const user = userEvent.setup();
    const editor = screen.getByTestId("work-priorities-editor");
    await user.click(within(editor).getByRole("button", { name: "Remove rule 5" }));
    await user.click(within(editor).getByRole("button", { name: "Move rule 5 up" }));
    await user.click(within(editor).getByTestId("work-priorities-add-rule"));
    await user.type(
      within(editor).getByRole("textbox", { name: "Rule 6" }),
      "Billing defects are P1.{Enter}Even small ones.",
    );
    await user.click(within(editor).getByTestId("work-priorities-submit"));
    expect(proposePriorities).toHaveBeenCalledWith("a-intel", "core-platform", {
      statement: [
        STARTER[0],
        "",
        STARTER[2],
        STARTER[3],
        STARTER[4],
        "4. Docs and chores are P3 unless a rule above says otherwise.",
        "5. Work that unblocks a P0 or P1 item takes that item's priority.",
        "6. Billing defects are P1. Even small ones.",
      ].join("\n"),
    });
    expect(openPrioritiesPr).toHaveBeenCalledWith("a-intel", "core-platform", {
      proposalId: "prp_priorities1",
    });
    const opened = await screen.findByTestId("work-priorities-opened");
    expect(opened).toHaveTextContent("Steering PR #12 in a-intel/steering adds the priorities record.");
    expect(within(opened).getByTestId("work-priorities-pr")).toHaveAttribute(
      "href",
      "https://github.com/a-intel/steering/pull/12",
    );
    expect(within(opened).getByTestId("work-priorities-review")).toHaveAttribute(
      "href",
      "/a-intel/core-platform/steering/proposals/prs/prp_priorities1",
    );
  });

  it("reuses the proposal when the pull request failed to open", async () => {
    proposePriorities.mockResolvedValue({
      ok: true,
      value: { proposalId: "prp_priorities1", lineageId: "work.priorities" },
    });
    openPrioritiesPr
      .mockResolvedValueOnce({ ok: false, reason: "unavailable", code: "github_unavailable" })
      .mockResolvedValueOnce({ ok: true, value: { proposalId: "prp_priorities1", pr: null } });
    await renderSetup("priorities", { priorities: NO_RECORD });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-priorities-submit"));
    expect(await screen.findByTestId("work-priorities-failure")).toBeInTheDocument();
    await user.click(screen.getByTestId("work-priorities-submit"));
    expect(await screen.findByTestId("work-priorities-opened")).toHaveTextContent(
      "no pull request is open yet",
    );
    expect(proposePriorities).toHaveBeenCalledTimes(1);
    expect(openPrioritiesPr).toHaveBeenCalledTimes(2);
  });

  it("refuses a record with no rules and proposes nothing (negative)", async () => {
    await renderSetup("priorities", { priorities: NO_RECORD });
    const user = userEvent.setup();
    for (let n = 6; n >= 1; n -= 1)
      await user.click(screen.getByRole("button", { name: `Remove rule ${String(n)}` }));
    await user.click(screen.getByTestId("work-priorities-submit"));
    expect(screen.getByTestId("work-priorities-failure")).toHaveTextContent("Write at least one rule.");
    expect(proposePriorities).not.toHaveBeenCalled();
  });

  it("offers no editor when more than one record matches (negative)", async () => {
    await renderSetup("priorities", {
      priorities: priorities({
        record: null,
        problem:
          "This workspace has more than one priorities record (a.work.priorities, b.work.priorities), so triage cannot tell which rules to rank by. Retire all but one, then retry triage.",
      }),
    });
    expect(screen.getByTestId("work-priorities-none")).toBeInTheDocument();
    expect(screen.queryByTestId("work-priorities-editor")).toBeNull();
  });
});

describe("Work setup › Runtimes", () => {
  const AGENTS = [
    target(),
    target({
      id: "agt_reviewer",
      name: "Reviewer",
      canTake: false,
      reason: "busy",
      busyWith: { id: "wki_running", number: "WI-13" },
    }),
    target({
      id: "agt_docsbot",
      name: "Docs bot",
      runtime: null,
      host: null,
      canTake: false,
      reason: "no_runtime",
    }),
    target({
      id: "agt_codexdev",
      name: "Codex dev",
      harness: "codex",
      runtime: { id: "rtm_laptop", name: "Mac's laptop", tier: "harness" },
      canTake: false,
      reason: "not_operator",
      operates: false,
    }),
    target({
      id: "agt_watcher",
      name: "Watcher",
      runtime: { id: "rtm_old", name: "Old host", tier: "observe" },
      host: { name: "old-host", lastPollAt: null, takesWorkOrders: false },
      canTake: false,
      reason: "host_outdated",
    }),
    target({
      id: "agt_quiet",
      name: "Quiet agent",
      runtime: { id: "rtm_box", name: "Build box", tier: "contained" },
      host: {
        name: "build-box",
        lastPollAt: "2026-09-30T09:00:00Z",
        takesWorkOrders: true,
      },
      quiet: true,
    }),
  ];

  it("says which agents can take a send now and why each other cannot", async () => {
    await renderSetup("runtimes", { targets: targetList(AGENTS) });
    expect(screen.getByTestId("work-targets-ready")).toHaveTextContent(
      "2 agents can take a send now",
    );
    const table = within(screen.getByTestId("work-targets-table"));
    expect(
      table.getAllByRole("columnheader").map((th) => th.textContent),
    ).toEqual(["Agent", "Runtime", "Tier", "Send", "Budget"]);
    const ready = row('tr[data-agent="agt_releasemanager"]');
    expect(ready.querySelector('[data-send="ready"]')).toHaveTextContent("Ready");
    expect(ready).toHaveTextContent(/Last poll on Sep 30/);
    expect(ready.querySelector('[data-tier="gateway"]')).toHaveTextContent("gateway");
    const busy = row('tr[data-agent="agt_reviewer"]');
    expect(busy.querySelector('[data-send="busy"]')).toHaveTextContent("Busy");
    expect(busy).toHaveTextContent("Working on WI-13.");
    const unplaced = row('tr[data-agent="agt_docsbot"]');
    expect(unplaced.querySelector('[data-send="blocked"]')).toHaveTextContent(
      "Cannot take work",
    );
    expect(unplaced).toHaveTextContent("This agent is on no runtime.");
    expect(row('tr[data-agent="agt_codexdev"]')).toHaveTextContent(
      "You do not operate this agent.",
    );
    expect(row('tr[data-agent="agt_watcher"]')).toHaveTextContent(
      "The host's oxagen build cannot take work orders. Update the host.",
    );
    expect(row('tr[data-agent="agt_quiet"]')).toHaveTextContent(
      /The host last polled on Sep 30.*A send waits until it polls\./,
    );
    expect(screen.getByText(
      "oxagen starts no agent itself. The runtime starts the run once it claims the send.",
    )).toBeInTheDocument();
  });

  it("names where each agent's budget holds by its tier", async () => {
    await renderSetup("runtimes", { targets: targetList(AGENTS) });
    const budget = (agent: string) =>
      row(`tr[data-agent="${agent}"] [data-budget]`);
    expect(budget("agt_releasemanager")).toHaveTextContent(
      "The gateway holds Release manager's budget before each model call when its version sets a ceiling.",
    );
    expect(budget("agt_quiet")).toHaveTextContent(
      "The gateway holds Quiet agent's budget before each model call when its version sets a ceiling.",
    );
    expect(budget("agt_codexdev")).toHaveTextContent(
      "oxagen records spend after the run. Nothing stops the run at a limit.",
    );
    expect(budget("agt_watcher")).toHaveTextContent(
      "oxagen records spend after the run. Nothing stops the run at a limit.",
    );
    expect(budget("agt_docsbot")).toHaveTextContent("none");
  });

  it("points at Agents when the workspace has none", async () => {
    await renderSetup("runtimes", { targets: targetList([]) });
    const empty = screen.getByTestId("work-targets-empty");
    expect(within(empty).getByRole("link", { name: "Open Agents" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/agents",
    );
  });

  it("names the code when the targets read fails", async () => {
    await renderSetup("runtimes", {
      targets: readError("work_records_unavailable", 503),
    });
    expect(screen.getByTestId("work-error")).toHaveTextContent(
      "Runtimes could not be loaded",
    );
  });
});
