import { Hono } from "hono";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { connectionCreate } from "@oxagen/oxagen/contracts/connection.create";
import { connectionGet } from "@oxagen/oxagen/contracts/connection.get";
import { connectionDelete } from "@oxagen/oxagen/contracts/connection.delete";
import { connectionPreview } from "@oxagen/oxagen/contracts/connection.preview";
import { connectionMappingsSuggest } from "@oxagen/oxagen/contracts/connection.mappings.suggest";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { connectionMappingsSet } from "@oxagen/oxagen/contracts/connection.mappings.set";
import { connectionUpdate } from "@oxagen/oxagen/contracts/connection.update";
import { connectionPause } from "@oxagen/oxagen/contracts/connection.pause";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";
import { schema, withTenantDb } from "@oxagen/database";
import { runInTenantScope } from "@oxagen/tenancy";
import { eq, and, isNull } from "drizzle-orm";
import { eventClient } from "../../event-client";

export const connectionRoute = new Hono<AppEnv>();

// GET /connections — list connections for workspace
connectionRoute.get("/", async (c) => {
  const body = connectionList.input.parse({
    status: c.req.query("status"),
    connectorId: c.req.query("connectorId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionList.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /connections — create new connection
connectionRoute.post("/", async (c) => {
  const body = connectionCreate.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(connectionCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

// GET /connections/:id — get connection details
connectionRoute.get("/:id", async (c) => {
  const body = connectionGet.input.parse({ connectionId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// DELETE /connections/:id — delete connection (mode query param)
connectionRoute.delete("/:id", async (c) => {
  const body = connectionDelete.input.parse({
    connectionId: c.req.param("id"),
    mode: c.req.query("mode") ?? "full",
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// GET /connections/:id/preview — preview sample records
connectionRoute.get("/:id/preview", async (c) => {
  const body = connectionPreview.input.parse({
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionPreview.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /connections/:id/suggest-mappings — LLM-suggested entity type mappings
connectionRoute.post("/:id/suggest-mappings", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  // Path param LAST: the URL identifies the connection, so a `connectionId` in
  // the body must never redirect the call to a different connection.
  const body = connectionMappingsSuggest.input.parse({
    ...json,
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionMappingsSuggest.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// GET /connections/:id/mappings — get current entity type mappings
connectionRoute.get("/:id/mappings", async (c) => {
  const body = connectionMappingsGet.input.parse({
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionMappingsGet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// PUT /connections/:id/mappings — save confirmed entity type mappings
connectionRoute.put("/:id/mappings", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  // Path param LAST — see the note on /:id/suggest-mappings above.
  const body = connectionMappingsSet.input.parse({
    ...json,
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionMappingsSet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /connections/:id/resync — queue a fresh initial sync for an existing connection
connectionRoute.post("/:id/resync", async (c) => {
  const publicId = c.req.param("id");
  const ctx = capabilityContext(c);

  // Verify connection belongs to this org/workspace and is not deleted.
  // This route calls withTenantDb DIRECTLY (it doesn't go through invoke(),
  // which is what establishes the ALS tenant scope), so we must enter the scope
  // here — exactly like chat.stream.ts / github-oauth.ts do — or withTenantDb's
  // requireScope() throws TenantScopeError and the resync 500s.
  const [conn] = await runInTenantScope(
    { orgId: ctx.orgId, workspaceId: ctx.workspaceId },
    () =>
      withTenantDb((tx) =>
        tx
          .select({
            id: schema.sourceConnections.id,
            orgId: schema.sourceConnections.orgId,
            workspaceId: schema.sourceConnections.workspaceId,
            connectorId: schema.sourceConnections.connectorId,
            status: schema.sourceConnections.status,
            deliveryConfig: schema.sourceConnections.deliveryConfig,
          })
          .from(schema.sourceConnections)
          .where(
            and(
              eq(schema.sourceConnections.publicId, publicId),
              eq(schema.sourceConnections.orgId, ctx.orgId),
              eq(schema.sourceConnections.workspaceId, ctx.workspaceId),
              isNull(schema.sourceConnections.deletedAt),
            ),
          )
          .limit(1),
      ),
  );

  if (!conn) {
    return c.json({ error: "Not found" }, 404);
  }

  // Fire initial sync event — the Inngest function handles retry/dedup.
  const deliveryConfig = conn.deliveryConfig as Record<string, unknown> | null;
  await eventClient.send({
    name: "ingestion/github.initial-sync",
    data: {
      connectionId: conn.id,
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      owner: (deliveryConfig?.owner as string | undefined) ?? "",
      repo: (deliveryConfig?.repo as string | undefined) ?? "",
      defaultBranch:
        (deliveryConfig?.defaultBranch as string | undefined) ?? "main",
    },
  });

  return c.json({ queued: true });
});

// PATCH /connections/:id — rename / reconfigure a connection
connectionRoute.patch("/:id", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = connectionUpdate.input.parse({
    ...json,
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionUpdate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /connections/:id/pause — pause or resume syncing ({ paused: boolean })
connectionRoute.post("/:id/pause", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = connectionPause.input.parse({
    ...json,
    connectionId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(connectionPause.name, body, ctx, { surface: "api" });
  return c.json(out);
});
