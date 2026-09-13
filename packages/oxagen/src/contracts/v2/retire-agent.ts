import { z } from "zod";
import { defineTool } from "./_define";
import { agentDefinitionDelete } from "../agent.definition.delete";
import { contextPrSchema } from "./register-agent";

/**
 * Appendix E: `retire_agent` — "a Context PR removing the file; principal
 * retired, never deleted". Absorbs `delete_agent_def`.
 *
 * The rename is the carry. v1 called this a delete, and its own header already
 * explained that nothing was deleted: the agent row was soft-deleted, its
 * delegated `iam.principals` row soft-deleted with it, and both retained for
 * audit because hard deletes are prohibited on org-scoped tables. §6.2 makes
 * the same rule explicit and gives it the right word — "The principal is
 * retired, never deleted, so its runs keep their identity."
 *
 * A tool named `delete` that returns `deleted: true` teaches every caller the
 * wrong model of the system. The v2 name and the v2 output both say what
 * happens, which is why the one field this drops is `deleted`.
 *
 * The mechanism follows `register_agent` and `update_agent`: the definition is
 * a file, so removing it is a pull request, and merge is what retires the
 * principal.
 */
export const retireAgent = defineTool({
  name: "retire_agent",
  domain: "agent",
  description:
    "Retire an agent by opening a Context PR that removes .oxagen/agents/<slug>.toml and its generated harness files. On merge the delegated IAM principal is retired — never deleted — so past runs keep their identity, and the agent stops appearing in listings and can no longer run.",
  mode: "sync",
  surfaces: ["api", "mcp", "cli", "agent"],
  layers: ["schema", "api", "mcp", "unit", "e2e", "docs"],
  scoped: true,

  absorbs: ["delete_agent_def"],
  drops: [
    {
      field: "deleted",
      from: "delete_agent_def",
      why: "nothing is ever deleted (§6.2, and v1's own soft-delete behaviour), so a boolean named `deleted` could only ever report a state the system does not have. Replaced by `principalStatus: \"retired\"`, which is the value Appendix A's iam.principals.status actually takes",
    },
  ],

  // Carried unchanged, and the strictest posture of the three agent-definition
  // write tools: `sensitivity: "destructive"` is right even though the rows
  // survive, because an agent that stops running is a capability the
  // organization loses until someone reverses the PR.
  agent: { requiresApproval: true, riskLevel: "high", category: "mutation" },
  sensitivity: "destructive",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  mutates: true,

  input: z.object({
    // Carried with its `.describe()`: public id (agt_…) or UUID.
    agentId: agentDefinitionDelete.input.shape.agentId,
  }),

  output: z.object({
    agentId: agentDefinitionDelete.output.shape.agentId,

    /** The pull request that removes the file (§10.3). */
    contextPr: contextPrSchema,

    /**
     * The file the PR removes. Returned so a reviewer opening the request can
     * confirm it is the agent they meant before the merge retires a principal
     * that runs in production.
     */
    definitionPath: z.string(),
    /** The generated harness files removed alongside it; empty for Stella. */
    generatedFiles: z.array(z.string()),

    /**
     * Appendix A `iam.principals.status`. Still `active` when this call
     * returns — retirement happens at merge — which is exactly why the field
     * exists: a caller must be able to see that nothing has changed yet.
     */
    principalStatus: z.enum(["unenrolled", "active", "suspended", "retired"]),
  }),
});

export type RetireAgentInput = z.output<typeof retireAgent.input>;
export type RetireAgentOutput = z.output<typeof retireAgent.output>;
