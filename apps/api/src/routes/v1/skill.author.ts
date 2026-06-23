import { Hono } from "hono";
import { skillAuthor } from "@oxagen/oxagen/contracts/skill.author";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const skillAuthorRoute = new Hono<AppEnv>();

skillAuthorRoute.post("/", async (c) => {
  const input = skillAuthor.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(skillAuthor.name, input, ctx, { surface: "api" });
  return c.json(out);
});
