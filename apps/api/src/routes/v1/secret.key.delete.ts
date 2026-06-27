import { Hono } from "hono";
import { secretKeyDelete } from "@oxagen/oxagen/contracts/secret.key.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretKeyDeleteRoute = new Hono<AppEnv>();

secretKeyDeleteRoute.post("/", async (c) => {
  const body = secretKeyDelete.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretKeyDelete.name, body, ctx, { surface: "api" });
  return c.json(out);
});
