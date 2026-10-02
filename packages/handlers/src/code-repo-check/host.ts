// code-repo-check/host.ts: what the check reads from and writes to a code
// repository's host, over the GitHub and GitLab clients.
//
// The Oxagen check is posted from outside the repository, so no workflow file
// lives in it. On GitHub it is a check run, posted with the Oxagen GitHub
// App's installation token. On GitLab it is a commit status, posted with the
// project's stored access token.
import type { GitHubClient } from "@oxagen/github";
import type { GitLabClient } from "@oxagen/gitlab";
import { CODE_REPOSITORY_CHECK_NAME } from "@oxagen/oxagen/steering-repo/names";
import type { CheckReport } from "./report";

/** One check, as the run posts it. */
export interface PostedCheck {
  headSha: string;
  report: CheckReport;
  startedAt: string;
  completedAt: string;
  /** The workspace the check speaks for. GitHub keeps it as the run's external id. */
  workspaceId: string;
}

/** One code repository on its host. */
export interface CodeHost {
  /**
   * Every path the pull request changes that still exists at `head`, from
   * the merge base of `base` and `head`. A rename names its new path.
   */
  changedPaths(base: string, head: string): Promise<string[]>;
  /** A file's text at `ref`, or null when the ref has no such file. */
  readFile(path: string, ref: string): Promise<string | null>;
  postCheck(check: PostedCheck): Promise<void>;
}

/** The owner and name of `owner/name`. */
export function splitFullName(fullName: string): { owner: string; name: string } {
  const cut = fullName.indexOf("/");
  return { owner: fullName.slice(0, cut), name: fullName.slice(cut + 1) };
}

/** A GitHub repository, read and checked through an installation client. */
export function githubCodeHost(
  gh: Pick<GitHubClient, "compareCommits" | "getFileContent" | "createCheckRun">,
  fullName: string,
): CodeHost {
  const { owner, name: repo } = splitFullName(fullName);
  return {
    async changedPaths(base, head) {
      const files = await gh.compareCommits({ owner, repo, base, head });
      return files.filter((f) => f.status !== "removed").map((f) => f.path);
    },
    readFile: (path, ref) => gh.getFileContent({ owner, repo, path, ref }),
    async postCheck(check) {
      await gh.createCheckRun({
        owner,
        repo,
        name: CODE_REPOSITORY_CHECK_NAME,
        headSha: check.headSha,
        status: "completed",
        conclusion: check.report.conclusion,
        title: check.report.title,
        summary: check.report.summary,
        externalId: check.workspaceId,
        startedAt: check.startedAt,
        completedAt: check.completedAt,
      });
    },
  };
}

/** A GitLab project, read and checked through the project's access token. */
export function gitlabCodeHost(
  gl: Pick<GitLabClient, "compare" | "getFileRaw" | "setCommitStatus">,
  projectId: string,
): CodeHost {
  return {
    async changedPaths(base, head) {
      const changes = await gl.compare({ project: projectId, from: base, to: head });
      return changes.filter((c) => !c.deleted).map((c) => c.newPath);
    },
    readFile: (path, ref) => gl.getFileRaw({ project: projectId, path, ref }),
    async postCheck(check) {
      // GitLab has no neutral status. A warning passes, and its description
      // counts the findings.
      await gl.setCommitStatus({
        project: projectId,
        sha: check.headSha,
        state: check.report.conclusion === "failure" ? "failed" : "success",
        name: CODE_REPOSITORY_CHECK_NAME,
        description: check.report.description,
      });
    },
  };
}
