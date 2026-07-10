/**
 * semantic-relationship.ts — Hono routes for the semantic.relationship.* capabilities.
 *
 * Capabilities covered:
 *   semantic.relationship.list    GET  /semantic-relationships
 *   semantic.relationship.suggest GET  /semantic-relationships/suggest
 *   semantic.relationship.approve POST /semantic-relationships/:edgeId/decide
 *   semantic.relationship.infer   POST /semantic-relationships/infer
 *
 * STATUS (2026-07-10): these 4 capabilities have NO registered handlers —
 * every request through this file throws no_handler at dispatch (allowlisted
 * as known gaps in packages/handlers capability-dispatch.probe.test.ts). The
 * WORKING routes are /v1/:org/:ws/semantic-edges (sibling semantic-edge.ts),
 * whose semantic.edge.* contracts are independent contracts (own names, own
 * registered handlers) — NOT re-exports of these. Finish wiring handlers here
 * before pointing any caller at /semantic-relationships.
 */

import { Hono } from "hono";
import { semanticRelationshipList } from "@oxagen/oxagen/contracts/semantic.relationship.list";
import { semanticRelationshipApprove } from "@oxagen/oxagen/contracts/semantic.relationship.approve";
import { semanticRelationshipInfer } from "@oxagen/oxagen/contracts/semantic.relationship.infer";
import { semanticRelationshipSuggest } from "@oxagen/oxagen/contracts/semantic.relationship.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const semanticRelationshipRoute = new Hono<AppEnv>();

// POST /semantic-relationships/infer — async LLM inference job
// Registered before bare GET "/suggest" to avoid shadowing
semanticRelationshipRoute.post("/infer", async (c) => {
  const body = semanticRelationshipInfer.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipInfer.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 202);
});

// GET /semantic-relationships/suggest — unapproved relationship candidates for review UI
// Must be registered before the bare GET "/" to avoid shadowing by :edgeId params.
semanticRelationshipRoute.get("/suggest", async (c) => {
  const query = c.req.query();
  const body = semanticRelationshipSuggest.input.parse({
    confidenceMin:
      query.confidenceMin !== undefined
        ? Number(query.confidenceMin)
        : undefined,
    confidenceMax:
      query.confidenceMax !== undefined
        ? Number(query.confidenceMax)
        : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipSuggest.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

// POST /semantic-relationships/:edgeId/decide — approve or reject a pending relationship
semanticRelationshipRoute.post("/:edgeId/decide", async (c) => {
  const edgeId = c.req.param("edgeId");
  const body = semanticRelationshipApprove.input.parse({
    edgeId,
    ...(await c.req.json()),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipApprove.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});

// GET /semantic-relationships — browse all inferred relationships with filters
semanticRelationshipRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = semanticRelationshipList.input.parse({
    type: query.type,
    sourceId: query.sourceId,
    confidenceMin:
      query.confidenceMin !== undefined
        ? Number(query.confidenceMin)
        : undefined,
    confidenceMax:
      query.confidenceMax !== undefined
        ? Number(query.confidenceMax)
        : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipList.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
