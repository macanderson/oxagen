import { Hono } from "hono";
import { resendMemberInvite } from "@oxagen/oxagen/contracts/org.member_invite.resend";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
export const resendMemberInviteRoute = new Hono<AppEnv>();
resendMemberInviteRoute.post("/", async (c) =>
  c.json(
    await invoke(
      resendMemberInvite.name,
      resendMemberInvite.input.parse(await c.req.json()),
      capabilityContext(c),
      { surface: "api" },
    ),
  ),
);
