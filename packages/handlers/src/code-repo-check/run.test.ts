// One Oxagen check on a linked code repository's pull request (S2b, #5058),
// from the recorded webhook payloads in ./fixtures/ through to the check the
// host receives. The host is an in-memory repository, the registry holds the
// steering repo fixture's records, and memory capture is S6's own
// `ingestMemories` over an in-memory store.
import { readFileSync } from "node:fs";
import { parseGitLabWebhookEvent, type GitLabMergeRequestEvent } from "@oxagen/gitlab";
import type { CodeRepoCheckRequest } from "@oxagen/inngest-functions/code-repo-check-runner";
import { describe, expect, it, vi } from "vitest";

vi.mock("../event-client", () => ({ eventClient: { send: vi.fn() } }));
vi.mock("../logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { ingestMemories, memoryIntakeSchema } from "../memory/runner";
import { statementHash } from "../memory/statement";
import type { MemoryDraft, MemoryStore } from "../memory/types";
import type { PublishedStatement } from "./findings";
import type { CodeHost, PostedCheck } from "./host";
import {
  checkEvent,
  githubPullRequestClose,
  githubPullRequestHead,
  gitlabMergeRequestHead,
} from "./request";
import {
  runCodeRepoCheck,
  type CodeRepoCheckDeps,
  type PullRequestMemory,
} from "./run";
import { memoryFindingStore, type MemoryFindingStore } from "./store.test-support";

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

const SCOPE = {
  orgId: "0192d4a8-7c1e-7a00-8000-00000000ac3e",
  workspaceId: "0192d4a8-7c1e-7a00-8000-0000000c0e01",
};

/** The check request the opened pull request fixture makes. */
function githubRequest(name = "github-pull-request-opened"): CodeRepoCheckRequest {
  const head = githubPullRequestHead(fixture(name));
  if (head === null) throw new Error(`${name} names no pull request`);
  return checkEvent(SCOPE, "github", head, { installationId: 61200044 }).data;
}

const BASE_SHA = "1e2d3c4b5a69788796a5b4c3d2e1f0a9b8c7d6e5";
const HEAD_SHA = "9b1f6c0d2e3a4b5c6d7e8f90a1b2c3d4e5f60718";
/** The head after the synchronize fixture's push. */
const SYNC_SHA = "c47a0e9d1f2b3c4d5e6f708192a3b4c5d6e7f809";

const BASE_CLAUDE = [
  "# Platform",
  "",
  "- Use pnpm for every install in this repository.",
].join("\n");

/** The records the steering repo fixture publishes (packages/oxagen/fixtures/steering-repo). */
const RECORDS: PublishedStatement[] = [
  {
    lineage: "a-intel.platform.no-push-to-main",
    label: "Never push to main",
    kind: "constraint",
    effect: "forbid",
    statement:
      "Do not push to `main` or force-push any shared branch. Open a pull request\nfrom a branch named for the work.",
    path: "steering/platform/a-intel.platform.no-push-to-main.md",
  },
  {
    lineage: "a-intel.platform.tenant-queries",
    label: "Scope every tenant query",
    kind: "code-rule",
    effect: null,
    statement: "Run every tenant query inside withTenantDb so row level security applies to it.",
    path: "steering/platform/a-intel.platform.tenant-queries.md",
  },
];

/**
 * A repository on its host: each file at each ref, and the checks posted on
 * it. A changed path written `old -> new` is a rename.
 */
function repository(files: Record<string, Record<string, string>>, changed: string[]) {
  const posted: PostedCheck[] = [];
  const host: CodeHost = {
    changedFiles: vi.fn(async () =>
      changed.map((entry) => {
        const [from, to] = entry.split(" -> ");
        return to === undefined
          ? { path: entry, previousPath: null }
          : { path: to, previousPath: from ?? null };
      }),
    ),
    touchedPaths: vi.fn(async () => changed.flatMap((entry) => entry.split(" -> "))),
    readFile: vi.fn(async (path: string, ref: string) => files[ref]?.[path] ?? null),
    postCheck: vi.fn(async (check: PostedCheck) => {
      posted.push(check);
    }),
  };
  return { host, posted };
}

/** S6's memory store, in memory: the insert `ingestMemories` writes through. */
function memoryStore() {
  const stored: MemoryDraft[] = [];
  const store = {
    async insertMemories(_scope: unknown, drafts: MemoryDraft[]) {
      let written = 0;
      for (const draft of drafts) {
        if (stored.some((s) => s.dedupeKey === draft.dedupeKey)) continue;
        stored.push(draft);
        written += 1;
      }
      return written;
    },
    async replaceSourceMemory() {
      return false;
    },
  } as unknown as MemoryStore;
  return { store, stored };
}

function deps(over: {
  host: CodeHost;
  blockMerge?: boolean;
  records?: PublishedStatement[];
  store?: MemoryStore;
  findings?: MemoryFindingStore;
}) {
  const store = over.store ?? memoryStore().store;
  const findings = over.findings ?? memoryFindingStore();
  const captured: PullRequestMemory[][] = [];
  const d: CodeRepoCheckDeps = {
    host: vi.fn(async () => over.host),
    workspaceSlug: vi.fn(async () => "platform"),
    publishedRecords: vi.fn(async () => over.records ?? RECORDS),
    blockMerge: vi.fn(async () => over.blockMerge ?? false),
    captureMemories: vi.fn<CodeRepoCheckDeps["captureMemories"]>(async (scope, memories) => {
      captured.push(memories);
      return ingestMemories(store, scope, memories);
    }),
    findings,
    now: () => new Date("2026-10-02T14:12:10.000Z"),
  };
  return { deps: d, captured, findings };
}

describe("runCodeRepoCheck on GitHub", () => {
  it("warns with a neutral check when a line repeats a record and block_merge is off", async () => {
    const { host, posted } = repository(
      {
        [BASE_SHA]: { "CLAUDE.md": BASE_CLAUDE },
        [HEAD_SHA]: {
          "CLAUDE.md": `${BASE_CLAUDE}\n- Run every tenant query inside withTenantDb so row level security applies to it.`,
        },
      },
      ["CLAUDE.md", "src/server.ts"],
    );
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toEqual({
      conclusion: "neutral",
      files: 1,
      findings: 1,
      memories: 0,
    });
    expect(host.changedFiles).toHaveBeenCalledWith(BASE_SHA, HEAD_SHA);
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({
      headSha: HEAD_SHA,
      workspaceId: SCOPE.workspaceId,
      report: {
        conclusion: "neutral",
        title: "1 finding in instruction files",
      },
    });
    expect(posted[0]?.report.summary).toContain(
      "- Repeat: `CLAUDE.md` line 4 says what steering record `a-intel.platform.tenant-queries` (Scope every tenant query) already says.",
    );
    expect(posted[0]?.report.summary).toContain("This check only warns.");
  });

  it("fails the check when the published workspace.toml sets block_merge", async () => {
    const { host, posted } = repository(
      {
        [BASE_SHA]: {},
        [HEAD_SHA]: {
          "AGENTS.md": "- Run every tenant query inside withTenantDb so row level security applies to it.",
        },
      },
      ["AGENTS.md"],
    );
    const { deps: d } = deps({ host, blockMerge: true });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toMatchObject({
      conclusion: "failure",
      findings: 1,
    });
    expect(posted[0]?.report.conclusion).toBe("failure");
    expect(posted[0]?.report.summary).toContain("so a finding fails this check");
  });

  it("finds a contradiction in a rule file a pull request adds", async () => {
    const { host, posted } = repository(
      {
        [BASE_SHA]: {},
        [HEAD_SHA]: {
          ".cursor/rules/git.mdc": [
            "---",
            "description: Git habits",
            "alwaysApply: true",
            "---",
            "- Always push to `main` or force-push any shared branch.",
          ].join("\n"),
        },
      },
      [".cursor/rules/git.mdc"],
    );
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toMatchObject({
      conclusion: "neutral",
      findings: 1,
    });
    expect(posted[0]?.report.summary).toContain(
      "- Contradiction: `.cursor/rules/git.mdc` line 5 says the opposite of steering record `a-intel.platform.no-push-to-main` (Never push to main).",
    );
  });

  it("hands each new line to S6's memory capture with the pull request as evidence, once", async () => {
    const headFiles = {
      "CLAUDE.md": `${BASE_CLAUDE}\n- The staging database resets every Sunday night at midnight UTC.`,
      "services/billing/AGENTS.md":
        "Refund requests over 100 dollars wait for a person on the billing team.",
    };
    const { host, posted } = repository(
      {
        [BASE_SHA]: { "CLAUDE.md": BASE_CLAUDE },
        [HEAD_SHA]: headFiles,
        [SYNC_SHA]: headFiles,
      },
      ["CLAUDE.md", "services/billing/AGENTS.md"],
    );
    const memories = memoryStore();
    const { deps: d, captured } = deps({ host, store: memories.store });
    const request = githubRequest();
    await expect(runCodeRepoCheck(d, request)).resolves.toEqual({
      conclusion: "success",
      files: 2,
      findings: 0,
      memories: 2,
    });

    const sent = captured[0] ?? [];
    expect(sent).toEqual([
      {
        capture: "pull_request",
        source: "https://github.com/a-intel/platform/pull/318",
        agentLineage: null,
        runPublicId: null,
        statement: "The staging database resets every Sunday night at midnight UTC.",
        kind: "memory",
        repos: ["github.com/a-intel/platform"],
        evidence: [
          "https://github.com/a-intel/platform/pull/318",
          `https://github.com/a-intel/platform/blob/${HEAD_SHA}/CLAUDE.md#L4`,
        ],
      },
      {
        capture: "pull_request",
        source: "https://github.com/a-intel/platform/pull/318",
        agentLineage: null,
        runPublicId: null,
        statement: "Refund requests over 100 dollars wait for a person on the billing team.",
        kind: "memory",
        repos: ["github.com/a-intel/platform"],
        applies_to: ["services/billing/**"],
        evidence: [
          "https://github.com/a-intel/platform/pull/318",
          `https://github.com/a-intel/platform/blob/${HEAD_SHA}/services/billing/AGENTS.md#L1`,
        ],
      },
    ]);
    // S6's intake reads every one, so none is refused.
    for (const memory of sent) expect(memoryIntakeSchema.safeParse(memory).success).toBe(true);
    expect(memories.stored).toEqual([
      expect.objectContaining({
        capture: "pull_request",
        source: request.url,
        kind: "memory",
        agentLineage: null,
        runPublicId: null,
        dedupeKey: `pull_request:${request.url}:${statementHash("The staging database resets every Sunday night at midnight UTC.")}`,
      }),
      expect.objectContaining({ appliesTo: ["services/billing/**"] }),
    ]);
    expect(posted[0]?.report.summary).toContain(
      "Oxagen recorded 2 new lines from this pull request as memories.",
    );

    // A second push to the pull request reads the same lines at its new head
    // and stores no second copy.
    await expect(
      runCodeRepoCheck(d, githubRequest("github-pull-request-synchronize")),
    ).resolves.toMatchObject({ memories: 2 });
    expect(host.readFile).toHaveBeenCalledWith("CLAUDE.md", SYNC_SHA);
    expect(captured).toHaveLength(2);
    expect(memories.stored).toHaveLength(2);
  });

  it("hands no repeat and no contradiction to memory capture (negative)", async () => {
    const { host } = repository(
      {
        [BASE_SHA]: {},
        [HEAD_SHA]: {
          "AGENTS.md": [
            "- Run every tenant query inside withTenantDb so row level security applies to it.",
            "- Always push to `main` or force-push any shared branch.",
          ].join("\n"),
        },
      },
      ["AGENTS.md"],
    );
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toMatchObject({
      findings: 2,
      memories: 0,
    });
    expect(d.captureMemories).not.toHaveBeenCalled();
  });

  it("reads a renamed instruction file at its old path, so a move adds nothing", async () => {
    const { host, posted } = repository(
      {
        [BASE_SHA]: { "CLAUDE.md": BASE_CLAUDE },
        [HEAD_SHA]: { "packages/api/CLAUDE.md": BASE_CLAUDE },
      },
      ["CLAUDE.md -> packages/api/CLAUDE.md"],
    );
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toEqual({
      conclusion: "success",
      files: 1,
      findings: 0,
      memories: 0,
    });
    expect(host.readFile).toHaveBeenCalledWith("CLAUDE.md", BASE_SHA);
    expect(host.readFile).toHaveBeenCalledWith("packages/api/CLAUDE.md", HEAD_SHA);
    expect(d.captureMemories).not.toHaveBeenCalled();
    expect(posted[0]?.report.title).toBe("No findings in instruction files");
  });

  it("posts a passing check without reading steering when no instruction file changed", async () => {
    const { host, posted } = repository({}, ["src/server.ts", "README.md"]);
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, githubRequest())).resolves.toEqual({
      conclusion: "success",
      files: 0,
      findings: 0,
      memories: 0,
    });
    expect(posted[0]?.report.title).toBe("No instruction files changed");
    expect(host.readFile).not.toHaveBeenCalled();
    expect(d.publishedRecords).not.toHaveBeenCalled();
    expect(d.blockMerge).not.toHaveBeenCalled();
    expect(d.captureMemories).not.toHaveBeenCalled();
  });

  it("posts no check when memory capture throws, so the job retries (negative)", async () => {
    const { host, posted } = repository(
      { [BASE_SHA]: {}, [HEAD_SHA]: { "CLAUDE.md": "The staging database resets every Sunday night." } },
      ["CLAUDE.md"],
    );
    const { deps: d } = deps({ host });
    d.captureMemories = vi.fn(async () => {
      throw new Error("pg down");
    });
    await expect(runCodeRepoCheck(d, githubRequest())).rejects.toThrow("pg down");
    expect(posted).toEqual([]);
  });
});

describe("the stored findings (ADR-253)", () => {
  const CONTRADICTION = "Always push to `main` or force-push any shared branch.";

  it("stores each statement it flags, with its pull request and commit, before the check posts", async () => {
    const { host, posted } = repository(
      { [BASE_SHA]: {}, [HEAD_SHA]: { "AGENTS.md": `# Agents\n\n- ${CONTRADICTION}` } },
      ["AGENTS.md"],
    );
    const { deps: d, findings } = deps({ host });
    const order: string[] = [];
    const replace = findings.replacePullRequest.bind(findings);
    d.findings = {
      ...findings,
      replacePullRequest: async (...args) => {
        order.push("stored");
        await replace(...args);
      },
    };
    vi.mocked(host.postCheck).mockImplementation(async (check) => {
      order.push("posted");
      posted.push(check);
    });
    await runCodeRepoCheck(d, githubRequest());
    expect(order).toEqual(["stored", "posted"]);
    expect(findings.rows).toEqual([
      expect.objectContaining({
        orgId: SCOPE.orgId,
        workspaceId: SCOPE.workspaceId,
        provider: "github",
        providerRepositoryId: "771020341",
        repository: "a-intel/platform",
        pullRequestNumber: 318,
        pullRequestUrl: "https://github.com/a-intel/platform/pull/318",
        pullRequestState: "open",
        headSha: HEAD_SHA,
        path: "AGENTS.md",
        line: 3,
        statement: CONTRADICTION,
        proposalPublicId: null,
      }),
    ]);
  });

  it("keeps a statement's id and proposal across pushes, and clears it when a push removes the line", async () => {
    const withLine = { "AGENTS.md": `- ${CONTRADICTION}` };
    const { host } = repository(
      { [BASE_SHA]: {}, [HEAD_SHA]: withLine, [SYNC_SHA]: { "AGENTS.md": `- Note.\n- ${CONTRADICTION}` } },
      ["AGENTS.md"],
    );
    const { deps: d, findings } = deps({ host });
    await runCodeRepoCheck(d, githubRequest());
    const first = findings.rows[0];
    if (first === undefined) throw new Error("nothing stored");
    await findings.setProposal(SCOPE, first.publicId, "prp_kept1");

    await runCodeRepoCheck(d, githubRequest("github-pull-request-synchronize"));
    expect(findings.rows).toHaveLength(1);
    expect(findings.rows[0]).toMatchObject({
      publicId: first.publicId,
      proposalPublicId: "prp_kept1",
      headSha: SYNC_SHA,
      line: 2,
    });

    // The next push drops the line, so the pull request flags nothing.
    const cleared = repository({ [BASE_SHA]: {}, [SYNC_SHA]: { "AGENTS.md": "- Note." } }, ["AGENTS.md"]);
    d.host = vi.fn(async () => cleared.host);
    await runCodeRepoCheck(d, githubRequest("github-pull-request-synchronize"));
    expect(findings.rows).toEqual([]);
  });

  it("deletes a pull request's findings when it closes without merging, and posts nothing", async () => {
    const { host, posted } = repository({ [BASE_SHA]: {}, [HEAD_SHA]: { "AGENTS.md": `- ${CONTRADICTION}` } }, ["AGENTS.md"]);
    const { deps: d, findings } = deps({ host });
    await runCodeRepoCheck(d, githubRequest());
    expect(findings.rows).toHaveLength(1);
    posted.length = 0;

    const request = { ...githubRequest(), closed: "unmerged" as const };
    await expect(runCodeRepoCheck(d, request)).resolves.toEqual({
      conclusion: null,
      settled: "unmerged",
      files: 0,
      findings: 1,
      memories: 0,
    });
    expect(findings.rows).toEqual([]);
    expect(posted).toEqual([]);
  });

  it("keeps a merged pull request's findings, and deletes an earlier merged one the merge removed from its file", async () => {
    const closedBody = fixture("github-pull-request-closed");
    const closed = githubPullRequestClose(closedBody);
    if (closed === null) throw new Error("the fixture names no closed pull request");
    const request = checkEvent(SCOPE, "github", closed.head, { installationId: 61200044 }, closed.close).data;
    const MERGE_SHA = "5c4b3a2918f7e6d5c4b3a2918f7e6d5c4b3a2918";
    const KEPT = "Run every tenant query inside withTenantDb so row level security applies to it.";
    const findings = memoryFindingStore();
    const earlier = {
      orgId: SCOPE.orgId,
      workspaceId: SCOPE.workspaceId,
      provider: "github" as const,
      providerRepositoryId: "771020341",
      repository: "a-intel/platform",
      pullRequestUrl: "https://github.com/a-intel/platform/pull/300",
      pullRequestState: "merged" as const,
      headSha: BASE_SHA,
      proposalPublicId: null,
      checkedAt: new Date("2026-10-01T00:00:00.000Z"),
    };
    findings.rows.push(
      { ...earlier, publicId: "crf_gone", pullRequestNumber: 300, path: "CLAUDE.md", line: 3, statement: CONTRADICTION },
      { ...earlier, publicId: "crf_kept", pullRequestNumber: 301, path: "CLAUDE.md", line: 4, statement: KEPT },
      // A file this merge did not touch is not read, so its row stays.
      { ...earlier, publicId: "crf_untouched", pullRequestNumber: 302, path: "AGENTS.md", line: 1, statement: CONTRADICTION },
      { ...earlier, publicId: "crf_this", pullRequestNumber: 318, pullRequestState: "open", path: "CLAUDE.md", line: 9, statement: "x y z" },
    );
    const { host, posted } = repository(
      { [MERGE_SHA]: { "CLAUDE.md": `# Platform\n\n- ${KEPT}` } },
      ["CLAUDE.md"],
    );
    const { deps: d } = deps({ host, findings });
    await expect(runCodeRepoCheck(d, request)).resolves.toEqual({
      conclusion: null,
      settled: "merged",
      files: 1,
      findings: 1,
      memories: 0,
    });
    expect(host.touchedPaths).toHaveBeenCalledWith(BASE_SHA, SYNC_SHA);
    expect(host.readFile).toHaveBeenCalledWith("CLAUDE.md", MERGE_SHA);
    expect(findings.rows.map((row) => row.publicId).sort()).toEqual([
      "crf_kept",
      "crf_this",
      "crf_untouched",
    ]);
    expect(findings.rows.find((row) => row.publicId === "crf_this")).toMatchObject({
      pullRequestState: "merged",
      headSha: SYNC_SHA,
    });
    expect(posted).toEqual([]);
  });

  it("reads no file when no earlier merged finding sits in the repository (negative)", async () => {
    const closed = githubPullRequestClose(fixture("github-pull-request-closed"));
    if (closed === null) throw new Error("the fixture names no closed pull request");
    const request = checkEvent(SCOPE, "github", closed.head, { installationId: 61200044 }, closed.close).data;
    const { host } = repository({}, ["CLAUDE.md"]);
    const { deps: d } = deps({ host });
    await expect(runCodeRepoCheck(d, request)).resolves.toMatchObject({ settled: "merged", findings: 0 });
    expect(d.host).not.toHaveBeenCalled();
  });
});

describe("runCodeRepoCheck on GitLab", () => {
  it("reads against the target branch and links memory evidence to the project", async () => {
    const body = fixture("gitlab-merge-request-opened");
    const event = parseGitLabWebhookEvent(body) as GitLabMergeRequestEvent;
    const head = gitlabMergeRequestHead(event, body);
    if (head === null) throw new Error("the fixture names no merge request");
    const request = checkEvent(SCOPE, "gitlab", head, {
      connectionId: "0192d4a8-7c1e-7a00-8000-00000000c011",
    }).data;
    const { host, posted } = repository(
      {
        main: { "AGENTS.md": "- Use pnpm for every install in this repository." },
        [head.headSha]: {
          "AGENTS.md": [
            "- Use pnpm for every install in this repository.",
            "- Never run every tenant query inside withTenantDb so row level security applies to it.",
            "- Tag a release only after the staging smoke test passes.",
          ].join("\n"),
        },
      },
      ["AGENTS.md"],
    );
    const { deps: d, captured } = deps({ host });
    await expect(runCodeRepoCheck(d, request)).resolves.toEqual({
      conclusion: "neutral",
      files: 1,
      findings: 1,
      memories: 1,
    });
    expect(host.readFile).toHaveBeenCalledWith("AGENTS.md", "main");
    expect(posted[0]?.report.description).toBe(
      "1 finding in instruction files. This check only warns.",
    );
    expect(captured[0]?.[0]).toMatchObject({
      repos: ["gitlab.com/acme/platform/api"],
      evidence: [
        "https://gitlab.com/acme/platform/api/-/merge_requests/7",
        `https://gitlab.com/acme/platform/api/-/blob/${head.headSha}/AGENTS.md#L3`,
      ],
    });
  });
});
