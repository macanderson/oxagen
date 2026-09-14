import { Hono } from "hono";
import { workspaceMemberList } from "@oxagen/oxagen/contracts/workspace.member.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceMemberListRoute = new Hono<AppEnv>();

workspaceMemberListRoute.get("/", async (c) => {
  const workspace_id = c.req.query("workspace_id");
  const input = workspaceMemberList.input.parse({ workspace_id });
  const ctx = capabilityContext(c);
  const out = await invoke(workspaceMemberList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
