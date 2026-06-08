import { Hono } from "hono";
import { documentCreate } from "@oxagen/oxagen/contracts/document.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const documentCreateRoute = new Hono<AppEnv>();

documentCreateRoute.post("/", async (c) => {
  const body = documentCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(documentCreate.name, body, ctx, { surface: "api" });
  return c.json(out);
});
