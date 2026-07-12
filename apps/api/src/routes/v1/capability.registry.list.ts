import { Hono } from "hono";
import { capabilityRegistryList } from "@oxagen/oxagen/contracts/capability.registry.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const capabilityRegistryListRoute = new Hono<AppEnv>();

capabilityRegistryListRoute.get("/", async (c) => {
  const q = c.req.query();
  const input = capabilityRegistryList.input.parse({
    ...(q["domain"] ? { domain: q["domain"] } : {}),
    ...(q["q"] ? { q: q["q"] } : {}),
    ...(q["surface"] ? { surface: q["surface"] } : {}),
    ...(q["missingLayer"] ? { missingLayer: q["missingLayer"] } : {}),
    ...(q["sensitivity"] ? { sensitivity: q["sensitivity"] } : {}),
    ...(q["limit"] ? { limit: Number(q["limit"]) } : {}),
    ...(q["offset"] ? { offset: Number(q["offset"]) } : {}),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(capabilityRegistryList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
