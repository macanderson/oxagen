import { Hono } from "hono";
import { repoConfigure } from "@oxagen/oxagen/contracts/repo.configure";
import { repoSync } from "@oxagen/oxagen/contracts/repo.sync";
import { repoPause } from "@oxagen/oxagen/contracts/repo.pause";
import { repoResume } from "@oxagen/oxagen/contracts/repo.resume";
import { repoMetrics } from "@oxagen/oxagen/contracts/repo.metrics";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const repoRoute = new Hono<AppEnv>();

// PATCH /repos/:id/configure — update repo-specific ingestion config
repoRoute.patch("/:id/configure", async (c) => {
  const body = repoConfigure.input.parse({
    repoId: c.req.param("id"),
    ...(await c.req.json() as Record<string, unknown>),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoConfigure.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/:id/sync — trigger incremental or full re-index
repoRoute.post("/:id/sync", async (c) => {
  const body = repoSync.input.parse({
    repoId: c.req.param("id"),
    ...(await c.req.json() as Record<string, unknown>),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoSync.name, body, ctx, { surface: "api" });
  return c.json(out, 202);
});

// POST /repos/:id/pause — pause automatic syncing
repoRoute.post("/:id/pause", async (c) => {
  const body = repoPause.input.parse({ repoId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(repoPause.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/:id/resume — resume paused syncing
repoRoute.post("/:id/resume", async (c) => {
  const body = repoResume.input.parse({ repoId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(repoResume.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// GET /repos/:id/metrics — sync statistics and metrics
repoRoute.get("/:id/metrics", async (c) => {
  const body = repoMetrics.input.parse({ repoId: c.req.param("id") });
  const ctx = capabilityContext(c);
  const out = await invoke(repoMetrics.name, body, ctx, { surface: "api" });
  return c.json(out);
});
