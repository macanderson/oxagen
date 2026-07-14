import { Hono } from "hono";
import { capabilityRegistryGet } from "@oxagen/oxagen/contracts/capability.registry.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const capabilityRegistryGetRoute = new Hono<AppEnv>();

capabilityRegistryGetRoute.get("/", async (c) => {
  const input = capabilityRegistryGet.input.parse({
    name: c.req.query("name"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(capabilityRegistryGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
