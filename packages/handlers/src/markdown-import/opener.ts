// markdown-import/opener.ts: the steering PR opener a Markdown import uses.
// It is the tools PR opener's flow (tools.pr.open.ts): a new branch from the
// production head, one commit with every file, the PR, and the steering
// checks reported as the "Oxagen steering" check. Only the branch rule
// differs: a steering/import-<date> branch that changes steering records,
// skills, and Cedar policy files (steering-repo/stamp.ts).
import {
  createSteeringPullRequestOpener,
  steeringFilesRefusal,
  workspaceSteeringPullRequestDeps,
  type SteeringPullRequestKind,
  type ToolsPullRequestOpener,
} from "../tools.pr.open";
import { isMarkdownImportBranch } from "../steering-repo/stamp";

/** The Markdown import's kind of steering PR. */
export const MARKDOWN_IMPORT_PULL_REQUEST: SteeringPullRequestKind = {
  reasonPrefix: "import",
  noun: "Markdown import steering PR",
  refusal: (args) =>
    isMarkdownImportBranch(args.branch)
      ? steeringFilesRefusal(args)
      : {
          reason: "branch_prefix",
          message: `${args.branch} is not a steering/import-<YYYY-MM-DD> branch. A Markdown import opens its steering PR on one.`,
        },
};

/** The opener over the workspace's steering host and published index. */
export const markdownImportPullRequestOpener: ToolsPullRequestOpener =
  createSteeringPullRequestOpener(
    workspaceSteeringPullRequestDeps,
    MARKDOWN_IMPORT_PULL_REQUEST,
  );
