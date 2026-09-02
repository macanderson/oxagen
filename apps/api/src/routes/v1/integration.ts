import { Hono } from "hono";
import { integrationInstall } from "@oxagen/oxagen/contracts/integration.install";
import { integrationConfigure } from "@oxagen/oxagen/contracts/integration.configure";
import { integrationList } from "@oxagen/oxagen/contracts/integration.list";
import { integrationGet } from "@oxagen/oxagen/contracts/integration.get";
import { integrationSync } from "@oxagen/oxagen/contracts/integration.sync";
import { integrationMetrics } from "@oxagen/oxagen/contracts/integration.metrics";
import { integrationDelete } from "@oxagen/oxagen/contracts/integration.delete";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const integrationRoute = new Hono<AppEnv>();

// POST /integrations — install a plugin instance
integrationRoute.post("/", async (c) => {
  const body = integrationInstall.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(integrationInstall.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});

// GET /integrations — list installed plugin instances
integrationRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = integrationList.input.parse({
    status: query.status,
    pluginId: query.pluginId,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationList.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// GET /integrations/:id — get full details of a plugin instance
integrationRoute.get("/:id", async (c) => {
  const body = integrationGet.input.parse({ integrationId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// PATCH /integrations/:id/configure — update plugin instance config
integrationRoute.patch("/:id/configure", async (c) => {
  // Path param LAST: the URL identifies the resource, so an `integrationId` in
  // the body must never redirect the write to a different integration.
  const body = integrationConfigure.input.parse({
    ...((await c.req.json()) as Record<string, unknown>),
    integrationId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationConfigure.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /integrations/:id/sync — trigger synchronization
integrationRoute.post("/:id/sync", async (c) => {
  // Path param LAST — see the note on /:id/configure above.
  const body = integrationSync.input.parse({
    ...((await c.req.json()) as Record<string, unknown>),
    integrationId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationSync.name, body, ctx, { surface: "api" });
  return c.json(out, 202);
});

// GET /integrations/:id/metrics — sync statistics and metrics
integrationRoute.get("/:id/metrics", async (c) => {
  const body = integrationMetrics.input.parse({
    integrationId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationMetrics.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// DELETE /integrations/:id — remove plugin instance
integrationRoute.delete("/:id", async (c) => {
  const query = c.req.query();
  const body = integrationDelete.input.parse({
    integrationId: c.req.param("id"),
    purgeData: query.purgeData === "true",
  });
  const ctx = capabilityContext(c);
  const out = await invoke(integrationDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});
