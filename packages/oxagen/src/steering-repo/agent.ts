// agent.ts: `agent/v1`, one file per agent in agents/ (steering-repo-spec,
// Agents). An agent is an operator, a runtime, and a harness. Cedar reads the
// file as the principal `Agent`, and nothing in it reaches a model.
//
// Identity and credentials stay in Oxagen. The file names the runtime and
// carries no secret. `toolbelt`, `budget`, and `environment` wait until
// customers ask (decided 2026-09-26), so the schema refuses them today.
import { z } from "zod";
import { agentHarnessSchema } from "../contracts/agent.list";
import { runtimeSlugSchema } from "../contracts/runtime.shared";
import { actorSchema, lineageSchema } from "./common";
import { schemaDirective } from "./schema-ids";

export const agentSchema = z
  .object({
    schema: z.literal("agent/v1"),
    name: lineageSchema.describe(
      "The agent's name and the file's name: agents/<name>.toml.",
    ),
    label: z.string().min(1).max(80),
    operator: actorSchema.describe("An Oxagen member or team."),
    runtime: runtimeSlugSchema.describe("A runtime enrolled in Oxagen."),
    harness: agentHarnessSchema.describe(
      "The harness, or the framework adapter, the agent runs in.",
    ),
  })
  .strict();
export type AgentFile = z.output<typeof agentSchema>;

/**
 * The name Oxagen gives the agent file it writes for an enrolled runtime
 * (#5149, ADR-265): the runtime's slug, so `agents/<slug>.toml` names the
 * runtime it serves. Null when the slug is not a valid agent name, which
 * `lineageSchema` decides.
 */
export function agentNameForRuntime(runtimeSlug: string): string | null {
  return lineageSchema.safeParse(runtimeSlug).success ? runtimeSlug : null;
}

/**
 * An agent/v1 file's text: the schema line, then one key per line in the
 * schema's order. The fields are checked against `agentSchema` first, so a
 * file that would not read back is never written. Throws a ZodError then.
 */
export function agentFileText(agent: AgentFile): string {
  const fields = agentSchema.parse(agent);
  return [
    schemaDirective("agent/v1"),
    ...(["schema", "name", "label", "operator", "runtime", "harness"] as const).map(
      (key) => `${key} = ${JSON.stringify(fields[key])}`,
    ),
    "",
  ].join("\n");
}
