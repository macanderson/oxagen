import { Hono } from "hono";
import { formCreate } from "@oxagen/oxagen/contracts/form.create";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const formCreateRoute = new Hono<AppEnv>();

formCreateRoute.post("/", async (c) => {
  const body = formCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(formCreate.name, body, ctx, { surface: "api" });
  return c.json(out);
});
