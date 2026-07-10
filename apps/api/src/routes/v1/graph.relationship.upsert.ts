/**
 * graph.relationship.upsert.ts — Hono route for graph.relationship.upsert.
 *
 * POST /v1/:org/:ws/graph/relationship/upsert
 *
 * STATUS (2026-07-10): intended to become the canonical path, but NO handler
 * is registered for upsert_graph_relationship — every request through this
 * route currently throws no_handler at dispatch (allowlisted as a known gap
 * in packages/handlers capability-dispatch.probe.test.ts). The working route
 * is /graph/edge/upsert (graph.edge.upsert contract, upsert_edge handler).
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
  const out = await invoke(graphRelationshipUpsert.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});
