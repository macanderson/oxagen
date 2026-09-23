#!/usr/bin/env tsx
/**
 * Publish one context record as a merge request on a real gitlab.com project,
 * through the same GitLab steering seam and checks `open_context_pr` and
 * `merge_context_pr` use (#3762), and write the evidence to a JSON file.
 *
 * Usage:
 *
 *   GITLAB_TOKEN=glpat-… GITLAB_PROJECT=group/project \
 *     pnpm tsx tools/scripts/gitlab-steering-exercise.ts \
 *       --out verifications/<session>/gitlab-exercise.json [--merge]
 *
 * Without `--merge` it stops after the checks, leaving the merge request open.
 * With `--merge` it squash-merges the checked head into the project's default
 * branch, then reads the record back from that branch. Use a scratch project:
 * the merge adds `.oxagen/rules/<lineage>.toml` to its default branch.
 *
 * What it proves and what it does not. It runs the real `@oxagen/gitlab`
 * client, the real token verification `attach_gitlab_project` applies, the
 * real GitLab seam, the real record file and the real six checks against
 * gitlab.com. It does not run the handlers' Postgres store or role gate,
 * which need a database and a signed-in user; the unit tests cover those. The
 * token is read from the environment, sent only to gitlab.com, and never
 * written to the output.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { parseArgs } from "node:util";
import { createGitLabClient, parseGitLabProjectPath } from "@oxagen/gitlab";
import {
  CHECK_TITLES,
  runChecks,
} from "@oxagen/handlers/context.steering.checks";
import {
  buildRecordFile,
  contextBranch,
  recordFilePath,
  serializeRecordFile,
} from "@oxagen/handlers/context.steering.file";
import { createSteeringGitLab } from "@oxagen/handlers/context.steering.gitlab";
import { verifyProjectToken } from "@oxagen/handlers/repository.gitlab.attach";

const { values: args } = parseArgs({
  options: {
    out: { type: "string" },
    merge: { type: "boolean", default: false },
  },
});

function fail(message: string): never {
  process.stderr.write(`gitlab-steering-exercise: ${message}\n`);
  process.exit(1);
}

// A refusal from the seam or the token check is one line, reason first. The
// message names the project and never the token.
process.on("uncaughtException", (err: Error & { reason?: string }) => {
  fail(err.reason ? `${err.reason}: ${err.message}` : err.message);
});

const token = process.env["GITLAB_TOKEN"];
const projectPath = process.env["GITLAB_PROJECT"];
if (!token) fail("set GITLAB_TOKEN to a project access token");
if (!projectPath) fail("set GITLAB_PROJECT to group/project");
const path = parseGitLabProjectPath(projectPath);
if (!path) fail(`${projectPath} is not a gitlab.com project path`);
if (!args.out) fail("pass --out <file> for the evidence");

const evidence: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  host: "gitlab.com",
  projectPath: path.fullPath,
};
const step = (name: string, detail: Record<string, unknown>) => {
  evidence[name] = detail;
  process.stdout.write(`${name}: ${JSON.stringify(detail)}\n`);
};

const client = createGitLabClient({ token });

// 1. The token is this project's own, with the api scope.
const { project, expiresAt } = await verifyProjectToken(client, path.fullPath);
step("token", {
  projectId: project.id,
  pathWithNamespace: project.pathWithNamespace,
  defaultBranch: project.defaultBranch,
  tokenExpiresAt: expiresAt,
});

// 2. The seam, bound the way `bind_main_repository` binds: by project id,
//    with the default branch approved.
const seam = createSteeringGitLab({
  readConnection: async () => ({
    connectionId: "exercise",
    projectId: project.id,
    owner: project.namespaceFullPath,
    repo: project.path,
    approvedFullName: project.pathWithNamespace,
    approvedDefaultRef: project.defaultBranch as string,
  }),
  resolveToken: async () => token,
  client: (t) => createGitLabClient({ token: t }),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});
const scope = {
  orgId: "00000000-0000-4000-8000-000000000000",
  workspaceId: "00000000-0000-4000-8000-000000000000",
};
const repo = await seam.resolveRepository(scope);

// 3. The proposal's file, branch and merge request, as `open_context_pr` makes them.
const lineageId = `ctx.exercise.gitlab-${Date.now().toString(36)}`;
const proposal = {
  lineageId,
  kind: "rule" as const,
  force: "should",
  constraintEffect: null,
  sharingScope: "workspace",
  statement:
    "Run the GitLab steering exercise against a scratch project, never a production one.",
  rationale: "Recorded evidence for #3762.",
  evidenceLinks: [],
};
const file = buildRecordFile({
  lineageId,
  kind: proposal.kind,
  force: "should",
  sharingScope: "workspace",
  statement: proposal.statement,
  origin: "user",
  proposalPublicId: "prp_exercise",
  setId: repo.fullName.replace(/\//g, "."),
});
const recordPath = recordFilePath(lineageId);
const branch = contextBranch(lineageId);
await seam.ensureBranch(repo, branch, repo.defaultBranch);
const { commitSha } = await seam.putFile(repo, {
  path: recordPath,
  content: serializeRecordFile(file),
  message: `steering: propose ${lineageId}`,
  branch,
});
const mr = await seam.openPullRequest(repo, {
  title: `Context PR: ${lineageId}`,
  head: branch,
  base: repo.defaultBranch,
  body: `Exercise for #3762. Proposal prp_exercise.\n\n> ${proposal.statement}`,
});
step("mergeRequest", { iid: mr.number, url: mr.htmlUrl, branch, commitSha });

// 4. The six checks on the file read back from the head, each reported as a
//    commit status.
const head = (await seam.getPullRequest(repo, mr.number)).headSha ?? commitSha;
const [fileText, changedPaths] = await Promise.all([
  seam.readFile(repo, recordPath, head),
  seam.changedPaths(repo, repo.defaultBranch, head),
]);
if (fileText === null) fail(`${recordPath} is not at ${head}`);
const checks: Record<string, unknown>[] = [];
const allPassed = await runChecks(
  {
    fileText,
    path: recordPath,
    changedPaths,
    proposal,
    published: null,
    activeRecords: [],
  },
  {
    start: async () => {},
    finish: async (name, outcome) => {
      const now = new Date().toISOString();
      const detailsUrl = await seam.reportCheckRun(repo, {
        name: `Oxagen · ${CHECK_TITLES[name]}`,
        headSha: head,
        conclusion: outcome.ok ? "success" : "failure",
        title: CHECK_TITLES[name],
        summary: outcome.summary,
        startedAt: now,
        completedAt: now,
      });
      checks.push({
        name,
        ok: outcome.ok,
        summary: outcome.summary,
        detailsUrl,
      });
    },
  },
);
step("checks", { head, allPassed, checks });
if (!allPassed) fail("a check failed; nothing was merged");

// 5. The merge, pinned to the checked head, and the record read back from the
//    production branch.
if (args.merge) {
  const merged = await seam.mergePullRequest(repo, {
    number: mr.number,
    commitTitle: `steering: publish ${lineageId} (#${mr.number})`,
    sha: head,
  });
  const after = await seam.getPullRequest(repo, mr.number);
  const published = await seam.readFile(repo, recordPath, repo.defaultBranch);
  await seam.deleteBranch(repo, branch);
  step("merge", {
    mergeCommit: merged.sha,
    mergedAt: after.mergedAt?.toISOString() ?? null,
    recordOnDefaultBranch: published === fileText,
  });
} else {
  step("merge", { skipped: "pass --merge to squash-merge the checked head" });
}

evidence["finishedAt"] = new Date().toISOString();
await mkdir(dirname(args.out), { recursive: true });
await writeFile(args.out, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
process.stdout.write(`evidence written to ${args.out}\n`);
