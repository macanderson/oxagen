/**
 * graph.relationship.upsert.ts — Hono route for graph.relationship.upsert.
 *
 * POST /v1/:org/:ws/graph/relationship/upsert
 *
 * This is the canonical new path. The old /graph/edge/upsert path
 * (graph.edge.upsert contract) remains mounted as a deprecation alias.
 */

import { Hono } from "hono";
import { graphRelationshipUpsert } from "@oxagen/oxagen/contracts/graph.relationship.upsert";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const graphRelationshipUpsertRoute = new Hono<AppEnv>();

// POST /graph/relationship/upsert — MERGE a typed relationship between two KnowledgeNodes
graphRelationshipUpsertRoute.post("/", async (c) => {
  const body = graphRelationshipUpsert.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(graphRelationshipUpsert.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
