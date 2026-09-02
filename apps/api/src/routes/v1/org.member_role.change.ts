import { Hono } from "hono";
import { orgMemberRoleChange } from "@oxagen/oxagen/contracts/org.member_role.change";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgMemberRoleChangeRoute = new Hono<AppEnv>();

orgMemberRoleChangeRoute.patch("/", async (c) => {
  const body = orgMemberRoleChange.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(orgMemberRoleChange.name, body, ctx, {
    surface: "api",
  });
  return c.json(result, 200);
});
