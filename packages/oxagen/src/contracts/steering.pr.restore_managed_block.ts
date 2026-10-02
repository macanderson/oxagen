/**
 * restore_managed_block: put Oxagen's managed block back in one file of an
 * open steering PR (#4518; steering-repo-spec, Managed blocks).
 *
 * AGENTS.md, CLAUDE.md, and README.md in a steering repo each hold a block
 * between two marker lines that only Oxagen writes, and the `owned` check
 * fails a steering PR that changes one. This writes one commit on the PR's
 * branch. The file keeps every line outside the block, and the block becomes
 * the one the production branch holds, markers and hash included. A file the
 * PR deleted comes back whole, and a removed block goes back at the top. The
 * six checks then run again on the new commit.
 *
 * Refused, with nothing written, when the block at the PR's head already
 * matches the production branch (`block_intact`), when the production branch
 * holds no block in the file (`no_managed_block`), when the repository is not
 * a steering repo (`no_managed_blocks`), and when the PR is not open.
 */
import { z } from "zod";
import { registerCapability } from "../registry";
import { proposalStatusSchema } from "./context.steering.shared";

/** The files that hold a managed block. */
export const MANAGED_BLOCK_PATHS = ["AGENTS.md", "CLAUDE.md", "README.md"] as const;

export const steeringPrRestoreManagedBlock = registerCapability({
  name: "restore_managed_block",
  domain: "context",
  description:
    "Restore the Oxagen managed block in AGENTS.md, CLAUDE.md, or README.md on an open steering PR's branch, as one commit, from the production branch, keeping every line outside the block. Runs the six checks again on the new commit. Refused when the block already matches the production branch.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "cli", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "governance" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      proposalId: z
        .string()
        .regex(/^prp_[0-9A-Za-z]+$/)
        .describe("The proposal whose steering PR holds the file"),
      path: z
        .enum(MANAGED_BLOCK_PATHS)
        .describe("The file whose managed block to restore"),
    })
    .strict(),
  output: z
    .object({
      commit_sha: z.string().describe("The commit that restored the block"),
      status: proposalStatusSchema.describe(
        "Where the checks stopped on that commit",
      ),
    })
    .strict(),
});

export type SteeringPrRestoreManagedBlockInput = z.output<
  typeof steeringPrRestoreManagedBlock.input
>;
export type SteeringPrRestoreManagedBlockOutput = z.output<
  typeof steeringPrRestoreManagedBlock.output
>;
