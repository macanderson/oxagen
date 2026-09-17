import { Hono } from "hono";
import { mandateList } from "@oxagen/oxagen/contracts/mandate.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const mandateListRoute = new Hono<AppEnv>();

mandateListRoute.post("/", async (c) => {
  const body = mandateList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(mandateList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
