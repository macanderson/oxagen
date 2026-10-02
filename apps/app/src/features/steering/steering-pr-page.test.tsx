// @vitest-environment jsdom
// One steering PR's page over a fake DataSource (#5077): the header with the
// state, the link to the host and the way back to the list it was opened
// from; the record, the pull request with its writes, the diff, the support
// and the activity, each step marked as made in Oxagen or on the host; the
// refresh from the host when the page opens and on demand; Clone; and the
// not-loaded states. An axe check runs in every one.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readError, readOk } from "@/data/read";
import { expectNoAxe } from "@/test/expect-no-axe";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { IntlProvider } from "@/test/intl";
import {
  steeringPr,
  steeringPrDiff,
  PROPOSAL_ID,
  PR_URL,
  type SteeringReads,
  steeringPrSteeringPr,
  steeringSource,
} from "@/test/steering-views";

vi.mock("next/link", () => ({
  default: ({ children, ...rest }: { children: ReactNode; href: string }) => (
    <a {...rest}>{children}</a>
  ),
}));
const { router, refreshSteeringPr } = vi.hoisted(() => ({
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn() },
  refreshSteeringPr: vi.fn(),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => router,
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("./actions", () => ({
  openSteeringPr: vi.fn(),
  mergeSteeringPr: vi.fn(),
  dismissProposal: vi.fn(),
  approveSteeringPr: vi.fn(),
  mergePrWithoutReview: vi.fn(),
  revertSteeringPr: vi.fn(),
  restoreManagedBlock: vi.fn(),
  dropMemoryRecord: vi.fn(),
  refreshSteeringPr,
}));
vi.mock("@/server/session", () => ({
  getSession: vi.fn(),
  getAuthUser: vi.fn(() =>
    Promise.resolve({ name: "Marcus Bell", email: "marcus@acme.test" }),
  ),
}));
vi.mock("@/server/tenancy-lookups", () => ({ systemLookups: {} }));
// The diff section is an async server component. Rendered on the client it
// suspends inside render's act scope, which leaves the page's effects (the
// refresh on open among them) unflushed. The page tests read no diff; the
// diff tests below render SteeringPrDiffBody directly.
vi.mock("./steering-pr-diff", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./steering-pr-diff")>()),
  SteeringPrDiffSection: () => null,
}));

const { WsCtx } = await import("@/server/viewer");
const { unsafeMint } = await import("@/server/viewer.testing");
const { SteeringPrPage, SteeringPrLoading } = await import("./steering-pr-page");
const { SteeringPrDiffBody } = await import("./steering-pr-diff");

const ctx = unsafeMint(WsCtx, {
  userId: "usr_marcusbell",
  orgId: "7a000000-0000-4000-8000-0000000000a1",
  orgSlug: "acme",
  orgName: "Acme Robotics",
  orgRole: "admin",
  workspaceId: "7b000000-0000-4000-8000-000000000001",
  wsSlug: "core-platform",
  wsName: "Core platform",
  wsRole: "member",
});

const BASE = "/acme/core-platform/steering";
const NO_FROM = { state: null, rows: null, offset: null };

async function renderPage(
  reads: Partial<SteeringReads> = {},
  options: {
    proposalId?: string;
    from?: Parameters<typeof SteeringPrPage>[0]["from"];
  } = {},
) {
  const { source, calls } = steeringSource(reads);
  const element = await SteeringPrPage({
    ctx,
    source,
    proposalId: options.proposalId ?? PROPOSAL_ID,
    from: options.from ?? NO_FROM,
  });
  render(<IntlProvider>{element}</IntlProvider>);
  return calls;
}

const section = (name: string) => screen.getByRole("region", { name });

beforeEach(() => {
  router.refresh.mockReset();
  router.replace.mockReset();
  refreshSteeringPr.mockReset();
  refreshSteeringPr.mockResolvedValue({
    ok: true,
    value: {
      changed: false,
      syncRequested: false,
      host: { state: "open", headSha: "9f8e7d6c5b4a", baseRef: "main" },
    },
  });
});

afterEach(async () => {
  try {
    await expectNoAxe(document.body);
  } finally {
    cleanup();
  }
});

describe("the steering PR page", () => {
  it("reads the one steering PR the address names and heads the page with its lineage, state and pull request", async () => {
    const calls = await renderPage();
    expect(calls.steeringPr).toEqual([[ctx, PROPOSAL_ID]]);
    expect(calls.proposals).toEqual([]);
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: "ctx.release.no-reread-changelog",
      }),
    ).toBeInTheDocument();
    expect(screen.getByTestId("steering-pr-page")).toHaveAttribute(
      "data-status",
      "checks_passed",
    );
    const host = screen.getByTestId("steering-pr-host-link");
    expect(host).toHaveTextContent("#519 on acme/core-platform");
    expect(host).toHaveAttribute("href", PR_URL);
    expect(host).toHaveAttribute("target", "_blank");
  });

  it("leads back to the list it was opened from, filter and page kept", async () => {
    await renderPage(
      {},
      { from: { state: "merged", rows: 25, offset: 50 } },
    );
    expect(screen.getByTestId("steering-pr-back")).toHaveAttribute(
      "href",
      `${BASE}/proposals?state=merged&rows=25&offset=50`,
    );
    expect(screen.getByTestId("steering-pr-back")).toHaveTextContent(
      "Back to merged proposals",
    );
  });

  it("leads back to the list of its own state when it was opened from a link", async () => {
    await renderPage({ steeringPr: readOk(steeringPr("rejected")) });
    expect(screen.getByTestId("steering-pr-back")).toHaveAttribute(
      "href",
      `${BASE}/proposals?state=closed`,
    );
  });

  it("shows the record: statement, kind, force, scope, who raised it, when, and why", async () => {
    await renderPage();
    const record = section("Record");
    expect(within(record).getByTestId("steering-pr-statement")).toHaveTextContent(
      "Do not re-read CHANGELOG.md after the first read in a run.",
    );
    expect(record.querySelector('[data-fact="lineage"] dd')).toHaveTextContent(
      "ctx.release.no-reread-changelog",
    );
    expect(record.querySelector('[data-fact="kind"] dd')).toHaveTextContent(
      "rule",
    );
    expect(record.querySelector('[data-fact="force"] dd')).toHaveTextContent(
      "must",
    );
    expect(record.querySelector('[data-fact="scope"] dd')).toHaveTextContent(
      "workspace",
    );
    expect(
      record.querySelector('[data-fact="raised-by"] dd'),
    ).toHaveTextContent("agent:release-bot");
    expect(record).toHaveTextContent(
      "Three sealed runs across two agents read CHANGELOG.md again",
    );
  });

  it("shows a steering PR as a proposal with its kind and no record fields (#5122)", async () => {
    await renderPage({
      steeringPr: readOk(steeringPrSteeringPr("tools", "pr_open")),
    });
    const proposal = section("Proposal");
    expect(screen.queryByRole("region", { name: "Record" })).toBeNull();
    expect(proposal.querySelector('[data-fact="kind"] dd')).toHaveTextContent(
      "tools",
    );
    expect(proposal.querySelector('[data-fact="lineage"]')).toBeNull();
    expect(proposal.querySelector('[data-fact="force"]')).toBeNull();
    expect(proposal.querySelector('[data-fact="scope"]')).toBeNull();
    expect(proposal.querySelector('[data-fact="raised-by"]')).not.toBeNull();
  });

  it("shows the six checks and gives the gold to Merge once they passed", async () => {
    await renderPage();
    const pr = section("Pull request");
    expect(pr.querySelectorAll("[data-check]")).toHaveLength(6);
    const merge = screen.getByRole("button", { name: "Merge pull request" });
    expect(merge).toBeEnabled();
    expect(merge.className).toMatch(/button-primary/);
    expect(
      document.querySelectorAll('[class*="bg-button-primary-bg"]'),
    ).toHaveLength(1);
  });

  it("offers no merge or close once merged, and no Clone (negative)", async () => {
    await renderPage({ steeringPr: readOk(steeringPr("merged")) });
    expect(
      screen.queryByRole("button", { name: "Merge pull request" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Close without merging" }),
    ).toBeNull();
    expect(screen.queryByTestId("clone-steering-pr")).toBeNull();
  });

  it("lists the support, each run a link to its page", async () => {
    await renderPage();
    const support = section("Support");
    expect(
      within(support).getByRole("link", { name: "arun_01k5rs7m" }),
    ).toHaveAttribute("href", "/acme/core-platform/runs/arun_01k5rs7m");
    expect(
      support.querySelector('[data-support="agents"]'),
    ).toHaveTextContent("release-bot");
    expect(
      support.querySelector('[data-support="records"]'),
    ).toHaveTextContent("None cited");
    expect(
      support.querySelector('[data-support="evidence"]'),
    ).toHaveTextContent("frame:arun_01k5rs7m/14");
  });
});

describe("the activity", () => {
  const steps = () =>
    [...section("Activity").querySelectorAll("[data-step]")].map((step) => [
      step.getAttribute("data-step"),
      step.getAttribute("data-origin"),
    ]);

  it("lists raised, opened and the checks, oldest first, with no time for the opening", async () => {
    await renderPage();
    expect(steps()).toEqual([
      ["raised", "oxagen"],
      ["opened", "oxagen"],
      ["checks-started", "oxagen"],
      ["checks-finished", "oxagen"],
    ]);
    expect(
      section("Activity").querySelector('[data-step="opened"]'),
    ).toHaveTextContent("time not recorded");
    expect(
      section("Activity").querySelector('[data-step="checks-finished"]'),
    ).toHaveTextContent("Every check passed");
  });

  it("marks a merge on the host as made on GitHub", async () => {
    const merged = steeringPr("merged");
    if (merged.merged === null) throw new Error("fixture merged");
    await renderPage({
      steeringPr: readOk({
        ...merged,
        merged: { ...merged.merged, byName: null, onHost: true },
      }),
    });
    const step = section("Activity").querySelector('[data-step="merged"]');
    expect(step).toHaveAttribute("data-origin", "host");
    expect(step).toHaveTextContent("on GitHub");
  });

  it("marks a merge in Oxagen with the person who merged it", async () => {
    await renderPage({ steeringPr: readOk(steeringPr("merged")) });
    const step = section("Activity").querySelector('[data-step="merged"]');
    expect(step).toHaveAttribute("data-origin", "oxagen");
    expect(step).toHaveTextContent("in Oxagen by Dana Reyes");
  });

  it("marks a close on the host with the host's reason, and a close in Oxagen with its closer", async () => {
    await renderPage({
      steeringPr: readOk(
        steeringPr("rejected", {
          closed: {
            at: "2026-09-15T09:30:00.000Z",
            reason: "Closed on GitHub without merging",
            byName: null,
            onHost: true,
          },
        }),
      ),
    });
    const host = section("Activity").querySelector('[data-step="closed"]');
    expect(host).toHaveAttribute("data-origin", "host");
    expect(host).toHaveTextContent(
      "Closed: Closed on GitHub without merging",
    );
    cleanup();
    await renderPage({ steeringPr: readOk(steeringPr("rejected")) });
    const app = section("Activity").querySelector('[data-step="closed"]');
    expect(app).toHaveAttribute("data-origin", "oxagen");
    expect(app).toHaveTextContent("in Oxagen by Dana Reyes");
  });
});

describe("the activity, on GitLab and with failures", () => {
  it("names GitLab, a failed check, and a close with no reason", async () => {
    const base = steeringPr("rejected", {
      closed: {
        at: "2026-09-15T09:30:00.000Z",
        reason: null,
        byName: null,
        onHost: true,
      },
    });
    if (base.pr === null) throw new Error("fixture has a pull request");
    await renderPage({
      steeringPr: readOk({
        ...base,
        pr: { ...base.pr, provider: "gitlab" },
        checks: steeringPr("checks_failed").checks,
      }),
    });
    const activity = section("Activity");
    expect(
      activity.querySelector('[data-step="checks-finished"]'),
    ).toHaveTextContent("A check failed");
    const closed = activity.querySelector('[data-step="closed"]');
    expect(closed).toHaveTextContent("Closed without merging");
    expect(closed).toHaveTextContent("on GitLab");
    expect(closed).not.toHaveTextContent("Closed:");
  });

  it("adds no finished step while a check still runs", async () => {
    await renderPage({ steeringPr: readOk(steeringPr("checks_running")) });
    expect(
      section("Activity").querySelector('[data-step="checks-finished"]'),
    ).toBeNull();
  });
});

describe("Refresh from GitHub", () => {
  it("asks the host once when the page opens and reloads the page when the proposal moved", async () => {
    refreshSteeringPr.mockResolvedValue({
      ok: true,
      value: {
        changed: true,
        syncRequested: false,
        host: { state: "closed", headSha: "abc", baseRef: "main" },
      },
    });
    await renderPage();
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
    expect(refreshSteeringPr).toHaveBeenCalledTimes(1);
    expect(refreshSteeringPr).toHaveBeenCalledWith(
      "acme",
      "core-platform",
      PROPOSAL_ID,
    );
  });

  it("says the host merged it while the sync publishes it", async () => {
    refreshSteeringPr.mockResolvedValue({
      ok: true,
      value: {
        changed: false,
        syncRequested: true,
        host: { state: "merged", headSha: "abc", baseRef: "main" },
      },
    });
    await renderPage();
    expect(
      await screen.findByText(/^The host merged this pull request\./),
    ).toHaveAttribute("data-found", "mergedOnHost");
  });

  it("stays quiet on open for a viewer whose role cannot refresh, and says why when pressed (negative)", async () => {
    refreshSteeringPr.mockResolvedValue({
      ok: false,
      reason: "denied",
      code: "org_role_required",
    });
    await renderPage();
    await waitFor(() => {
      expect(refreshSteeringPr).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId("refresh-steering-pr-failure")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh from GitHub" }),
    );
    expect(
      await screen.findByTestId("refresh-steering-pr-failure"),
    ).toHaveTextContent("Your role in this organization or workspace");
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it("names the host's refusal, such as a repository no longer installed (negative)", async () => {
    refreshSteeringPr.mockResolvedValue({
      ok: false,
      reason: "not_found",
      code: "workspace_repository_missing",
    });
    await renderPage();
    expect(
      await screen.findByTestId("refresh-steering-pr-failure"),
    ).toHaveTextContent("no connected repository");
  });

  it("reloads the page when a press finds the proposal moved, and says it matches when it did not", async () => {
    await renderPage();
    await waitFor(() => {
      expect(refreshSteeringPr).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh from GitHub" }),
    );
    expect(await screen.findByText("Matches the host.")).toHaveAttribute(
      "data-found",
      "current",
    );
    refreshSteeringPr.mockResolvedValueOnce({
      ok: true,
      value: {
        changed: true,
        syncRequested: false,
        host: { state: "closed", headSha: "abc", baseRef: "main" },
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh from GitHub" }),
    );
    await waitFor(() => {
      expect(router.refresh).toHaveBeenCalled();
    });
  });

  it("names a press that never answered (negative)", async () => {
    await renderPage();
    await waitFor(() => {
      expect(refreshSteeringPr).toHaveBeenCalledTimes(1);
    });
    refreshSteeringPr.mockRejectedValueOnce(new Error("network"));
    fireEvent.click(
      screen.getByRole("button", { name: "Refresh from GitHub" }),
    );
    expect(
      await screen.findByTestId("refresh-steering-pr-failure"),
    ).toBeInTheDocument();
  });

  it("offers no refresh before a pull request opens (negative)", async () => {
    await renderPage({ steeringPr: readOk(steeringPr("proposed")) });
    expect(screen.queryByTestId("refresh-steering-pr")).toBeNull();
    expect(refreshSteeringPr).not.toHaveBeenCalled();
  });
});

describe("Clone the branch", () => {
  it("lists the clone, fetch and switch commands, and gh pr checkout on GitHub", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Clone the branch" }));
    const dialog = screen.getByTestId("clone-steering-pr-dialog");
    expect(within(dialog).getByTestId("clone-commands")).toHaveTextContent(
      "git clone https://github.com/acme/core-platform.git",
    );
    expect(within(dialog).getByTestId("clone-commands")).toHaveTextContent(
      "git switch steering/ctx.release.no-reread-changelog",
    );
    expect(within(dialog).getByTestId("clone-gh")).toHaveTextContent(
      "gh pr checkout 519 --repo acme/core-platform",
    );
  });
});

describe("the diff", () => {
  it("draws each line the branch adds, numbered on the head", () => {
    render(
      <IntlProvider>
        <SteeringPrDiffBody read={readOk(steeringPrDiff())} prUrl={null} />
      </IntlProvider>,
    );
    const diff = section("Changes");
    expect(diff).toHaveAttribute("data-diff-state", "diff");
    expect(diff.querySelectorAll('[data-line="added"]')).toHaveLength(2);
    expect(diff).toHaveTextContent("9f8e7d6 against main");
  });

  it("says a settled pull request's branch is gone and links its files on the host", () => {
    render(
      <IntlProvider>
        <SteeringPrDiffBody
          read={readOk(steeringPrDiff({ state: "settled", files: [] }))}
          prUrl={parsePullRequestUrl(PR_URL)}
        />
      </IntlProvider>,
    );
    expect(section("Changes")).toHaveTextContent(
      "The branch was deleted when the pull request merged or closed.",
    );
    expect(
      screen.getByRole("link", { name: "Open the files on the host" }),
    ).toHaveAttribute("href", PR_URL);
  });

  it("says no branch exists before a pull request opens, and that a long file was cut", () => {
    render(
      <IntlProvider>
        <SteeringPrDiffBody
          read={readOk(steeringPrDiff({ state: "no_pr", files: [] }))}
          prUrl={null}
        />
      </IntlProvider>,
    );
    expect(section("Changes")).toHaveTextContent(
      "No pull request is open yet",
    );
    cleanup();
    const [file] = steeringPrDiff().files;
    if (file === undefined) throw new Error("fixture has a file");
    render(
      <IntlProvider>
        <SteeringPrDiffBody
          read={readOk(
            steeringPrDiff({
              files: [{ ...file, truncated: true }],
              moreFiles: true,
            }),
          )}
          prUrl={null}
        />
      </IntlProvider>,
    );
    expect(section("Changes")).toHaveTextContent(
      "This file is longer than the page shows.",
    );
    expect(section("Changes")).toHaveTextContent(
      "The pull request changes more files than this page shows.",
    );
  });

  it("marks the lines an edit removes and adds, keeping the ones around it", () => {
    render(
      <IntlProvider>
        <SteeringPrDiffBody
          read={readOk(
            steeringPrDiff({
              files: [
                {
                  path: ".oxagen/rules/a.toml",
                  status: "modified",
                  before: 'id = "a"\nstatement = "old"\n',
                  after: 'id = "a"\nstatement = "new"\n',
                  truncated: false,
                },
              ],
            }),
          )}
          prUrl={null}
        />
      </IntlProvider>,
    );
    const kinds = [
      ...section("Changes").querySelectorAll("[data-line]"),
    ].map((row) => row.getAttribute("data-line"));
    expect(kinds).toEqual(["same", "removed", "added"]);
  });

  it("renders the host's refusal in place of the diff (negative)", () => {
    render(
      <IntlProvider>
        <SteeringPrDiffBody
          read={readError("github_refused", 409)}
          prUrl={null}
        />
      </IntlProvider>,
    );
    expect(section("Changes")).toHaveTextContent(
      "Changes could not be loaded: github_refused.",
    );
    expect(section("Changes").querySelector("[data-diff-file]")).toBeNull();
  });
});

describe("the not-loaded states", () => {
  it("is a 404 for an id that could never name a proposal, before any read (negative)", async () => {
    const { source, calls } = steeringSource();
    await expect(
      SteeringPrPage({
        ctx,
        source,
        proposalId: "prp_1;drop",
        from: NO_FROM,
      }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
    expect(calls.steeringPr).toEqual([]);
  });

  it("is a 404 for a proposal this workspace does not hold (negative)", async () => {
    await expect(
      renderPage({ steeringPr: readError("not_found", 404) }),
    ).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("replaces the page with the denied state, naming who is signed in (negative)", async () => {
    await renderPage({
      steeringPr: { ok: false, reason: "denied", permission: "steering.read" },
    });
    expect(screen.queryByTestId("steering-pr-page")).toBeNull();
    expect(document.body).toHaveTextContent("Marcus Bell");
  });

  it("draws a loading state with no landmark", () => {
    render(
      <IntlProvider>
        <SteeringPrLoading />
      </IntlProvider>,
    );
    expect(screen.getByTestId("steering-pr-loading")).toHaveAttribute(
      "aria-busy",
      "true",
    );
  });
});
