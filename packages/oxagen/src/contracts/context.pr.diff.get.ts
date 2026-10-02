// get_context_pr_diff — the files a proposal's Context PR changes, each read
// from the repository host as it is on the production branch and on the
// pull request's head (ADR-061; ADR-184). The Context PR page draws the diff
// from these two texts. It reads only while the branch exists: a merged or
// closed PR's branch is deleted, so the page shows the published record and
// a link to the pull request instead.
import { z } from "zod";
import { registerCapability } from "../registry";

/** The longest text one side of a file carries. Past it the side is cut and says so. */
export const CONTEXT_PR_DIFF_MAX_CHARS = 100_000;

/** The most files one diff reads. A Context PR writes one record file. */
export const CONTEXT_PR_DIFF_MAX_FILES = 20;

export const contextPrDiffGet = registerCapability({
  name: "get_context_pr_diff",
  domain: "context",
  description:
    "Get the files a proposal's Context PR changes, each as it is on the production branch and on the pull request's head, read from GitHub or GitLab now. Empty once the pull request merged or closed, because its branch is deleted.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      proposalId: z.string().regex(/^prp_[0-9A-Za-z]+$/),
    })
    .strict(),
  output: z
    .object({
      proposalId: z.string(),
      /**
       * `diff` while the branch exists, `no_pr` before a pull request opens,
       * `settled` once it merged or closed and its branch is gone.
       */
      state: z.enum(["diff", "no_pr", "settled"]),
      /** The production branch the files are compared against. */
      baseRef: z.string().nullable(),
      /** The pull request's head commit the files were read at. */
      headSha: z.string().nullable(),
      files: z
        .array(
          z
            .object({
              path: z.string(),
              status: z.enum(["added", "modified", "removed"]),
              /** The text on the production branch; null for an added file. */
              before: z.string().nullable(),
              /** The text on the head; null for a removed file. */
              after: z.string().nullable(),
              /** True when a side was longer than CONTEXT_PR_DIFF_MAX_CHARS and was cut. */
              truncated: z.boolean(),
            })
            .strict(),
        )
        .max(CONTEXT_PR_DIFF_MAX_FILES),
      /** True when the pull request changes more files than one diff reads. */
      moreFiles: z.boolean(),
    })
    .strict(),
});

export type ContextPrDiffGetInput = z.output<typeof contextPrDiffGet.input>;
export type ContextPrDiffGetOutput = z.output<typeof contextPrDiffGet.output>;
