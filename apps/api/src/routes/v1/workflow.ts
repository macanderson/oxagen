import { Hono } from "hono";
import { workflowRun } from "@oxagen/oxagen/contracts/workflow.run";
import { workflowStatus } from "@oxagen/oxagen/contracts/workflow.status";
import { workflowCancel } from "@oxagen/oxagen/contracts/workflow.cancel";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const workflowRoute = new Hono<AppEnv>();

workflowRoute.post("/", async (c) => {
  const body = workflowRun.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(workflowRun.name, body, ctx, { surface: "api" });
  return c.json(out);
});

workflowRoute.get("/:id", async (c) => {
  const body = workflowStatus.input.parse({ workflowId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(workflowStatus.name, body, ctx, { surface: "api" });
  return c.json(out);
});

workflowRoute.delete("/:id", async (c) => {
  const body = workflowCancel.input.parse({ workflowId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(workflowCancel.name, body, ctx, { surface: "api" });
  return c.json(out);
});
