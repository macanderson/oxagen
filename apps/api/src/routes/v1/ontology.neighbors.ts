import { Hono } from "hono";
import { ontologyNeighbors } from "@oxagen/oxagen/contracts/ontology.neighbors";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const ontologyNeighborsRoute = new Hono<AppEnv>();

ontologyNeighborsRoute.post("/", async (c) => {
  const body = ontologyNeighbors.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(ontologyNeighbors.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
