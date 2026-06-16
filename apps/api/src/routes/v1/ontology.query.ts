import { Hono } from "hono";
import { ontologyQuery } from "@oxagen/oxagen/contracts/ontology.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const ontologyQueryRoute = new Hono<AppEnv>();

ontologyQueryRoute.post("/", async (c) => {
  const body = ontologyQuery.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(ontologyQuery.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
