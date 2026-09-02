import { Hono } from "hono";
import { workspaceInviteSend } from "@oxagen/oxagen/contracts/workspace.invite.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceInviteSendRoute = new Hono<AppEnv>();

workspaceInviteSendRoute.post("/", async (c) => {
  const body = workspaceInviteSend.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceInviteSend.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
