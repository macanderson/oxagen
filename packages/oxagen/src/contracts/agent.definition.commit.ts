// commit_agent_definition — write an agent's definition of record to the
// workspace repository and open the pull request that publishes it (MC spec
// §6.2 "Identity in Postgres, definition in git", §10.2; ADR-057 decision 1;
// #2956).
//
// The definition is the file `.oxagen/agents/<slug>.toml`. This capability
// commits the text the caller supplies to a branch that is never the
// repository's default branch, opens a pull request against the default
// branch (or reuses the branch's open one, so a redraft lands on the pull
// request under review), and caches the commit on a new `agent.agent_versions`
// row (path, digest, source, commit, branch, pull request). The running
// definition stays what the default branch holds until a person merges the
// pull request.
//
// For an agent whose harness reads a subagent file (Claude Code, Cursor and
// Stella), the same commit run also writes `.claude/agents/<slug>.md`,
// regenerated from the definition by the generator `propose_agent` uses, so
// the harness loads the edited instructions after merge (#3501). Codex and
// the other harnesses read no subagent file, and only the definition is
// written for them.
//
// The handler refuses a file whose `schema` is not `agent-definition/v0.1`
// or whose `slug` is not the agent's, and a branch that is the default
// branch. The delegation ceiling (spec §6.2: an operator can grant no more
// than they hold) is enforced on the `tools` the file names for an
// enterprise organization, the same check `assign_agent_role` runs; below
// enterprise the kernel's IAM allows every capability to every member, so
// the ceiling is vacuous there (packages/iam/src/check-iam.ts).
//
// A definition write, outside the metering surface: `noBillingGate: true`.
// Roles: org Owner, Admin or Member, checked by the handler (INV-29).
import { z } from "zod";
import { registerCapability } from "../registry";

export const AGENT_DEFINITION_SCHEMA = "agent-definition/v0.1";
export const AGENT_DEFINITION_DIR = ".oxagen/agents";

/**
 * A short git branch name: word characters, dots, slashes and hyphens; no
 * `..`, `//`, trailing `/` or `.lock`, and no `refs/` or `heads/` qualifier.
 * GitHub resolves `refs/heads/main` to `main`, so a qualified name would pass
 * the handler's string comparison with the default branch and write it.
 */
export const branchNameSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(
    /^(?!refs\/|heads\/)(?!.*(\.\.|\/\/|\/$|\.lock$))[A-Za-z0-9][A-Za-z0-9._/-]*$/,
    "a git branch name",
  );

export const agentDefinitionCommit = registerCapability({
  name: "commit_agent_definition",
  domain: "agent",
  description:
    "Commit an agent's definition file (.oxagen/agents/<slug>.toml) and, for a Claude Code, Cursor, or Stella agent, the subagent file generated from it to a branch of the workspace repository, then open the pull request that publishes them or add to the branch's open pull request. The default branch is never written.",
  mode: "sync",
  // The handler acts as the signed-in user or the API key's creator
  // (resolveActingUserId, assertOrgRole, INV-29). The write ships on the API
  // alone: no MCP tool is built for it.
  surfaces: ["api"],
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: true, riskLevel: "medium", category: "identity" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /** Agent public id (`agt_…`) or slug. */
      agentId: z.string().min(1).max(128),
      /**
       * The repository binding (`rpb_…`) to commit to. Optional when the
       * workspace binds exactly one repository.
       */
      repositoryId: z
        .string()
        .regex(/^rpb_[0-9a-z]+$/)
        .optional(),
      /** The branch to write; created from the default branch when absent. */
      branch: branchNameSchema,
      /** The file text: `schema = "agent-definition/v0.1"`, `slug = "<agent slug>"`, and the rest of MC spec §6.2. */
      source: z
        .string()
        .min(1)
        .max(64 * 1024),
      /** The commit and pull request title. */
      message: z.string().min(1).max(200).optional(),
    })
    .strict(),
  output: z
    .object({
      agentId: z.string().regex(/^agt_[0-9a-z]+$/),
      /** The `agent_versions.version` row that cached the commit. */
      version: z.number().int().positive(),
      path: z.string().min(1),
      /**
       * The subagent file regenerated from the definition on the same branch:
       * `.claude/agents/<slug>.md` for a Claude Code, Cursor or Stella agent.
       * Null for Codex and every other harness, which read no subagent file,
       * so only the definition is written.
       */
      generatedPath: z.string().min(1).nullable(),
      /** sha256 hex of `source`. */
      digest: z.string().regex(/^[0-9a-f]{64}$/),
      commitSha: z.string().min(1),
      branch: z.string().min(1),
      /** The branch's open pull request against the default branch: opened by this call, or the one already under review. */
      pullRequest: z
        .object({
          number: z.number().int().positive(),
          url: z.string().url(),
        })
        .strict(),
    })
    .strict(),
});

export type AgentDefinitionCommitInput = z.output<
  typeof agentDefinitionCommit.input
>;
export type AgentDefinitionCommitOutput = z.output<
  typeof agentDefinitionCommit.output
>;
