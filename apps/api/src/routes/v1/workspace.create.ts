import { Hono } from "hono";
import { workspaceCreate } from "@oxagen/oxagen/contracts/workspace.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workspaceCreateRoute = new Hono<AppEnv>();

workspaceCreateRoute.post("/", async (c) => {
  const body = workspaceCreate.input.parse(await c.req.json());
  // An org, but not a workspace: this route is mounted org-scoped as well, so a
  // caller with no workspace yet can ask for their first one (#1203).
  const ctx = capabilityContext(c, { requireWorkspace: false });
  const out = await invoke(workspaceCreate.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
