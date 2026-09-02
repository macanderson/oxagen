import { Hono } from "hono";
import { orgMemberInviteDecline } from "@oxagen/oxagen/contracts/org.member_invite.decline";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgMemberInviteDeclineRoute = new Hono<AppEnv>();

orgMemberInviteDeclineRoute.post("/", async (c) => {
  const body = orgMemberInviteDecline.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(orgMemberInviteDecline.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});
