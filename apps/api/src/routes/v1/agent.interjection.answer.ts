import { Hono } from "hono";
import { agentInterjectionAnswer } from "@oxagen/oxagen/contracts/agent.interjection.answer";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** A person answers the question an agent paused its run to ask (#3839). */
export const agentInterjectionAnswerRoute = new Hono<AppEnv>();

agentInterjectionAnswerRoute.post("/", async (c) => {
  const body = agentInterjectionAnswer.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(agentInterjectionAnswer.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
