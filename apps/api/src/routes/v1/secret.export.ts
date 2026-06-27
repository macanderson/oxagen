import { Hono } from "hono";
import { secretExport } from "@oxagen/oxagen/contracts/secret.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretExportRoute = new Hono<AppEnv>();

secretExportRoute.post("/", async (c) => {
  const body = secretExport.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretExport.name, body, ctx, { surface: "api" });
  return c.json(out);
});
