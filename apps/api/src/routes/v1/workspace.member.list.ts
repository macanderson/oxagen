import { Hono } from "hono";
import { listMembers } from "@oxagen/oxagen/contracts/workspace.member.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const listMembersRoute = new Hono<AppEnv>();

// GET /workspace/member/list?scope=org|workspace. No scope lists the members
// of the workspace the API key is scoped to, which is what this route has
// always answered.
listMembersRoute.get("/", async (c) => {
  const input = listMembers.input.parse({ scope: c.req.query("scope") });
  const ctx = capabilityContext(c);
  const out = await invoke(listMembers.name, input, ctx, { surface: "api" });
  return c.json(out);
});
