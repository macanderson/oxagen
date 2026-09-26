// @vitest-environment jsdom
// The Issues tab (mockup `issuesTab` then `linkedWork`): the issues
// `get_run_issues` lists (#3970), each with its status as GitHub read it,
// its relation, its edge with the frames that show it, and a link to its
// tracker; the Status filter and the Rows pager over them; then Linked work,
// whose every row says how Oxagen knows it, from the same work and outputs
// reads the header and the Changes panel draw; then the run follow-through
// panels.
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunOutputs } from "@/data/contracts/run";
import type { RunIssues } from "@/data/contracts/run-issues";
import type { RunWork } from "@/data/contracts/run-work";
import { type Read, readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { IntlProvider } from "@/test/intl";
import { runIssue, runIssues } from "./issues.builders";
import {
  runDetail,
  runOutputNode,
  runOutputs,
  runRow,
  runSource,
} from "./run.builders";
import { runWork, tabProps } from "./sections.builders";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../run-outcomes/actions", () => ({
  setRunOutcomesConsentAction: vi.fn(),
}));
vi.mock("../run-outcomes/provider-actions", () => ({
  loadRunIssueProviders: vi.fn(),
  authorizeRunIssues: vi.fn(),
}));
vi.mock("@/server/session", () => ({ getSession: vi.fn() }));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { IssuesTab } = await import("./sections");
const { IssuesCount } = await import("./issues-tab");

afterEach(cleanup);

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

const OUTPUTS = runOutputs([
  runOutputNode({
    seq: "28",
    kind: "change",
    name: "release/4.11.0-notes",
    where: "a-intel/platform",
    state: "created",
    note: "cut from main",
    stat: null,
  }),
  runOutputNode({
    seq: "36",
    kind: "pr",
    name: "#511",
    where: "a-intel/platform",
    state: "open",
    note: null,
    stat: null,
  }),
  runOutputNode({
    seq: "33",
    kind: "file",
    name: "RELEASE-4.11.0.md",
    where: "release/4.11.0-notes",
    state: "written",
    note: null,
    stat: { added: 3, removed: 0 },
  }),
  runOutputNode({
    seq: "34",
    kind: "file",
    name: "CHANGELOG.md",
    where: null,
    state: "written",
    note: null,
    stat: { added: 2, removed: 1 },
  }),
]);

async function renderIssues({
  run = runRow({ taskRef: "a-intel/platform#482" }),
  work = readOk(runWork()),
  issues = readOk(runIssues()),
  outputs = readOk(OUTPUTS),
  outcomes,
}: {
  run?: ReturnType<typeof runRow>;
  work?: Read<RunWork>;
  issues?: Read<RunIssues>;
  outputs?: Read<RunOutputs>;
  outcomes?: "throws";
} = {}) {
  const { source } = runSource({ detail: readOk(runDetail({ run })) });
  const settings = vi.fn(() =>
    Promise.resolve(
      readOk({
        customerEnabled: false,
        platformDisabled: false,
        platformDisabledReason: null,
        effectiveEnabled: false,
      }),
    ),
  );
  source.runs.outcomesSettings =
    outcomes === "throws"
      ? () => Promise.reject(new Error("store down"))
      : settings;
  const body = await IssuesTab(
    tabProps({ ctx, source, run, work, issues, outputs }),
  );
  // The Issues table and Linked work suspend on their reads, so the render
  // is awaited.
  const { container } = await act(async () => {
    const rendered = render(<IntlProvider>{body}</IntlProvider>);
    await Promise.resolve();
    return rendered;
  });
  return { container, settings };
}

const region = (name: string) => within(screen.getByRole("region", { name }));

/** The demo run's three issues (pages/run.md, Issues), task first. */
const DEMO = [
  runIssue(),
  runIssue({
    ref: "a-intel/platform#490",
    number: 490,
    title: "Release checklist",
    status: "closed",
    relation: "resolves",
    resolvedBy: [
      { number: 511, url: "https://github.com/a-intel/platform/pull/511" },
    ],
    edge: "observed",
    frameSeqs: ["36"],
    url: "https://github.com/a-intel/platform/issues/490",
  }),
  runIssue({
    ref: "a-intel/platform#480",
    number: 480,
    title: "Changelog misses breaking changes",
    status: "open",
    relation: "referenced",
    actions: ["viewed", "commented"],
    edge: "observed",
    frameSeqs: ["9", "12"],
    url: "https://github.com/a-intel/platform/issues/480",
  }),
];

/** The rows a reader sees, by their issue reference. */
const visible = () =>
  screen
    .getAllByTestId("run-issue")
    .filter((row) => row.style.display !== "none")
    .map((row) => within(row).getAllByText(/#\d+$/)[0]?.textContent);

describe("the Issues panel", () => {
  it("draws get_run_issues row for row, in its order, each with its status, relation, edge and link", async () => {
    const { container } = await renderIssues({
      issues: readOk(runIssues({ issues: DEMO })),
    });
    const issues = region("Issues");
    expect(issues.getByText("3 in this session")).toBeTruthy();
    const table = issues.getByRole("table", { name: "Issues" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map(
          (header) => header.textContent || header.getAttribute("aria-label"),
        ),
    ).toEqual(["Issue", "Status", "Relation", "Edge", "Tracker page"]);
    expect(visible()).toEqual([
      "a-intel/platform#482",
      "a-intel/platform#490",
      "a-intel/platform#480",
    ]);
    const [task, resolves, referenced] = screen.getAllByTestId("run-issue");
    if (task === undefined || resolves === undefined || referenced === undefined)
      throw new Error("expected three rows");
    // The reference in mono and the title GitHub records under it.
    expect(within(task).getByText("Release notes for 4.11.0")).toBeTruthy();
    expect(within(task).getByText("open")).toBeTruthy();
    expect(within(task).getByText("task")).toBeTruthy();
    expect(within(task).getByText("stated")).toBeTruthy();
    expect(within(resolves).getByText("closed")).toBeTruthy();
    expect(within(resolves).getByText("closed by #511")).toBeTruthy();
    expect(within(resolves).getByText("observed")).toBeTruthy();
    // One chip per frame the edge cites, each opening that frame.
    expect(
      within(resolves).getByRole("link", { name: "fr 36" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=36");
    expect(within(referenced).getByText("referenced")).toBeTruthy();
    expect(within(referenced).getByRole("link", { name: "fr 9" })).toBeTruthy();
    expect(within(referenced).getByRole("link", { name: "fr 12" })).toBeTruthy();
    expect(
      within(referenced).getByRole("link", {
        name: "View a-intel/platform#480 on its tracker",
      }),
    ).toHaveAttribute("href", "https://github.com/a-intel/platform/issues/480");
    // Every status was read, so none carries the tracker gap.
    expect(container.querySelector('[data-gap="tracker"]')).toBeNull();
    // The panel has no standing note under the table (run-evidence.md).
    expect(screen.queryByTestId("run-issues-incomplete")).toBeNull();
    await screen.findByTestId("run-linked-work");
    await expectNoAxe(container);
  });

  it("marks only a status that was not read with the tracker gap, and says why (negative)", async () => {
    await renderIssues({
      issues: readOk(
        runIssues({
          issues: [
            runIssue(),
            runIssue({
              ref: "ENG-4121",
              repository: null,
              number: null,
              title: null,
              status: null,
              statusRead: "not_github",
              readAt: null,
              relation: "referenced",
              edge: "observed",
              url: null,
            }),
          ],
        }),
      ),
    });
    const [read, unread] = screen.getAllByTestId("run-issue");
    if (read === undefined || unread === undefined)
      throw new Error("expected two rows");
    expect(read.querySelector('[data-gap="tracker"]')).toBeNull();
    const gap = unread.querySelector('[data-gap="tracker"]');
    expect(gap).toHaveTextContent("status unknown");
    expect(gap).toHaveAttribute(
      "title",
      "This tracker is not GitHub, so Oxagen does not read its status.",
    );
    // No page is named, so the row links nowhere.
    expect(within(unread).queryByRole("link")).toBeNull();
    expect(within(unread).getByText("no link")).toBeTruthy();
  });

  it("filters the rows by status, and keeps an unread status under All alone", async () => {
    await renderIssues({
      issues: readOk(
        runIssues({
          issues: [
            ...DEMO,
            runIssue({
              ref: "#3",
              repository: null,
              number: 3,
              title: null,
              status: null,
              statusRead: "repository_unknown",
              readAt: null,
              relation: "referenced",
              edge: "observed",
              url: null,
            }),
          ],
        }),
      ),
    });
    const filter = screen.getByRole("combobox", { name: "Filter by status" });
    expect(
      within(filter)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["All · Status", "open", "closed", "in progress", "blocked"]);
    await userEvent.selectOptions(filter, "closed");
    expect(visible()).toEqual(["a-intel/platform#490"]);
    await userEvent.selectOptions(filter, "open");
    expect(visible()).toEqual(["a-intel/platform#482", "a-intel/platform#480"]);
    await userEvent.selectOptions(filter, "blocked");
    expect(screen.queryAllByTestId("run-issue")).toHaveLength(0);
    expect(screen.getByText("No issue has this status.")).toBeTruthy();
    await userEvent.selectOptions(filter, "");
    expect(visible()).toHaveLength(4);
  });

  it("pages the rows with the list's Rows select", async () => {
    const many = Array.from({ length: 7 }, (_, i) =>
      runIssue({
        ref: `a-intel/platform#${String(500 + i)}`,
        number: 500 + i,
        relation: "referenced",
        edge: "observed",
        frameSeqs: [String(i + 1)],
        url: `https://github.com/a-intel/platform/issues/${String(500 + i)}`,
      }),
    );
    await renderIssues({ issues: readOk(runIssues({ issues: many })) });
    expect(visible()).toHaveLength(7);
    await userEvent.selectOptions(
      screen.getByRole("combobox", { name: "Rows" }),
      "5",
    );
    expect(visible()).toEqual([
      "a-intel/platform#500",
      "a-intel/platform#501",
      "a-intel/platform#502",
      "a-intel/platform#503",
      "a-intel/platform#504",
    ]);
    const pager = screen.getByRole("navigation", { name: "Issues pages" });
    expect(pager).toHaveTextContent("1–5 of 7");
    await userEvent.click(
      within(pager).getByRole("button", { name: "Next page" }),
    );
    expect(visible()).toEqual(["a-intel/platform#505", "a-intel/platform#506"]);
  });

  it("says the list may be short, and counts a floor, when a limit cut it (negative)", async () => {
    await renderIssues({
      issues: readOk(
        runIssues({
          complete: false,
          warnings: ["closing_issues_read_failed"],
        }),
      ),
    });
    expect(region("Issues").getByText("1+ in this session")).toBeTruthy();
    expect(screen.getByTestId("run-issues-incomplete")).toHaveTextContent(
      "Some records could not be read, so this list may be short.",
    );
  });

  it("says no issue is linked, and draws no table, when the run names none (negative)", async () => {
    await renderIssues({
      run: runRow({ taskRef: null }),
      issues: readOk(runIssues({ issues: [] })),
    });
    expect(screen.getByText("No issue is linked to this session.")).toBeTruthy();
    expect(screen.getByText("0 in this session")).toBeTruthy();
    expect(screen.queryByRole("table", { name: "Issues" })).toBeNull();
    cleanup();
    await renderIssues({
      run: runRow({ taskRef: null }),
      issues: readOk(runIssues({ issues: [], complete: false })),
    });
    expect(
      screen.getByText(
        "No issue was found in what Oxagen could read. Some records could not be read, so an issue may be missing.",
      ),
    ).toBeTruthy();
  });

  it("names the failed read and draws no rows when the issues could not be loaded (negative)", async () => {
    await renderIssues({ issues: readError("frame_store_unreachable", 502) });
    const issues = region("Issues");
    expect(issues.queryAllByTestId("run-issue")).toHaveLength(0);
    expect(issues.getByText(/Issues could not be loaded/)).toBeTruthy();
  });
});

describe("the Issues tab count", () => {
  async function renderCount(
    read: Read<RunIssues>,
    run = runRow({ taskRef: "a-intel/platform#482" }),
  ) {
    await act(async () => {
      render(
        <IntlProvider>
          <span data-testid="count">
            <Suspense fallback="…">
              <IssuesCount run={run} issues={Promise.resolve(read)} />
            </Suspense>
          </span>
        </IntlProvider>,
      );
      await Promise.resolve();
    });
    const count = screen.getByTestId("count");
    // The count suspends on the read; wait for it to leave the fallback.
    await waitFor(() => {
      expect(count).not.toHaveTextContent("…");
    });
    return count;
  }

  it("counts the rows the table draws", async () => {
    const count = await renderCount(readOk(runIssues({ issues: DEMO })));
    expect(count).toHaveTextContent(/^3$/);
  });

  it("counts a floor when a limit cut the list, or when the read failed (negative)", async () => {
    expect(
      await renderCount(readOk(runIssues({ issues: DEMO, complete: false }))),
    ).toHaveTextContent(/^3\+$/);
    cleanup();
    // A failed read knows only the task the run names.
    expect(
      await renderCount(readError("frame_store_unreachable", 502)),
    ).toHaveTextContent(/^1\+$/);
  });
});

describe("Linked work", () => {
  it("lists the recorded checkout's repository as observed, with the frames that saw it", async () => {
    await renderIssues();
    const [repo] = await screen.findAllByTestId("run-linked-repository");
    if (repo === undefined) throw new Error("a repository");
    expect(
      within(repo).getByRole("link", { name: "a-intel/platform" }),
    ).toHaveAttribute("href", "https://github.com/a-intel/platform");
    expect(
      within(repo).getByText(
        "branch release/4.11.0-notes · head 3f2a9c1 · mbell-mbp-16:~/src/platform/.worktrees/release-4.11.0-notes",
      ),
    ).toBeTruthy();
    expect(within(repo).getByText("observed")).toBeTruthy();
    expect(within(repo).getByRole("link", { name: "fr 3" })).toHaveAttribute(
      "href",
      "/acme/core-platform/runs/tse_7k2m9q?tab=actions&body=3",
    );
    expect(within(repo).getByRole("link", { name: "fr 28" })).toBeTruthy();
  });

  it("draws the pull request once, observed with the frame the outputs recorded it on, with its checks and the failing one linked", async () => {
    await renderIssues();
    const pulls = await screen.findAllByTestId("run-linked-pull");
    expect(pulls).toHaveLength(1);
    const [pull] = pulls;
    if (pull === undefined) throw new Error("a pull request");
    expect(
      within(pull).getByRole("link", { name: "a-intel/platform#511" }),
    ).toHaveAttribute("href", "https://github.com/a-intel/platform/pull/511");
    expect(within(pull).getByText("open")).toBeTruthy();
    expect(within(pull).getByText("Release notes for 4.11.0")).toBeTruthy();
    expect(
      within(pull).getByText("2 passed, 1 failed, 0 pending"),
    ).toBeTruthy();
    expect(within(pull).getByRole("link", { name: "docs" })).toHaveAttribute(
      "href",
      "https://github.com/a-intel/platform/actions/runs/1",
    );
    expect(within(pull).getByText("observed")).toBeTruthy();
    expect(within(pull).getByRole("link", { name: "fr 36" })).toBeTruthy();
    // The output `#511` is that pull request, so it is not listed a second time.
    expect(screen.queryByText("#511")).toBeNull();
  });

  it("says a pull request that only matches a recorded branch is a branch match, never observed (negative)", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined) throw new Error("a pull request");
    await renderIssues({
      work: readOk(
        runWork({
          pullRequests: [{ ...pull, association: "branch", current: false }],
        }),
      ),
      outputs: readOk(runOutputs([])),
    });
    const [row] = await screen.findAllByTestId("run-linked-pull");
    if (row === undefined) throw new Error("a pull request");
    expect(within(row).getByText("branch match")).toBeTruthy();
    expect(within(row).queryByText("observed")).toBeNull();
    expect(
      within(row).getByText(
        "The head moved or could not be verified since this was read.",
      ),
    ).toBeTruthy();
  });

  it("lists the other artifacts the outputs recorded, each linked to the forge and the frame", async () => {
    await renderIssues();
    const [branch] = await screen.findAllByTestId("run-linked-artifact");
    if (branch === undefined) throw new Error("an artifact");
    expect(
      within(branch).getByRole("link", { name: "release/4.11.0-notes" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/a-intel/platform/tree/release/4.11.0-notes",
    );
    expect(within(branch).getByText("created")).toBeTruthy();
    expect(within(branch).getByRole("link", { name: "fr 28" })).toBeTruthy();
  });

  it("draws each changed file with its stat, the forge's patch where a pull request carries it, and the captured diffs", async () => {
    await renderIssues();
    const files = region("Files changed");
    const rows = await screen.findAllByTestId("run-linked-file");
    expect(rows.map((row) => row.tagName)).toEqual(["DETAILS", "DIV"]);
    const [release, changelog] = rows;
    if (release === undefined || changelog === undefined)
      throw new Error("two files");
    expect(within(release).getByText("RELEASE-4.11.0.md")).toBeTruthy();
    expect(within(release).getByText("+# 4.11.0")).toBeTruthy();
    expect(within(changelog).getByText("patch not captured")).toBeTruthy();
    expect(
      files.getByText(/2 files · as the recorder reported them/),
    ).toBeTruthy();
    const [captured] = screen.getAllByTestId("run-linked-captured");
    if (captured === undefined) throw new Error("a captured diff");
    expect(within(captured).getByText("patch retained")).toBeTruthy();
    expect(within(captured).getByRole("link", { name: "fr 31" })).toBeTruthy();
  });

  it("counts the inferred rows against the total, and none is inferred", async () => {
    await renderIssues();
    expect(await screen.findByTestId("run-linked-inferred")).toHaveTextContent(
      "None of 3 rows.",
    );
  });

  it("says nothing was recorded rather than drawing empty lists as zeros of work (negative)", async () => {
    await renderIssues({
      work: readOk(
        runWork({
          checkouts: [],
          pullRequests: [],
          diffs: [],
          complete: false,
        }),
      ),
      outputs: readOk(runOutputs([])),
    });
    expect(
      await screen.findByText(
        "No checkout or pull request was recorded for this run.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Nothing was produced yet.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Files changed" })).toBeNull();
    expect(
      screen.getByText(
        "Some work or provider evidence is unavailable or outside this read's limits.",
      ),
    ).toBeTruthy();
  });

  it("names the work read's failure instead of drawing its lists (negative)", async () => {
    await renderIssues({ work: readError("frame_store_unreachable", 502) });
    const linked = await screen.findByTestId("run-linked-work");
    expect(
      within(linked).getByText(/frame_store_unreachable|could not|failed/i),
    ).toBeTruthy();
    expect(screen.queryByTestId("run-linked-repository")).toBeNull();
  });

  it("says a checkout's repository, branch and head were not recorded, and prints the path alone when no machine is named (negative)", async () => {
    const [checkout] = runWork().checkouts;
    if (checkout === undefined) throw new Error("a checkout");
    await renderIssues({
      work: readOk(
        runWork({
          machine: null,
          checkouts: [
            {
              ...checkout,
              repository: null,
              branch: null,
              headSha: null,
              firstSeq: "3",
              lastSeq: "3",
            },
          ],
          pullRequests: [],
          diffs: [],
        }),
      ),
      outputs: readOk(runOutputs([])),
    });
    const [repo] = await screen.findAllByTestId("run-linked-repository");
    if (repo === undefined) throw new Error("a repository");
    expect(within(repo).getByText("Repository not identified")).toBeTruthy();
    expect(within(repo).queryByRole("link", { name: /platform/ })).toBeNull();
    expect(
      within(repo).getByText(
        "branch not recorded · ~/src/platform/.worktrees/release-4.11.0-notes",
      ),
    ).toBeTruthy();
    // Seen on one frame, so one frame chip.
    expect(
      within(repo)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["fr 3"]);
  });

  it("lists a repository only a pull request names under that pull request's own match, and shows the match in the legend", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined) throw new Error("a pull request");
    await renderIssues({
      work: readOk(
        runWork({
          checkouts: [],
          diffs: [],
          pullRequests: [{ ...pull, association: "head_commit" }],
        }),
      ),
      outputs: readOk(runOutputs([])),
    });
    const [repo] = await screen.findAllByTestId("run-linked-repository");
    if (repo === undefined) throw new Error("a repository");
    expect(
      within(repo).getByText("named by a pull request, no checkout recorded"),
    ).toBeTruthy();
    expect(within(repo).getByText("commit match")).toBeTruthy();
    expect(within(repo).queryByText("observed")).toBeNull();
    expect(within(repo).queryByRole("link", { name: /^fr / })).toBeNull();
    const [row] = screen.getAllByTestId("run-linked-pull");
    if (row === undefined) throw new Error("a pull request");
    expect(within(row).getByText("commit match")).toBeTruthy();
    expect(screen.getByTestId("run-linked-work")).toHaveTextContent(
      "a pull request whose head is a commit the run recorded",
    );
    expect(screen.getByTestId("run-linked-work")).not.toHaveTextContent(
      "a pull request on a branch the run recorded",
    );
  });

  it("says a pull request's checks could not be read, and when its check list is partial, lists every failing check (negative)", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined || pull.ci === null)
      throw new Error("a pull request with checks");
    type Check = NonNullable<
      RunWork["pullRequests"][number]["ci"]
    >["runs"][number];
    const failing = (name: string, conclusion: Check["conclusion"]): Check => ({
      name,
      status: "completed",
      conclusion,
      url: null,
      startedAt: null,
      completedAt: null,
      durationMs: null,
      app: null,
    });
    await renderIssues({
      work: readOk(
        runWork({
          pullRequests: [
            { ...pull, number: 511, ci: null },
            {
              ...pull,
              number: 512,
              url: "https://github.com/a-intel/platform/pull/512",
              ci: {
                ...pull.ci,
                complete: false,
                runs: [
                  failing("e2e", "timed_out"),
                  failing("deploy", "cancelled"),
                  failing("typecheck", "success"),
                ],
              },
            },
          ],
        }),
      ),
      outputs: readOk(runOutputs([])),
    });
    const [unread, partial] = await screen.findAllByTestId("run-linked-pull");
    if (unread === undefined || partial === undefined)
      throw new Error("two pull requests");
    expect(within(unread).getByText("checks could not be read")).toBeTruthy();
    expect(
      within(partial).getByText("the check list is incomplete"),
    ).toBeTruthy();
    // A check with no URL is named, not linked; a check that passed is not listed.
    expect(
      within(partial).getByTestId("run-linked-failed-checks"),
    ).toHaveTextContent(/^failing: e2e, deploy$/);
    expect(within(partial).queryByRole("link", { name: "e2e" })).toBeNull();
  });

  it("links a recorded commit and branch on the forge, and names what it cannot link without inventing a URL (negative)", async () => {
    const node = (overrides: Parameters<typeof runOutputNode>[0]) =>
      runOutputNode({ state: "pushed", note: null, stat: null, ...overrides });
    await renderIssues({
      outputs: readOk(
        runOutputs([
          node({
            seq: "40",
            kind: "commit",
            name: "3f2a9c1",
            where: "a-intel/platform",
          }),
          node({ seq: "41", kind: "commit", name: "HEAD~1", where: null }),
          node({
            seq: null,
            kind: "media",
            name: "release-banner.png",
            where: null,
            state: "created",
          }),
          node({
            seq: "43",
            kind: "change",
            name: "change 7",
            nameIsLocator: true,
            where: "a-intel/platform",
            note: "2 files",
          }),
          // An output pull request the work read does not hold.
          node({ seq: "44", kind: "pr", name: "a-intel/docs#9", where: null }),
        ]),
      ),
    });
    const rows = await screen.findAllByTestId("run-linked-artifact");
    const byName = (name: string) => {
      const row = rows.find((candidate) =>
        candidate.textContent.includes(name),
      );
      if (row === undefined) throw new Error(`no row for ${name}`);
      return within(row);
    };
    expect(
      byName("3f2a9c1").getByRole("link", { name: "3f2a9c1" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/a-intel/platform/commit/3f2a9c1",
    );
    // A commit named by something other than a sha is not a commit URL.
    expect(byName("HEAD~1").queryByRole("link", { name: "HEAD~1" })).toBeNull();
    // An output with no frame of its own offers no frame chip, and one with
    // no place and no note draws no line between its name and its edge.
    const banner = byName("release-banner.png");
    expect(banner.queryByRole("link", { name: /^fr / })).toBeNull();
    const title = banner.getByText("release-banner.png").closest("b");
    expect(title?.nextElementSibling?.tagName).toBe("DIV");
    // A locator is not a path on the forge.
    const change = byName("change 7");
    expect(change.queryByRole("link", { name: "change 7" })).toBeNull();
    expect(
      change.getByText("The ledger recorded this change without its path."),
    ).toBeTruthy();
    expect(change.getByText("a-intel/platform · 2 files")).toBeTruthy();
    expect(
      byName("a-intel/docs#9").getByRole("link", { name: "fr 44" }),
    ).toBeTruthy();
  });

  it("says the outputs read failed where no pull request is listed, and still draws the captured diffs (negative)", async () => {
    const [diff] = runWork().diffs;
    if (diff === undefined) throw new Error("a diff");
    await renderIssues({
      work: readOk(
        runWork({
          pullRequests: [],
          diffs: [
            {
              ...diff,
              digest: null,
              completeness: "not_retained",
              limitations: ["binary files skipped", "over 1 MB"],
            },
          ],
        }),
      ),
      outputs: readError("frame_store_unreachable", 502),
    });
    expect(
      await screen.findByText(
        "The outputs read failed, so only the pull requests are listed.",
      ),
    ).toBeTruthy();
    const files = region("Files changed");
    expect(files.queryAllByTestId("run-linked-file")).toHaveLength(0);
    expect(files.queryByText(/as the recorder reported them/)).toBeNull();
    const [captured] = files.getAllByTestId("run-linked-captured");
    if (captured === undefined) throw new Error("a captured diff");
    expect(captured).toHaveTextContent("digest recorded, bytes not retained");
    expect(captured).toHaveTextContent("binary files skipped, over 1 MB");
    // No digest was recorded, so no digest is printed.
    expect(captured.querySelector("code")).toBeNull();
  });

  it("numbers a patch's removed and unchanged lines on the old side, and skips the no-newline marker", async () => {
    const [pull] = runWork().pullRequests;
    if (pull === undefined || pull.diff === null)
      throw new Error("a pull request with a diff");
    await renderIssues({
      work: readOk(
        runWork({
          pullRequests: [
            {
              ...pull,
              diff: {
                ...pull.diff,
                files: [
                  {
                    path: "RELEASE-4.11.0.md",
                    previousPath: null,
                    status: "modified",
                    additions: 1,
                    deletions: 1,
                    patch:
                      "@@ -10,2 +10,2 @@\n context\n-old line\n+new line\n\\ No newline at end of file",
                  },
                ],
              },
            },
          ],
        }),
      ),
    });
    const [release] = await screen.findAllByTestId("run-linked-file");
    if (release === undefined) throw new Error("a file");
    const lines = [...release.querySelectorAll("details > div > div")].map(
      (line) => [...line.children].map((cell) => cell.textContent),
    );
    expect(lines).toEqual([
      ["", "", " @@ -10,2 +10,2 @@"],
      ["10", "10", " context"],
      ["11", "", "−old line"],
      ["", "11", "+new line"],
    ]);
  });
});

describe("the follow-through panels", () => {
  it("mounts the consent and issue connection panels over the organization's setting, read once", async () => {
    const { settings } = await renderIssues();
    expect(settings).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("region", { name: "Run follow-through" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("region", { name: "Issue connections" }),
    ).toBeTruthy();
  });

  it("names a setting read that throws as a read failure (negative)", async () => {
    await renderIssues({ outcomes: "throws" });
    expect(
      within(
        screen.getByRole("region", { name: "Run follow-through" }),
      ).getByText(/could not|failed|unavailable|error/i),
    ).toBeTruthy();
  });
});
