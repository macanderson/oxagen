import { Hono } from "hono";
import { orgMemberAdd } from "@oxagen/oxagen/contracts/org.member.add";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgMemberAddRoute = new Hono<AppEnv>();

orgMemberAddRoute.post("/", async (c) => {
  const body = orgMemberAdd.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(orgMemberAdd.name, body, ctx, { surface: "api" });
  return c.json(result, 201);
});
