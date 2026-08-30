/**
 * schema.ts — combined Hono route covering ALL schema.* capabilities.
 *
 * Capabilities covered (check:manifest combined-file note: all listed here are
 * served by this single file — false-positive gaps in check:manifest are expected
 * and suppressed by the header comment convention):
 *
 *   schema.registry.get     GET  /schema/registry
 *   schema.registry.config  PUT  /schema/registry/config
 *   schema.list             GET  /schema
 *   schema.toggle           POST /schema/:schemaName/toggle
 *   schema.label.upsert     PUT  /schema/:schemaName/labels/:labelName
 *   schema.label.delete     DELETE /schema/:schemaName/labels/:labelName
 *   schema.relationship.upsert   PUT  /schema/:schemaName/relationships/:relationshipName
 *   schema.relationship.delete   DELETE /schema/:schemaName/relationships/:relationshipName
 *   schema.property.upsert  PUT  /schema/:schemaName/properties/:ownerKind/:ownerName/:key
 *   schema.property.delete  DELETE /schema/:schemaName/properties/:ownerKind/:ownerName/:key
 *   schema.version.list     GET  /schema/versions
 *   schema.version.create   POST /schema/versions
 *   schema.version.pin      POST /schema/versions/:versionId/pin
 *   schema.version.diff     GET  /schema/versions/diff
 *   schema.export           GET  /schema/export
 *   schema.recommend        GET  /schema/recommend
 *   schema.setup            POST /schema/setup
 *   schema.validate.node    POST /schema/validate/node
 *   schema.validate.relationship POST /schema/validate/relationship
 *   schema.reconcile.dispatch POST /schema/reconcile/dispatch
 *   schema.reconcile.status GET  /schema/reconcile/status
 *   schema.chat             POST /schema/chat
 */

import { Hono } from "hono";
import { schemaRegistryGet } from "@oxagen/oxagen/contracts/schema.registry.get";
import { schemaRegistryConfig } from "@oxagen/oxagen/contracts/schema.registry.config";
import { schemaList } from "@oxagen/oxagen/contracts/schema.list";
import { schemaToggle } from "@oxagen/oxagen/contracts/schema.toggle";
import { schemaLabelUpsert } from "@oxagen/oxagen/contracts/schema.label.upsert";
import { schemaLabelDelete } from "@oxagen/oxagen/contracts/schema.label.delete";
import { schemaRelationshipUpsert } from "@oxagen/oxagen/contracts/schema.relationship.upsert";
import { schemaRelationshipDelete } from "@oxagen/oxagen/contracts/schema.relationship.delete";
import { schemaPropertyUpsert } from "@oxagen/oxagen/contracts/schema.property.upsert";
import { schemaPropertyDelete } from "@oxagen/oxagen/contracts/schema.property.delete";
import { schemaVersionList } from "@oxagen/oxagen/contracts/schema.version.list";
import { schemaVersionCreate } from "@oxagen/oxagen/contracts/schema.version.create";
import { schemaVersionPin } from "@oxagen/oxagen/contracts/schema.version.pin";
import { schemaVersionDiff } from "@oxagen/oxagen/contracts/schema.version.diff";
import { schemaExport } from "@oxagen/oxagen/contracts/schema.export";
import { schemaRecommend } from "@oxagen/oxagen/contracts/schema.recommend";
import { schemaSetup } from "@oxagen/oxagen/contracts/schema.setup";
import { schemaValidateNode } from "@oxagen/oxagen/contracts/schema.validate.node";
import { schemaValidateRelationship } from "@oxagen/oxagen/contracts/schema.validate.relationship";
import { schemaReconcileDispatch } from "@oxagen/oxagen/contracts/schema.reconcile.dispatch";
import { schemaReconcileStatus } from "@oxagen/oxagen/contracts/schema.reconcile.status";
import { schemaChat } from "@oxagen/oxagen/contracts/schema.chat";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const schemaRoute = new Hono<AppEnv>();

// ── Registry ──────────────────────────────────────────────────────────────────

// GET /schema/registry — resolve workspace registry
schemaRoute.get("/registry", async (c) => {
  const query = c.req.query();
  const body = schemaRegistryGet.input.parse({
    versionId: query.versionId,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaRegistryGet.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// PUT /schema/registry/config — set enforcement mode and conformance floor
schemaRoute.put("/registry/config", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaRegistryConfig.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaRegistryConfig.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// ── Schema list ───────────────────────────────────────────────────────────────

// GET /schema — list all schemas with enabled state
schemaRoute.get("/", async (c) => {
  const body = schemaList.input.parse({});
  const ctx = capabilityContext(c);
  const out = await invoke(schemaList.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// ── Schema toggle ─────────────────────────────────────────────────────────────

// POST /schema/:schemaName/toggle — enable/disable a schema
schemaRoute.post("/:schemaName/toggle", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  // Path params LAST throughout this file: the URL identifies the resource, so a
  // matching key in the body must never redirect the write somewhere else.
  const body = schemaToggle.input.parse({
    ...json,
    schemaName: c.req.param("schemaName"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaToggle.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// ── Labels ────────────────────────────────────────────────────────────────────

// PUT /schema/:schemaName/labels/:labelName — create/update a node label
schemaRoute.put("/:schemaName/labels/:labelName", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaLabelUpsert.input.parse({
    ...json,
    schemaName: c.req.param("schemaName"),
    name: c.req.param("labelName"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaLabelUpsert.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// DELETE /schema/:schemaName/labels/:labelName — remove a node label from draft
schemaRoute.delete("/:schemaName/labels/:labelName", async (c) => {
  const body = schemaLabelDelete.input.parse({
    schemaName: c.req.param("schemaName"),
    name: c.req.param("labelName"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaLabelDelete.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// ── Relationships ─────────────────────────────────────────────────────────────

// PUT /schema/:schemaName/relationships/:relationshipName — create/update a relationship type
schemaRoute.put("/:schemaName/relationships/:relationshipName", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaRelationshipUpsert.input.parse({
    ...json,
    schemaName: c.req.param("schemaName"),
    name: c.req.param("relationshipName"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaRelationshipUpsert.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// DELETE /schema/:schemaName/relationships/:relationshipName — remove relationship type from draft
schemaRoute.delete(
  "/:schemaName/relationships/:relationshipName",
  async (c) => {
    const body = schemaRelationshipDelete.input.parse({
      schemaName: c.req.param("schemaName"),
      name: c.req.param("relationshipName"),
    });
    const ctx = capabilityContext(c);
    const out = await invoke(schemaRelationshipDelete.name, body, ctx, {
      surface: "api",
    });
    return c.json(out);
  },
);

// ── Properties ────────────────────────────────────────────────────────────────

// PUT /schema/:schemaName/properties/:ownerKind/:ownerName/:key — create/update a property
//
// KNOWN DIVERGENCE: `:schemaName` is accepted by the path but NOT forwarded —
// the schema.property.upsert contract keys a property on (ownerKind, ownerName,
// key) within the workspace draft and declares no `schemaName` input. Two URLs
// that differ only in `:schemaName` therefore address the SAME property. Closing
// this needs a contract change (add `schemaName`) or a path change; do not
// "fix" it here by passing a field the contract would strip.
schemaRoute.put(
  "/:schemaName/properties/:ownerKind/:ownerName/:key",
  async (c) => {
    const json = (await c.req.json()) as Record<string, unknown>;
    const body = schemaPropertyUpsert.input.parse({
      ...json,
      ownerKind: c.req.param("ownerKind"),
      ownerName: c.req.param("ownerName"),
      key: c.req.param("key"),
    });
    const ctx = capabilityContext(c);
    const out = await invoke(schemaPropertyUpsert.name, body, ctx, {
      surface: "api",
    });
    return c.json(out);
  },
);

// DELETE /schema/:schemaName/properties/:ownerKind/:ownerName/:key — remove a property from draft
// Same `:schemaName` divergence as the PUT above.
schemaRoute.delete(
  "/:schemaName/properties/:ownerKind/:ownerName/:key",
  async (c) => {
    const body = schemaPropertyDelete.input.parse({
      ownerKind: c.req.param("ownerKind"),
      ownerName: c.req.param("ownerName"),
      key: c.req.param("key"),
    });
    const ctx = capabilityContext(c);
    const out = await invoke(schemaPropertyDelete.name, body, ctx, {
      surface: "api",
    });
    return c.json(out);
  },
);

// ── Versions ──────────────────────────────────────────────────────────────────

// GET /schema/versions — list all versions
schemaRoute.get("/versions", async (c) => {
  const query = c.req.query();
  const body = schemaVersionList.input.parse({
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaVersionList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /schema/versions — freeze current draft into a published version
schemaRoute.post("/versions", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaVersionCreate.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaVersionCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

// POST /schema/versions/:versionId/pin — pin to a specific published version
schemaRoute.post("/versions/:versionId/pin", async (c) => {
  const body = schemaVersionPin.input.parse({
    versionId: c.req.param("versionId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaVersionPin.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// GET /schema/versions/diff — structural diff of two versions (?fromVersionId=&toVersionId=)
// No ordering constraint against /versions/:versionId/pin: that route is a POST
// and this one a GET, and Hono dispatches on method+path, so :versionId can
// never shadow "diff" here regardless of registration order.
schemaRoute.get("/versions/diff", async (c) => {
  const body = schemaVersionDiff.input.parse({
    fromVersionId: c.req.query("fromVersionId"),
    toVersionId: c.req.query("toVersionId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaVersionDiff.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// ── Export ────────────────────────────────────────────────────────────────────

// GET /schema/export — build ZIP of a version (?versionId=)
schemaRoute.get("/export", async (c) => {
  const body = schemaExport.input.parse({
    versionId: c.req.query("versionId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaExport.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// ── Recommend + Setup ─────────────────────────────────────────────────────────

// GET /schema/recommend — AI-suggested starter schema (?sampleLimit=)
schemaRoute.get("/recommend", async (c) => {
  const query = c.req.query();
  const body = schemaRecommend.input.parse({
    sampleLimit:
      query.sampleLimit !== undefined ? Number(query.sampleLimit) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaRecommend.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /schema/setup — interactive LLM-assisted registry walkthrough
schemaRoute.post("/setup", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaSetup.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaSetup.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// ── Validate ──────────────────────────────────────────────────────────────────

// POST /schema/validate/node — validate node properties against workspace schema
schemaRoute.post("/validate/node", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaValidateNode.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaValidateNode.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// POST /schema/validate/relationship — validate relationship type and properties
schemaRoute.post("/validate/relationship", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaValidateRelationship.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaValidateRelationship.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// ── Reconcile ─────────────────────────────────────────────────────────────────

// POST /schema/reconcile/dispatch — dispatch async reconciliation job
schemaRoute.post("/reconcile/dispatch", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaReconcileDispatch.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaReconcileDispatch.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});

// GET /schema/reconcile/status — poll reconciliation job status (?executionId=)
schemaRoute.get("/reconcile/status", async (c) => {
  const body = schemaReconcileStatus.input.parse({
    executionId: c.req.query("executionId"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(schemaReconcileStatus.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// ── Chat (AI iterative builder turn) ───────────────────────────────────────────

// POST /schema/chat — one assistant turn: message + draft → reply + proposed mutations.
// apps/app also serves this in-process for streaming; this is the canonical REST surface.
schemaRoute.post("/chat", async (c) => {
  const json = (await c.req.json()) as Record<string, unknown>;
  const body = schemaChat.input.parse(json);
  const ctx = capabilityContext(c);
  const out = await invoke(schemaChat.name, body, ctx, { surface: "api" });
  return c.json(out);
});
