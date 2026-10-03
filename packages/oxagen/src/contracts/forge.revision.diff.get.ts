// get_revision_diff — one pull request revision's diff, split into files, as
// the forge store keeps it (ADR-288, ADR-292). The bytes come from the diff
// store and are checked against the sha256 the revision recorded before any
// is answered, so a reader gets exactly what was captured or an error.
//
// A revision whose bytes are not kept (`too_large`, `unreadable`,
// `unconfigured`) answers its file list with no hunks and says why. An answer
// carries at most DIFF_MAX_CHARS of hunks; a file past its own cap, or files
// past the total, are cut and say so, and `paths` reads the rest.
import { z } from "zod";
import { registerCapability } from "../registry";

/** The most hunk text one answer carries, in UTF-16 code units. */
export const REVISION_DIFF_MAX_CHARS = 2_000_000;
/** The most hunk text one file carries before it is cut. */
export const REVISION_DIFF_MAX_FILE_CHARS = 400_000;
/** The most paths one `paths` filter names. */
export const REVISION_DIFF_MAX_PATHS = 100;

export const revisionDiffGet = registerCapability({
  name: "get_revision_diff",
  domain: "run",
  description:
    "Get one pull request revision's diff from Oxagen's own store, split into files, checked against the digest recorded when it was captured. A revision whose diff is not kept answers its file list and the reason.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
      /** `prv_…`, from `get_change_set`. */
      revisionId: z.string().regex(/^prv_[0-9A-Za-z]+$/),
      /** Read only these files; all of them when absent. */
      paths: z
        .array(z.string().min(1).max(4096))
        .max(REVISION_DIFF_MAX_PATHS)
        .optional(),
    })
    .strict(),
  output: z
    .object({
      revisionId: z.string(),
      /** `fpr_…` */
      pullRequestId: z.string(),
      headSha: z.string(),
      mergeBaseSha: z.string().nullable(),
      diffStatus: z.enum(["stored", "too_large", "unreadable", "unconfigured"]),
      complete: z.boolean(),
      limitations: z.array(z.string()),
      /** The sha256 the stored bytes matched; null when none are stored. */
      diffSha256: z.string().nullable(),
      files: z.array(
        z
          .object({
            path: z.string(),
            previousPath: z.string().optional(),
            status: z.enum([
              "added",
              "modified",
              "removed",
              "renamed",
              "copied",
              "changed",
            ]),
            additions: z.number().int().nonnegative().nullable(),
            deletions: z.number().int().nonnegative().nullable(),
            /**
             * The file's hunks from its first `@@` line; null when the bytes
             * are not kept, the file is binary, or the answer's total was
             * spent before it.
             */
            patch: z.string().nullable(),
            binary: z.boolean(),
            /** True when the file's hunks were cut at its cap. */
            truncated: z.boolean(),
          })
          .strict(),
      ),
      /** True when the answer's total cap left later files without hunks. */
      truncated: z.boolean(),
    })
    .strict(),
});

export type RevisionDiffGetInput = z.output<typeof revisionDiffGet.input>;
export type RevisionDiffGetOutput = z.output<typeof revisionDiffGet.output>;
