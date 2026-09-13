import { z } from "zod";
import { defineTool } from "./_define";
import { agentDefinitionCreate } from "../agent.definition.create";
import { agentDefinitionSuggest } from "../agent.definition.suggest";
import { agentDefinitionSummarize } from "../agent.definition.summarize";

/**
 * Appendix E: `register_agent` — "opens a Context PR adding
 * `.oxagen/agents/<slug>.toml` and the generated harness files; identity is
 * created on merge". Absorbs `create_agent_def`, `suggest_agent_def` and
 * `summarize_agent_def`.
 *
 * This is the tool whose MEANING changes most in the carry, and the change is
 * §6.2's: "Creating or changing an agent in Mission Control does not write
 * Postgres first. It opens a Context PR." An agent has two halves — identity in
 * Postgres (principal, credentials, roles: the things that must be revocable in
 * one second) and definition in git (`.oxagen/agents/<slug>.toml`, the source
 * of truth for what the agent is for). This tool writes the git half only. The
 * Postgres half is created by the merge.
 *
 * That single sentence is what most of `drops` is about: every id the three v1
 * contracts returned describes a row that does not exist yet when this call
 * returns.
 *
 * Folding `suggest_agent_def` in is the same move seen from the other side. v1
 * kept drafting separate because "nothing is persisted; the caller reviews,
 * edits, and saves the draft explicitly" — the review step needed somewhere to
 * live. In v2 it has one: the pull request. So a caller may hand over a finished
 * `config`, or hand over a sentence and let the model draft it; either way what
 * comes back is a PR a human reads before anything is real.
 */

/**
 * The pull request a Context PR tool returns (§10.3). Shared with
 * `update_agent` and `retire_agent`, which produce the same object for the same
 * reason. Written fresh — no v1 contract returned a PR, because no v1 contract
 * opened one.
 */
export const contextPrSchema = z.object({
  url: z.string().url().describe("The pull request on the workspace's main repo"),
  number: z.number().int().positive(),
  branch: z
    .string()
    .describe("The branch the record was authored on (§10.3 step 1)"),
  headSha: z.string().describe("Commit the definition file was written at"),
  checksUrl: z
    .string()
    .url()
    .nullable()
    .describe(
      "The Oxagen check-run link carried in the PR body (§10.3 step 2); null until the first check run reports",
    ),
  /**
   * §10.3 review rules depend on the workspace's governance mode, so a PR may
   * be mergeable by its author (`solo`) or waiting on a named approver
   * (`regulated`). `open` is the only state this call can return, but the field
   * is an enum because the same schema describes the PR on later reads.
   */
  state: z.enum(["open", "merged", "closed"]),
});

const createInput = agentDefinitionCreate.input.shape;

export const registerAgentInputObject = z.object({
  /**
   * Carried by reference, and the single most important carry in this file: the
   * 18-character cap exists so the global agent key `org_ns.workspace_ns.slug`
   * (≤6 + ≤6 namespaces) never exceeds 32 characters, and the message says so.
   * §6.2/ADR-024 make the agent key immutable, which makes that cap permanent.
   *
   * Optional only on the drafting path, where the model derives one — see the
   * refinement below. It is also the file name: `.oxagen/agents/<slug>.toml`.
   */
  slug: createInput.slug.optional(),
  name: createInput.name.optional(),
  description: createInput.description,
  agentType: createInput.agentType,
  avatarUrl: createInput.avatarUrl,

  /**
   * The versioned body: graph access, equipped tools, instructions. Carried
   * whole from `create_agent_def`, which mirrors `agentDefinitionConfigSchema`
   * so the contract and the persisted shape cannot drift. Optional here because
   * `draftFrom` is the other way to arrive at one.
   */
  config: createInput.config.optional(),

  /**
   * The drafting path, carried from `suggest_agent_def`'s `description` field
   * with its 10–4000 bounds intact. Supply this instead of `config` and the
   * model designs the definition, grounded in the workspace's real ontologies,
   * MCP servers and governed capabilities, then writes it into the PR.
   */
  draftFrom: agentDefinitionSuggest.input.shape.description.optional(),

  /**
   * New, and required: §6.2 gives every agent a `harness`, Appendix A stores it
   * on `iam.principals`, and it decides WHICH generated files the PR carries
   * beside the canonical TOML (`.claude/agents/<slug>.md`, the Codex
   * equivalent, or none at all for Stella, which symlinks `.stella/agents` to
   * `.oxagen/agents`). There is no safe default: generating the wrong harness
   * file means the operator opens their coding agent and the agent is not there.
   */
  harness: z.enum([
    "stella",
    "claude-code",
    "codex-cli",
    "openai-agents-sdk",
    "claude-agent-sdk",
    "custom",
  ]),
});

const registerAgentInput = registerAgentInputObject.superRefine(
  (value, ctx) => {
    if (value.draftFrom !== undefined) return;
    // Without a brief to draft from, the definition must arrive complete: this
    // call's product is a file, and a file cannot be half-written.
    for (const field of ["slug", "name", "config"] as const) {
      if (value[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `${field} is required unless \`draftFrom\` is supplied — without a plain-language brief there is nothing to derive the definition from`,
        });
      }
    }
  },
);

export const registerAgent = defineTool({
  name: "register_agent",
  domain: "agent",
  description:
    "Register an agent by opening a Context PR on the workspace's main repo that adds .oxagen/agents/<slug>.toml and the generated harness files. Supply a full config, or a plain-language brief for the model to draft one. The agent's identity, roles and toolbelt are created when the PR merges (§6.2).",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["create_agent_def", "suggest_agent_def", "summarize_agent_def"],
  drops: [
    {
      field: "agentId",
      from: "create_agent_def",
      why: "§6.2: identity is created on merge. When this call returns, no agent row and no principal exist — returning an id would name a row nothing can read",
    },
    {
      field: "publicId",
      from: "create_agent_def",
      why: "same as agentId: minted with the principal at merge time",
    },
    {
      field: "version",
      from: "create_agent_def",
      why: "§6.2 replaces agent_versions with git: the version of a definition is the commit it was merged at, recorded as `definition_digest` on iam.principals. `headSha` and `definitionDigest` below are what v1's v1-snapshot number became",
    },
    {
      field: "nameHint",
      from: "suggest_agent_def",
      why: "folded into the optional `slug`: on the drafting path it IS the hint (the model derives one when absent), and on the explicit path it is the exact slug. Two fields meaning the same thing at different times is how they disagree",
    },
    {
      field: "suggestion",
      from: "suggest_agent_def",
      why: "the drafted definition is not returned for the caller to re-submit; it is written into the PR's file, which is the review surface §6.2 gives it. The rationale, warnings and recommendations that explained it DO carry, because they go in the PR body",
    },
    {
      field: "agentId",
      from: "summarize_agent_def",
      why: "a summary is generated FOR the definition being registered, before any agent exists to address by id",
    },
    {
      field: "force",
      from: "summarize_agent_def",
      why: "the flag only means 'regenerate despite a checksum match'; at registration there is no cached summary to match against",
    },
    {
      field: "checksum",
      from: "summarize_agent_def",
      why: "a SHA-256 over the version config, used to detect a stale cached summary. Superseded by `definitionDigest` — §6.2 makes the digest of the file at the merged commit the one fingerprint runs record as the agent's version, and a second fingerprint of the same content is a second thing to keep in sync",
    },
  ],

  /**
   * Sources: create (medium/medium), suggest (medium/low), summarize
   * (low/low), all three `requiresApproval: false`. Strictest carried for
   * sensitivity and riskLevel.
   *
   * `requiresApproval` stays false, which reads surprising for a tool that
   * writes to the customer's main repo, so: the approval that governs this is
   * the pull request itself. §10.3 step 3 routes review by the workspace's
   * governance mode — author-merge in `solo`, a code-owner in `team`, a named
   * approver recorded as accountable in `regulated`. An agent-surface prompt on
   * TOP of that would ask a human to approve opening a request for approval.
   */
  agent: { requiresApproval: false, riskLevel: "medium", category: "mutation" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    // Identical across all three sources.
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  // Opens a branch and a pull request on GitHub — an external side effect, and
  // the reason this is a mutation even though it writes no Oxagen row.
  mutates: true,

  input: registerAgentInput,

  output: z.object({
    /** What this call actually produced. Everything else describes it. */
    contextPr: contextPrSchema,

    // Carried from `create_agent_def`: the slug is the file name, so it is the
    // one identifier that exists before the merge.
    slug: agentDefinitionCreate.output.shape.slug,

    /**
     * §6.2 / Appendix A `iam.principals.definition_path` and
     * `definition_digest`. The path is `.oxagen/agents/<slug>.toml`; the digest
     * fingerprints the file at `contextPr.headSha`. Together they are how the
     * identity half finds the definition half at merge, and how a later run
     * records which version of the agent it was.
     */
    definitionPath: z.string(),
    definitionDigest: z.string(),

    /**
     * The harness files generated beside the canonical one (§6.2). Empty for
     * Stella, which symlinks rather than generates. Listed rather than counted
     * because a reviewer opening the PR needs to know which files are marked
     * generated and must not be hand-edited.
     */
    generatedFiles: z.array(z.string()),

    /**
     * Carried from `summarize_agent_def`: the plain-text ≤256-character line
     * describing what the agent does. Written into the definition rather than
     * cached against a checksum, so it lands in the same commit it describes.
     */
    summary: agentDefinitionSummarize.output.shape.summary,

    // ---- the drafting explanation (suggest_agent_def), carried whole -------
    /**
     * Null when the caller supplied `config` — there is no model reasoning to
     * report about a definition the caller wrote. Populated on the `draftFrom`
     * path and mirrored into the PR body.
     */
    rationale: agentDefinitionSuggest.output.shape.rationale.nullable(),
    warnings: agentDefinitionSuggest.output.shape.warnings,
    recommendations: agentDefinitionSuggest.output.shape.recommendations,
    /**
     * Carried with its full advisory framing intact: a pre-selection for a
     * human-reviewable picker, derived deterministically from the drafted
     * config rather than from model output. `set_agent_role` remains the sole
     * authority on delegation ceiling, tier gate and assignability, and §6.2
     * makes merge the moment "the roles the definition asks for" are created.
     */
    suggestedRole: agentDefinitionSuggest.output.shape.suggestedRole,
  }),
});

export type RegisterAgentInput = z.output<typeof registerAgent.input>;
export type RegisterAgentOutput = z.output<typeof registerAgent.output>;
