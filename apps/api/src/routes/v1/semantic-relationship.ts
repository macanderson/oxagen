/**
 * semantic-relationship.ts — Hono routes for the canonical semantic.relationship.* capabilities.
 *
 * Capabilities covered:
 *   semantic.relationship.list    GET  /semantic-relationships
 *   semantic.relationship.suggest GET  /semantic-relationships/suggest
 *   semantic.relationship.approve POST /semantic-relationships/:edgeId/decide
 *   semantic.relationship.infer   POST /semantic-relationships/infer
 *
 * This capability is reachable at BOTH paths, via two files:
 *   /v1/:org/:ws/semantic-relationships   (canonical — served by this file)
 *   /v1/:org/:ws/semantic-edges           (deprecated alias — served by the sibling semantic-edge.ts)
 *
 * semantic-edge.ts imports from the semantic.edge.* contracts, which are now
 * deprecation re-exports of semantic.relationship.*. This file directly
 * imports the canonical contracts.
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
  const out = await invoke(semanticRelationshipInfer.name, body, ctx, { surface: "api" });
  return c.json(out, 202);
});

// GET /semantic-relationships/suggest — unapproved relationship candidates for review UI
// Must be registered before the bare GET "/" to avoid shadowing by :edgeId params.
semanticRelationshipRoute.get("/suggest", async (c) => {
  const query = c.req.query();
  const body = semanticRelationshipSuggest.input.parse({
    confidenceMin: query.confidenceMin !== undefined ? Number(query.confidenceMin) : undefined,
    confidenceMax: query.confidenceMax !== undefined ? Number(query.confidenceMax) : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipSuggest.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});

// POST /semantic-relationships/:edgeId/decide — approve or reject a pending relationship
semanticRelationshipRoute.post("/:edgeId/decide", async (c) => {
  const edgeId = c.req.param("edgeId");
  const body = semanticRelationshipApprove.input.parse({ edgeId, ...(await c.req.json()) });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipApprove.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});

// GET /semantic-relationships — browse all inferred relationships with filters
semanticRelationshipRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = semanticRelationshipList.input.parse({
    type: query.type,
    sourceId: query.sourceId,
    confidenceMin: query.confidenceMin !== undefined ? Number(query.confidenceMin) : undefined,
    confidenceMax: query.confidenceMax !== undefined ? Number(query.confidenceMax) : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticRelationshipList.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
