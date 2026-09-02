import { Hono } from "hono";
import { orgMemberInviteAccept } from "@oxagen/oxagen/contracts/org.member_invite.accept";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const orgMemberInviteAcceptRoute = new Hono<AppEnv>();

orgMemberInviteAcceptRoute.post("/", async (c) => {
  const body = orgMemberInviteAccept.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(orgMemberInviteAccept.name, body, ctx, {
    surface: "api",
  });
  return c.json(result);
});
