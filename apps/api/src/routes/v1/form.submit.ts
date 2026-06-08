import { Hono } from "hono";
import { formSubmit } from "@oxagen/oxagen/contracts/form.submit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const formSubmitRoute = new Hono<AppEnv>();

formSubmitRoute.post("/", async (c) => {
  const body = formSubmit.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(formSubmit.name, body, ctx, { surface: "api" });
  return c.json(out);
});
