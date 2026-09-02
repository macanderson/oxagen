import { Hono } from "hono";
import { chatMessageExecution } from "@oxagen/oxagen/contracts/chat.message.execution";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const chatMessageExecutionRoute = new Hono<AppEnv>();

chatMessageExecutionRoute.post("/", async (c) => {
  const body = chatMessageExecution.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(chatMessageExecution.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
