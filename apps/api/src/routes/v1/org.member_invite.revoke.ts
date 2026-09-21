import { Hono } from "hono";
import { revokeMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.revoke";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
export const revokeMemberInviteRoute = new Hono<AppEnv>();
revokeMemberInviteRoute.post("/", async (c) =>
  c.json(
    await invoke(
      revokeMemberInvite.name,
      revokeMemberInvite.input.parse(await c.req.json()),
      capabilityContext(c),
      { surface: "api" },
    ),
  ),
);
