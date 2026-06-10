import { Hono } from "hono";
import { semanticEdgeApprove } from "@oxagen/oxagen/contracts/semantic.edge.approve";
import { semanticEdgeInfer } from "@oxagen/oxagen/contracts/semantic.edge.infer";
import { semanticEdgeList } from "@oxagen/oxagen/contracts/semantic.edge.list";
import { semanticEdgeSuggest } from "@oxagen/oxagen/contracts/semantic.edge.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const semanticEdgeRoute = new Hono<AppEnv>();

// POST /semantic-edges/infer — async LLM inference job
semanticEdgeRoute.post("/infer", async (c) => {
  const body = semanticEdgeInfer.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(semanticEdgeInfer.name, body, ctx, { surface: "api" });
  return c.json(out, 202);
});

// GET /semantic-edges/suggest — unapproved edge candidates for review UI
// Must be registered before the bare GET "/" to avoid shadowing by :id params.
semanticEdgeRoute.get("/suggest", async (c) => {
  const query = c.req.query();
  const body = semanticEdgeList.input.parse({
    confidenceMin: query.confidenceMin !== undefined ? Number(query.confidenceMin) : undefined,
    confidenceMax: query.confidenceMax !== undefined ? Number(query.confidenceMax) : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
  });
  // Delegate to the suggest contract (non-writing candidates only)
  const suggestBody = semanticEdgeSuggest.input.parse(body);
  const ctx = capabilityContext(c);
  const out = await invoke(semanticEdgeSuggest.name, suggestBody, ctx, { surface: "api" });
  return c.json(out, 200);
});

// POST /semantic-edges/:edgeId/decide — approve or reject a pending InferredEdge
// This is the endpoint the UI client components call from the browser.
semanticEdgeRoute.post("/:edgeId/decide", async (c) => {
  const edgeId = c.req.param("edgeId");
  const body = semanticEdgeApprove.input.parse({ edgeId, ...(await c.req.json()) });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticEdgeApprove.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});

// GET /semantic-edges — browse all inferred edges with filters
semanticEdgeRoute.get("/", async (c) => {
  const query = c.req.query();
  const body = semanticEdgeList.input.parse({
    type: query.type,
    sourceId: query.sourceId,
    confidenceMin: query.confidenceMin !== undefined ? Number(query.confidenceMin) : undefined,
    confidenceMax: query.confidenceMax !== undefined ? Number(query.confidenceMax) : undefined,
    limit: query.limit !== undefined ? Number(query.limit) : undefined,
    offset: query.offset !== undefined ? Number(query.offset) : undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(semanticEdgeList.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
