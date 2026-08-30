import { Hono } from "hono";
import { pluginSchemaGet } from "@oxagen/oxagen/contracts/plugin.schema.get";
import { pluginSchemaValidate } from "@oxagen/oxagen/contracts/plugin.schema.validate";
import { pluginVersionList } from "@oxagen/oxagen/contracts/plugin.version.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const pluginSchemaRoute = new Hono<AppEnv>();

// GET /plugin-schema/:pluginId — fetch the typed config schema for a connector plugin
pluginSchemaRoute.get("/:pluginId", async (c) => {
  const body = pluginSchemaGet.input.parse({
    pluginId: c.req.param("pluginId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSchemaGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /plugin-schema/:pluginId/validate — validate config against schema before install
pluginSchemaRoute.post("/:pluginId/validate", async (c) => {
  // Path param LAST: the URL identifies the plugin, so a `pluginId` in the body
  // must never validate against a different schema than the one addressed.
  const body = pluginSchemaValidate.input.parse({
    ...((await c.req.json()) as Record<string, unknown>),
    pluginId: c.req.param("pluginId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(pluginSchemaValidate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

export const pluginVersionRoute = new Hono<AppEnv>();

// GET /plugin-versions/:pluginId — list version history for a connector plugin
pluginVersionRoute.get("/:pluginId", async (c) => {
  const query = c.req.query();
  const body = pluginVersionList.input.parse({
    pluginId: c.req.param("pluginId"),
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    includeChangelog: query.includeChangelog === "true",
  });
  const ctx = capabilityContext(c);
  const out = await invoke(pluginVersionList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});
