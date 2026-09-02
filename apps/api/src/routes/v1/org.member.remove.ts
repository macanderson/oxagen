import { Hono } from "hono";
import { orgMemberRemove } from "@oxagen/oxagen/contracts/org.member.remove";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgMemberRemoveRoute = new Hono<AppEnv>();

orgMemberRemoveRoute.delete("/", async (c) => {
  const body = orgMemberRemove.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(orgMemberRemove.name, body, ctx, {
    surface: "api",
  });
  return c.json(result, 200);
});
