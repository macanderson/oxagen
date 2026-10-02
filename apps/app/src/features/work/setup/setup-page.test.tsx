// @vitest-environment jsdom
// Work setup over a fake DataSource: each tab's reads and rows, a failing
// collector and the button that reads it again, Add collector with a new and
// an existing name, the missing and unreadable GitHub connections, the
// priorities record with and without a record, and why each agent can or
// cannot take a send with the budget line its tier earns. Each state runs the
// axe check (INV-26).
import {
  cleanup,
  render,
  screen,
  waitFor,
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
  connectionList,
  githubConnection,
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
const { router, setCollector, syncCollector } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  setCollector: vi.fn(),
  syncCollector: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../actions", () => ({ setCollector, syncCollector }));
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
    connections: connectionList([githubConnection()]),
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
  it("reads the collectors, the viewer's roles and the GitHub connections", async () => {
    const { calls } = await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    expect(calls.map((call) => call.read).sort()).toEqual([
      "tools.connections",
      "work.collectors",
      "work.list",
    ]);
    const connections = calls.find((call) => call.read === "tools.connections");
    expect(connections?.args[1]).toEqual({ status: null, connectorId: "github" });
  });

  it("lists each collector with what it reads, its health and manual entry", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const table = screen.getByRole("table", { name: "Collectors" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((th) => th.textContent),
    ).toEqual(["Collector", "Reads", "Health", "Last event"]);
    const github = row('tr[data-collector="github"]');
    expect(github).toHaveTextContent("GitHub Issues");
    expect(github).toHaveTextContent("a-intel/platform");
    expect(github).toHaveTextContent("a-intel/billing-service");
    expect(github.querySelector('[data-health="healthy"]')).toHaveTextContent(
      "Healthy",
    );
    const manual = row('tr[data-collector="manual"]');
    expect(manual).toHaveTextContent("Manual entry");
    expect(manual).toHaveTextContent("On");
    expect(screen.getByTestId("work-write-back")).toHaveTextContent(
      "oxagen reads issues from GitHub and writes nothing back.",
    );
    expect(document.querySelector("[data-collector-failure]")).toBeNull();
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
      "Once the collector reads again, oxagen reads every issue changed since the last good read.",
    );
  });

  it("reads a failing collector again and says the read is queued", async () => {
    syncCollector.mockResolvedValue({ ok: true, value: { queued: true } });
    await renderSetup("collectors", { collectors: collectorList([FAILING]) });
    const user = userEvent.setup();
    const button = screen.getByTestId("work-reconnect-github");
    expect(button).toHaveTextContent("Read github again");
    await user.click(button);
    expect(syncCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "github",
    });
    expect(await screen.findByText("oxagen queued a new read of github.")).toBeInTheDocument();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("shows the refusal when the collector cannot be read again", async () => {
    syncCollector.mockResolvedValue({
      ok: false,
      reason: "conflict",
      code: "collector_paused",
    });
    await renderSetup("collectors", { collectors: collectorList([FAILING]) });
    await userEvent.setup().click(screen.getByTestId("work-reconnect-github"));
    expect(await screen.findByTestId("work-reconnect-failure")).toHaveTextContent(
      "The collector is paused. Resume it before you read it again.",
    );
  });

  it("adds a new collector through the chosen GitHub connection", async () => {
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
    await user.type(within(dialog).getByLabelText("Name"), "github-mobile");
    const select = within(dialog).getByLabelText("GitHub connection");
    expect(within(select).getByRole("option", { name: "Choose a connection" })).toBeInTheDocument();
    await user.selectOptions(select, "con_github01");
    await user.type(
      within(dialog).getByLabelText("Repositories"),
      "a-intel/mobile{Enter}a-intel/mobile-api",
    );
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(setCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "github-mobile",
      repos: ["a-intel/mobile", "a-intel/mobile-api"],
      connectionId: "con_github01",
    });
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("changes an existing collector and keeps its connection", async () => {
    setCollector.mockResolvedValue({
      ok: true,
      value: { created: false, reconcileQueued: true },
    });
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    await user.type(within(dialog).getByLabelText("Name"), "github");
    expect(
      within(dialog).getByRole("option", { name: "Keep its connection" }),
    ).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText("Repositories"), "a-intel/platform");
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(setCollector).toHaveBeenCalledWith("a-intel", "core-platform", {
      name: "github",
      repos: ["a-intel/platform"],
      connectionId: null,
    });
  });

  it("refuses a new collector with no connection, or a bad name or repository", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    const submit = within(dialog).getByTestId("work-add-collector-submit");
    await user.type(within(dialog).getByLabelText("Name"), "GitHub Mobile");
    await user.click(submit);
    expect(within(dialog).getByTestId("work-action-failure")).toHaveTextContent(
      "Use lowercase words joined by single hyphens.",
    );
    await user.clear(within(dialog).getByLabelText("Name"));
    await user.type(within(dialog).getByLabelText("Name"), "github-mobile");
    await user.type(within(dialog).getByLabelText("Repositories"), "mobile");
    await user.click(submit);
    expect(within(dialog).getByTestId("work-action-failure")).toHaveTextContent(
      "Write each repository as owner/name.",
    );
    await user.clear(within(dialog).getByLabelText("Repositories"));
    await user.type(within(dialog).getByLabelText("Repositories"), "a-intel/mobile");
    await user.click(submit);
    expect(within(dialog).getByTestId("work-action-failure")).toHaveTextContent(
      "Choose a GitHub connection for a new collector.",
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
    await user.type(within(dialog).getByLabelText("Name"), "github");
    await user.type(within(dialog).getByLabelText("Repositories"), "a-intel/platform");
    await user.click(within(dialog).getByTestId("work-add-collector-submit"));
    expect(
      await within(dialog).findByTestId("work-action-failure"),
    ).toHaveTextContent(
      "oxagen found no such collector or GitHub connection in this workspace. Nothing changed.",
    );
  });

  it("sends a person to Repositories when no GitHub account is connected", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([]),
      connections: connectionList([githubConnection({ status: "error" })]),
    });
    expect(screen.getByTestId("work-collectors-empty")).toHaveTextContent(
      "No collector yet. People can still add work items by title.",
    );
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    const message = within(dialog).getByTestId("work-add-collector-no-connection");
    expect(within(message).getByRole("link", { name: "Repositories" })).toHaveAttribute(
      "href",
      "/a-intel/core-platform/repositories",
    );
    expect(within(dialog).getByLabelText("GitHub connection")).toBeDisabled();
    expect(within(dialog).getByTestId("work-add-collector-submit")).toBeDisabled();
  });

  it("disables only the connection picker when the connections read fails", async () => {
    await renderSetup("collectors", {
      collectors: collectorList([collector()]),
      connections: readError("control_plane_unavailable", 503),
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("work-add-collector"));
    const dialog = await screen.findByTestId("work-add-collector-dialog");
    const select = within(dialog).getByLabelText("GitHub connection");
    expect(select).toBeDisabled();
    expect(select).toHaveAccessibleDescription(
      "oxagen could not read the GitHub connections. You can still change the repositories of an existing collector.",
    );
    expect(within(dialog).getByTestId("work-add-collector-submit")).toBeEnabled();
  });

  it("disables Add collector and the read button for a role that cannot change them", async () => {
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
    const triage = screen.getByTestId("work-priorities-triage");
    expect(triage.querySelector('[data-figure="suggestions"]')).toHaveTextContent("118");
    expect(triage.querySelector('[data-figure="failures"]')).toHaveTextContent("2");
    expect(triage.querySelector('[data-figure="corrections"]')).toHaveTextContent("8");
  });

  it("says why triage cannot rank work while no record is merged", async () => {
    await renderSetup("priorities", {
      priorities: priorities({
        record: null,
        problem: "No priorities record is published in the steering repo.",
      }),
    });
    const none = screen.getByTestId("work-priorities-none");
    expect(none).toHaveTextContent("No priorities record");
    expect(none).toHaveTextContent(
      "Triage cannot rank work until a priorities record is merged.",
    );
    expect(screen.getByTestId("work-priorities-problem")).toHaveTextContent(
      "No priorities record is published in the steering repo.",
    );
    expect(screen.queryByTestId("work-priorities-edit")).toBeNull();
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
