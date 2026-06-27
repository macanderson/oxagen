import { Hono } from "hono";
import { secretKeyList } from "@oxagen/oxagen/contracts/secret.key.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const secretKeyListRoute = new Hono<AppEnv>();

secretKeyListRoute.post("/", async (c) => {
  const body = secretKeyList.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(secretKeyList.name, body, ctx, { surface: "api" });
  return c.json(out);
});
