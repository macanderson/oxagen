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
