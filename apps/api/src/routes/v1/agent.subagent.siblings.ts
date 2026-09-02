import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { isSubagentRunNotFoundError } from "@oxagen/agent";
import { agentSubagentSiblings } from "@oxagen/oxagen/contracts/agent.subagent.siblings";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const agentSubagentSiblingsRoute = new Hono<AppEnv>();

agentSubagentSiblingsRoute.get("/:runId", async (c) => {
  const input = agentSubagentSiblings.input.parse({
    runId: c.req.param("runId"),
  });
  const ctx = capabilityContext(c);
  try {
    const out = await invoke(agentSubagentSiblings.name, input, ctx, {
      surface: "api",
    });
    return c.json(out);
  } catch (err) {
    // Unknown or cross-tenant runId is a clean 404, never a 500 — matched
    // structurally (typed error), not via a brittle message regex.
    if (isSubagentRunNotFoundError(err)) {
      throw new HTTPException(404, {
        message: `Subagent run not found: ${input.runId}`,
      });
    }
    throw err;
  }
});
