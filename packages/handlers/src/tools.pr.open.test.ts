// tools.pr.open.ts: the one write path for a tools steering PR. These tests
// run the opener over an in-memory host, with the steering checks stubbed, and
// read back every call it made.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  checkSteeringChange: vi.fn(),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));
vi.mock("./context.steering.checks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./context.steering.checks")>()),
  checkSteeringChange: mocks.checkSteeringChange,
  steeringTreeHost: vi.fn(() => ({})),
}));
vi.mock("./context.steering.host", () => ({
  createSteeringHost: vi.fn(() => {
    throw new Error("each test passes its own host");
  }),
}));

import { OXAGEN_PR_LABELS } from "@oxagen/github";
import { HandlerError } from "@oxagen/oxagen";
import { fixtureRepo } from "@oxagen/oxagen/steering-repo/fixture-repo";
import { REQUIRED_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import { GOVERNANCE_TOML_PATH } from "@oxagen/oxagen/steering-repo/paths";
import type { CheckReport, Finding } from "@oxagen/steering-check";
import type { SteeringRepository } from "./context.steering.github";
import { logger } from "./logger";
import {
  checkRunText,
  createSteeringPrOpener,
  createToolsPullRequestOpener,
  toolsPullRequestRefusal,
  type ToolsPullRequestArgs,
  type ToolsPullRequestHost,
  type ToolsPullRequestOpener,
} from "./tools.pr.open";

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-00000000ac3f",
};
const PRODUCTION_HEAD = "1111111111111111111111111111111111111111";
const BRANCH_HEAD = "2222222222222222222222222222222222222222";
const NEW_SHA = "3333333333333333333333333333333333333333";
/** A production commit older than PRODUCTION_HEAD, which a caller read before a merge. */
const READ_SHA = "4444444444444444444444444444444444444444";
const NOW = new Date("2026-09-28T21:00:00.000Z");

const GITHUB_REPO: SteeringRepository = {
  provider: "github",
  owner: "acme",
  repo: "steering",
  fullName: "acme/steering",
  currentFullName: "acme/steering",
  defaultBranch: "main",
};
const GITLAB_REPO: SteeringRepository = {
  provider: "gitlab",
  projectId: "4242",
  owner: "acme/platform",
  repo: "steering",
  fullName: "acme/platform/steering",
  currentFullName: "acme/platform/steering",
  defaultBranch: "production",
};

const GOVERNANCE = (() => {
  const text = fixtureRepo().get(GOVERNANCE_TOML_PATH);
  if (text === undefined) {
    throw new Error(`${GOVERNANCE_TOML_PATH} is missing from the fixture repo`);
  }
  return text;
})();

const PASSED: CheckReport = { passed: true, results: [], findings: [] };

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    check: "schema",
    rule: "missing-field",
    severity: "error",
    path: "tools/servers/billing/tools.toml",
    line: 3,
    field: "tools.list_invoices.risk",
    message: "list_invoices has no risk.",
    expected: "risk is low, medium, or high.",
    fix: "Set risk on list_invoices.",
    ...overrides,
  };
}

interface FakeHostOptions {
  repo?: SteeringRepository;
  /** The text at steering/governance.toml on the production branch, or null. */
  governance?: string | null;
  /** Each branch's head commit. */
  branches?: Record<string, string>;
  /** The open PR findOpenPullRequest answers, or null. */
  openPr?: { number: number; htmlUrl: string; body: string } | null;
}

/** A host that records every call and answers from the options. */
function fakeHost(options: FakeHostOptions = {}) {
  const repo = options.repo ?? GITHUB_REPO;
  const branches = new Map(
    Object.entries(
      options.branches ?? { [repo.defaultBranch]: PRODUCTION_HEAD },
    ),
  );
  const calls: { method: string; repo: SteeringRepository; args: unknown }[] =
    [];
  const record = (method: string, target: SteeringRepository, args: unknown) =>
    calls.push({ method, repo: target, args });
  const host: ToolsPullRequestHost = {
    async resolveRepository() {
      return repo;
    },
    async readFile(target, path, ref) {
      record("readFile", target, { path, ref });
      if (path === GOVERNANCE_TOML_PATH) {
        return options.governance === undefined ? GOVERNANCE : options.governance;
      }
      return null;
    },
    async listFiles() {
      return [];
    },
    async branchHead(target, branch) {
      record("branchHead", target, { branch });
      return branches.get(branch) ?? null;
    },
    async ensureBranch(target, branch, fromBranch, opts) {
      record("ensureBranch", target, { branch, fromBranch, opts });
      branches.set(branch, opts?.at ?? PRODUCTION_HEAD);
    },
    async deleteBranch(target, branch) {
      record("deleteBranch", target, { branch });
      branches.delete(branch);
    },
    async commitFiles(target, commit) {
      record("commitFiles", target, commit);
      branches.set(commit.branch, NEW_SHA);
      return { sha: NEW_SHA };
    },
    async openPullRequest(target, pr) {
      record("openPullRequest", target, pr);
      return { number: 17, htmlUrl: "https://example.test/acme/steering/pull/17" };
    },
    async updatePullRequest(target, pr) {
      record("updatePullRequest", target, pr);
      return {
        number: pr.number,
        htmlUrl: `https://example.test/acme/steering/pull/${pr.number}`,
      };
    },
    async findOpenPullRequest(target, query) {
      record("findOpenPullRequest", target, query);
      return options.openPr ?? null;
    },
    async reportCheckRun(target, check) {
      record("reportCheckRun", target, check);
      return "https://example.test/check/1";
    },
  };
  for (const method of Object.keys(host) as (keyof ToolsPullRequestHost)[]) {
    vi.spyOn(host, method);
  }
  return { host, calls, branches };
}

function opener(host: ToolsPullRequestHost): ToolsPullRequestOpener {
  return createToolsPullRequestOpener({
    host: () => host,
    readIndex: async () => null,
    readContext: async () => ({
      runtimes: [],
      members: [],
      teams: [],
      groups: [],
      credentials: [],
    }),
    now: () => NOW,
  });
}

function args(overrides: Partial<ToolsPullRequestArgs> = {}): ToolsPullRequestArgs {
  return {
    branch: "tools/billing",
    title: "Import the billing server",
    body: "Imports three tools.",
    commitMessage: "Import the billing server",
    files: [
      {
        path: "tools/servers/billing/server.toml",
        content: 'schema = "mcp-server/v1"\n',
      },
      {
        path: "tools/servers/billing/tools.toml",
        content: 'schema = "mcp-tools/v1"\n',
      },
    ],
    ...overrides,
  };
}

/** The reason a rejected promise carries, when it is a HandlerError. */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const err = await promise.then(
    () => {
      throw new Error("expected a refusal");
    },
    (caught: unknown) => caught,
  );
  if (!(err instanceof HandlerError)) throw err;
  return err.reason;
}

beforeEach(() => {
  mocks.checkSteeringChange.mockReset();
  mocks.checkSteeringChange.mockResolvedValue(PASSED);
  vi.mocked(logger.error).mockClear();
  vi.mocked(logger.warn).mockClear();
});

describe("toolsPullRequestRefusal", () => {
  it("accepts files under the branch's own folder", () => {
    expect(toolsPullRequestRefusal(args())).toBeNull();
  });

  it("refuses a branch outside tools/", () => {
    expect(
      toolsPullRequestRefusal(args({ branch: "steering/billing" }))?.reason,
    ).toBe("branch_prefix");
  });

  it("refuses a bare tools/ branch", () => {
    expect(toolsPullRequestRefusal(args({ branch: "tools/" }))?.reason).toBe(
      "branch_prefix",
    );
  });

  it("refuses a commit with no files", () => {
    expect(toolsPullRequestRefusal(args({ files: [] }))?.reason).toBe(
      "no_files",
    );
  });

  it("refuses more files than one steering PR holds", () => {
    const files = Array.from({ length: 300 }, (_, i) => ({
      path: `tools/servers/billing/tests/case-${i}.jsonl`,
      content: "{}\n",
    }));
    expect(toolsPullRequestRefusal(args({ files }))?.reason).toBe(
      "too_many_files",
    );
  });

  it("refuses a path named twice", () => {
    const file = { path: "tools/servers/billing/tools.toml", content: "" };
    expect(
      toolsPullRequestRefusal(args({ files: [file, { ...file, content: null }] }))
        ?.reason,
    ).toBe("duplicate_path");
  });

  it("refuses a path outside tools/", () => {
    expect(
      toolsPullRequestRefusal(
        args({
          files: [{ path: "steering/brand/a.md", content: "text\n" }],
        }),
      )?.reason,
    ).toBe("branch_scope");
  });
});

describe("checkRunText", () => {
  it("reports success when the checks pass", () => {
    const text = checkRunText(PASSED);
    expect(text.conclusion).toBe("success");
    expect(text.title).toBe("Steering checks passed");
  });

  it("counts the errors in the title when the checks fail", () => {
    const report: CheckReport = {
      passed: false,
      results: [
        {
          check: "schema",
          status: "failed",
          summary: "2 errors",
          findings: [finding(), finding({ rule: "other" })],
        },
      ],
      findings: [
        finding(),
        finding({ rule: "other" }),
        finding({ severity: "warning" }),
      ],
    };
    const text = checkRunText(report);
    expect(text.conclusion).toBe("failure");
    expect(text.title).toBe("2 errors in the steering checks");
    expect(text.summary).toContain("list_invoices has no risk.");
  });

  it("cuts a summary longer than a check run holds", () => {
    const long = finding({ message: "x".repeat(70_000) });
    const report: CheckReport = {
      passed: false,
      results: [
        { check: "schema", status: "failed", summary: "1 error", findings: [long] },
      ],
      findings: [long],
    };
    const text = checkRunText(report);
    expect(text.title).toBe("1 error in the steering checks");
    expect(text.summary.length).toBeLessThan(60_200);
    expect(text.summary).toContain("The report is cut here.");
  });
});

describe("createToolsPullRequestOpener, a new PR", () => {
  it("branches from the production head, commits once, opens the PR, and reports the check", async () => {
    const { host, calls } = fakeHost();
    const files = [
      ...args().files,
      { path: "tools/servers/billing/old.graphql", content: null },
    ];
    const result = await opener(host).open(SCOPE, args({ files }));

    expect(result).toEqual({
      number: 17,
      url: "https://example.test/acme/steering/pull/17",
      branch: "tools/billing",
      headSha: NEW_SHA,
    });
    expect(host.ensureBranch).toHaveBeenCalledWith(
      GITHUB_REPO,
      "tools/billing",
      "main",
      { exclusive: true, at: PRODUCTION_HEAD },
    );
    expect(host.commitFiles).toHaveBeenCalledTimes(1);
    expect(host.commitFiles).toHaveBeenCalledWith(GITHUB_REPO, {
      branch: "tools/billing",
      parent: PRODUCTION_HEAD,
      message: "Import the billing server",
      files,
    });
    expect(host.openPullRequest).toHaveBeenCalledWith(GITHUB_REPO, {
      title: "Import the billing server",
      head: "tools/billing",
      base: "main",
      body: "Imports three tools.",
      labels: OXAGEN_PR_LABELS,
    });
    expect(mocks.checkSteeringChange).toHaveBeenCalledWith(
      expect.objectContaining({ head: NEW_SHA, base: PRODUCTION_HEAD, health: null }),
    );
    expect(host.reportCheckRun).toHaveBeenCalledWith(GITHUB_REPO, {
      name: REQUIRED_CHECK_NAME,
      headSha: NEW_SHA,
      conclusion: "success",
      title: "Steering checks passed",
      summary: expect.any(String),
      startedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    });
    expect(host.updatePullRequest).not.toHaveBeenCalled();
    // The order matters: the branch exists before the commit, and the check
    // reports on the commit the PR shows.
    expect(
      calls
        .map((call) => call.method)
        .filter((method) => method !== "readFile" && method !== "branchHead"),
    ).toEqual(["ensureBranch", "commitFiles", "openPullRequest", "reportCheckRun"]);
  });

  it("branches from the commit the caller read, not a newer production head", async () => {
    const { host } = fakeHost();
    await opener(host).open(SCOPE, args({ at: READ_SHA }));

    // A merge after READ_SHA stays out of this commit's parent, so the PR
    // cannot undo it.
    expect(host.ensureBranch).toHaveBeenCalledWith(
      GITHUB_REPO,
      "tools/billing",
      "main",
      { exclusive: true, at: READ_SHA },
    );
    expect(host.commitFiles).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({ branch: "tools/billing", parent: READ_SHA }),
    );
    expect(mocks.checkSteeringChange).toHaveBeenCalledWith(
      expect.objectContaining({ head: NEW_SHA, base: READ_SHA }),
    );
  });

  it("answers the open PR when the check does not report", async () => {
    const { host } = fakeHost();
    vi.mocked(host.reportCheckRun).mockRejectedValueOnce(
      new Error("check runs are down"),
    );
    const result = await opener(host).open(SCOPE, args());

    expect(result).toEqual({
      number: 17,
      url: "https://example.test/acme/steering/pull/17",
      branch: "tools/billing",
      headSha: NEW_SHA,
    });
    expect(host.deleteBranch).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ head: NEW_SHA }),
      "tools.pr.open: the Oxagen steering check was not reported",
    );
  });

  it("deletes the branch when the PR does not open, so a retry succeeds", async () => {
    const { host, branches, calls } = fakeHost();
    const down = new Error("pull requests are down");
    vi.mocked(host.openPullRequest).mockRejectedValueOnce(down);

    await expect(opener(host).open(SCOPE, args())).rejects.toBe(down);
    // The lookup comes first: the branch goes only once no PR is found on it.
    expect(host.findOpenPullRequest).toHaveBeenCalledWith(GITHUB_REPO, {
      head: "tools/billing",
      base: "main",
    });
    const order = calls.map((call) => call.method);
    expect(order.indexOf("findOpenPullRequest")).toBeLessThan(
      order.indexOf("deleteBranch"),
    );
    expect(host.deleteBranch).toHaveBeenCalledWith(GITHUB_REPO, "tools/billing");
    expect(branches.has("tools/billing")).toBe(false);
    expect(host.reportCheckRun).not.toHaveBeenCalled();

    const result = await opener(host).open(SCOPE, args());
    expect(result.number).toBe(17);
  });

  it.each([
    { provider: "GitHub", repo: GITHUB_REPO },
    { provider: "GitLab", repo: GITLAB_REPO },
  ])(
    "adopts the PR on $provider when the create call fails but the PR opened",
    async ({ repo }) => {
      const opened = {
        number: 23,
        htmlUrl: "https://example.test/acme/steering/pull/23",
        body: "Imports three tools.",
      };
      const { host, branches } = fakeHost({ repo, openPr: opened });
      vi.mocked(host.openPullRequest).mockRejectedValueOnce(
        new Error("the response timed out"),
      );

      const result = await opener(host).open(SCOPE, args());

      expect(result).toEqual({
        number: 23,
        url: "https://example.test/acme/steering/pull/23",
        branch: "tools/billing",
        headSha: NEW_SHA,
      });
      expect(host.findOpenPullRequest).toHaveBeenCalledWith(repo, {
        head: "tools/billing",
        base: repo.defaultBranch,
      });
      // Deleting the branch would close the PR that opened.
      expect(host.deleteBranch).not.toHaveBeenCalled();
      expect(branches.get("tools/billing")).toBe(NEW_SHA);
      expect(host.reportCheckRun).toHaveBeenCalledWith(
        repo,
        expect.objectContaining({ headSha: NEW_SHA }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ branch: "tools/billing", number: 23 }),
        "tools.pr.open: the PR opened although its create call failed, so the opener adopted it",
      );
    },
  );

  it("keeps the branch when the PR lookup fails after the create call fails", async () => {
    const { host, branches } = fakeHost();
    const down = new Error("pull requests are down");
    vi.mocked(host.openPullRequest).mockRejectedValueOnce(down);
    vi.mocked(host.findOpenPullRequest).mockRejectedValueOnce(
      new Error("the PR list is down"),
    );

    await expect(opener(host).open(SCOPE, args())).rejects.toBe(down);
    expect(host.deleteBranch).not.toHaveBeenCalled();
    expect(branches.get("tools/billing")).toBe(NEW_SHA);
    expect(host.reportCheckRun).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "tools/billing" }),
      "tools.pr.open: the branch was kept because the PR lookup failed after the PR did not open",
    );

    // A PR may be open on the kept branch, so a retry is refused, not doubled.
    expect(await reasonOf(opener(host).open(SCOPE, args()))).toBe(
      "tools_branch_exists",
    );
  });

  it("passes on the first failure when the branch cannot be deleted", async () => {
    const { host } = fakeHost();
    const down = new Error("pull requests are down");
    vi.mocked(host.openPullRequest).mockRejectedValueOnce(down);
    vi.mocked(host.deleteBranch).mockRejectedValueOnce(
      new Error("refs are down"),
    );

    await expect(opener(host).open(SCOPE, args())).rejects.toBe(down);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ branch: "tools/billing" }),
      "tools.pr.open: the branch of a PR that did not open was not deleted",
    );
  });

  it("refuses a branch that already exists", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
    });
    expect(await reasonOf(opener(host).open(SCOPE, args()))).toBe(
      "tools_branch_exists",
    );
    expect(host.ensureBranch).not.toHaveBeenCalled();
    expect(host.commitFiles).not.toHaveBeenCalled();
  });

  it("refuses a repository on the legacy layout", async () => {
    const { host } = fakeHost({ governance: null });
    expect(await reasonOf(opener(host).open(SCOPE, args()))).toBe(
      "steering_repo_required",
    );
    expect(host.ensureBranch).not.toHaveBeenCalled();
  });

  it("refuses a repository without its production branch", async () => {
    const { host } = fakeHost({ branches: {} });
    const err = await opener(host)
      .open(SCOPE, args())
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(HandlerError);
    expect((err as HandlerError).reason).toBe("production_branch_missing");
    expect((err as HandlerError).message).toBe(
      "acme/steering has no main branch.",
    );
  });

  it("refuses bad arguments before it calls the host", async () => {
    const { host } = fakeHost();
    expect(
      await reasonOf(opener(host).open(SCOPE, args({ branch: "policy/billing" }))),
    ).toBe("branch_prefix");
    expect(await reasonOf(opener(host).open(SCOPE, args({ files: [] })))).toBe(
      "no_files",
    );
    expect(host.resolveRepository).not.toHaveBeenCalled();
  });

  it("reports a failed check when the checks throw", async () => {
    mocks.checkSteeringChange.mockRejectedValue(new Error("index unreadable"));
    const { host } = fakeHost();
    const result = await opener(host).open(SCOPE, args());

    expect(result.number).toBe(17);
    expect(host.reportCheckRun).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({
        name: REQUIRED_CHECK_NAME,
        headSha: NEW_SHA,
        conclusion: "failure",
        title: "The steering checks did not run",
        summary: expect.stringContaining("index unreadable"),
      }),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("reports a failure when the checks find an error", async () => {
    mocks.checkSteeringChange.mockResolvedValue({
      passed: false,
      results: [],
      findings: [finding()],
    } satisfies CheckReport);
    const { host } = fakeHost();
    await opener(host).open(SCOPE, args());
    expect(host.reportCheckRun).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({
        conclusion: "failure",
        title: "1 error in the steering checks",
      }),
    );
  });

  it("sends every call for a GitLab repository to that repository", async () => {
    const { host, calls } = fakeHost({ repo: GITLAB_REPO });
    const result = await opener(host).open(SCOPE, args());

    expect(result.headSha).toBe(NEW_SHA);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.repo).toBe(GITLAB_REPO);
    expect(host.ensureBranch).toHaveBeenCalledWith(
      GITLAB_REPO,
      "tools/billing",
      "production",
      { exclusive: true, at: PRODUCTION_HEAD },
    );
    expect(host.openPullRequest).toHaveBeenCalledWith(
      GITLAB_REPO,
      expect.objectContaining({ base: "production", labels: OXAGEN_PR_LABELS }),
    );
  });
});

describe("createToolsPullRequestOpener, an existing PR", () => {
  const OPEN_PR = {
    number: 12,
    htmlUrl: "https://example.test/acme/steering/pull/12",
    body: "The old body.",
  };

  it("adds one commit on the branch head and replaces the PR body", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: OPEN_PR,
    });
    const result = await opener(host).open(
      SCOPE,
      args({ existing: { number: 12 }, body: "The new body." }),
    );

    expect(result).toEqual({
      number: 12,
      url: "https://example.test/acme/steering/pull/12",
      branch: "tools/billing",
      headSha: NEW_SHA,
    });
    expect(host.findOpenPullRequest).toHaveBeenCalledWith(GITHUB_REPO, {
      head: "tools/billing",
      base: "main",
    });
    expect(host.ensureBranch).not.toHaveBeenCalled();
    expect(host.openPullRequest).not.toHaveBeenCalled();
    expect(host.commitFiles).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({ branch: "tools/billing", parent: BRANCH_HEAD }),
    );
    expect(host.updatePullRequest).toHaveBeenCalledWith(GITHUB_REPO, {
      number: 12,
      title: "Import the billing server",
      body: "The new body.",
    });
    expect(mocks.checkSteeringChange).toHaveBeenCalledWith(
      expect.objectContaining({ head: NEW_SHA, base: PRODUCTION_HEAD }),
    );
    expect(host.reportCheckRun).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({ headSha: NEW_SHA }),
    );
  });

  it("refuses when no PR is open on the branch", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: null,
    });
    expect(
      await reasonOf(opener(host).open(SCOPE, args({ existing: { number: 12 } }))),
    ).toBe("tools_pr_not_open");
    expect(host.commitFiles).not.toHaveBeenCalled();
  });

  it("refuses when the open PR on the branch is another PR", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: { ...OPEN_PR, number: 13 },
    });
    expect(
      await reasonOf(opener(host).open(SCOPE, args({ existing: { number: 12 } }))),
    ).toBe("tools_pr_not_open");
  });

  it("adds the commit when the branch is still at the commit the caller read", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: OPEN_PR,
    });
    const result = await opener(host).open(
      SCOPE,
      args({ existing: { number: 12 }, at: BRANCH_HEAD }),
    );
    expect(result.headSha).toBe(NEW_SHA);
    expect(host.commitFiles).toHaveBeenCalledWith(
      GITHUB_REPO,
      expect.objectContaining({ parent: BRANCH_HEAD }),
    );
  });

  it("refuses a branch that moved off the commit the caller read", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: OPEN_PR,
    });
    expect(
      await reasonOf(
        opener(host).open(SCOPE, args({ existing: { number: 12 }, at: READ_SHA })),
      ),
    ).toBe("tools_branch_moved");
    expect(host.commitFiles).not.toHaveBeenCalled();
    expect(host.updatePullRequest).not.toHaveBeenCalled();
  });

  it("refuses when the branch is gone", async () => {
    const { host } = fakeHost({ openPr: OPEN_PR });
    expect(
      await reasonOf(opener(host).open(SCOPE, args({ existing: { number: 12 } }))),
    ).toBe("tools_branch_missing");
    expect(host.commitFiles).not.toHaveBeenCalled();
  });

  it("passes on the host's head_moved refusal and leaves the PR alone", async () => {
    const { host } = fakeHost({
      branches: { main: PRODUCTION_HEAD, "tools/billing": BRANCH_HEAD },
      openPr: OPEN_PR,
    });
    vi.mocked(host.commitFiles).mockRejectedValueOnce(
      new HandlerError({
        code: "conflict",
        reason: "head_moved",
        message: "tools/billing moved.",
      }),
    );
    expect(
      await reasonOf(opener(host).open(SCOPE, args({ existing: { number: 12 } }))),
    ).toBe("head_moved");
    expect(host.updatePullRequest).not.toHaveBeenCalled();
    expect(host.reportCheckRun).not.toHaveBeenCalled();
  });
});

describe("createSteeringPrOpener", () => {
  it("answers false when the workspace has no connected repository", async () => {
    const { host } = fakeHost();
    vi.mocked(host.resolveRepository).mockRejectedValueOnce(
      new HandlerError({
        code: "not_found",
        reason: "workspace_repository_missing",
      }),
    );
    const adapter = createSteeringPrOpener(opener(host), () => host);
    await expect(adapter.hasSteeringRepo(SCOPE)).resolves.toBe(false);
  });

  it("answers true on the steering layout and false on the legacy one", async () => {
    const steering = fakeHost();
    await expect(
      createSteeringPrOpener(opener(steering.host), () => steering.host)
        .hasSteeringRepo(SCOPE),
    ).resolves.toBe(true);

    const legacy = fakeHost({ governance: null });
    await expect(
      createSteeringPrOpener(opener(legacy.host), () => legacy.host)
        .hasSteeringRepo(SCOPE),
    ).resolves.toBe(false);
  });

  it("passes on any other failure to resolve the repository", async () => {
    const { host } = fakeHost();
    vi.mocked(host.resolveRepository).mockRejectedValueOnce(
      new Error("the host is down"),
    );
    const adapter = createSteeringPrOpener(opener(host), () => host);
    await expect(adapter.hasSteeringRepo(SCOPE)).rejects.toThrow(
      "the host is down",
    );
  });

  it("opens through the tools opener and answers its number, url, and branch", async () => {
    const open = vi.fn<ToolsPullRequestOpener["open"]>(async () => ({
      number: 21,
      url: "https://example.test/acme/steering/pull/21",
      branch: "tools/billing",
      headSha: NEW_SHA,
    }));
    const { host } = fakeHost();
    const adapter = createSteeringPrOpener({ open }, () => host);
    const opened = await adapter.open({
      ...SCOPE,
      actorUserId: "0192d4a8-7c1e-7a00-8000-00000000ac40",
      branch: "tools/billing",
      title: "Move billing to a server folder",
      body: "Moves one server.",
      files: [{ path: "tools/servers/billing/server.toml", content: "x\n" }],
    });

    expect(opened).toEqual({
      number: 21,
      url: "https://example.test/acme/steering/pull/21",
      branch: "tools/billing",
    });
    expect(open).toHaveBeenCalledWith(SCOPE, {
      branch: "tools/billing",
      title: "Move billing to a server folder",
      body: "Moves one server.",
      commitMessage: "Move billing to a server folder",
      files: [{ path: "tools/servers/billing/server.toml", content: "x\n" }],
    });
  });

  it("reads a file on the production branch", async () => {
    const { host } = fakeHost({ repo: GITLAB_REPO });
    const adapter = createSteeringPrOpener(opener(host), () => host);
    await expect(adapter.readFile(SCOPE, GOVERNANCE_TOML_PATH)).resolves.toBe(
      GOVERNANCE,
    );
    expect(host.readFile).toHaveBeenCalledWith(
      GITLAB_REPO,
      GOVERNANCE_TOML_PATH,
      "production",
    );
  });
});
