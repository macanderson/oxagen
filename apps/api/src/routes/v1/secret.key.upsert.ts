import { Hono } from "hono";
import { secretKeyUpsert } from "@oxagen/oxagen/contracts/secret.key.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretKeyUpsertRoute = new Hono<AppEnv>();

secretKeyUpsertRoute.post("/", async (c) => {
  const body = secretKeyUpsert.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretKeyUpsert.name, body, ctx, { surface: "api" });
  return c.json(out);
});
