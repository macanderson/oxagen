import { Hono } from "hono";
import { privacyDataErase } from "@oxagen/oxagen/contracts/privacy.data.erase";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const privacyDataEraseRoute = new Hono<AppEnv>();

privacyDataEraseRoute.post("/", async (c) => {
  const body = privacyDataErase.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const result = await invoke(privacyDataErase.name, body, ctx, {
    surface: "api",
  });
  return c.json(result, 202);
});
