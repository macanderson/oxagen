import { Hono } from "hono";
import { repoConfigure } from "@oxagen/oxagen/contracts/repo.configure";
import { repoSync } from "@oxagen/oxagen/contracts/repo.sync";
import { repoPause } from "@oxagen/oxagen/contracts/repo.pause";
import { repoResume } from "@oxagen/oxagen/contracts/repo.resume";
import { repoMetrics } from "@oxagen/oxagen/contracts/repo.metrics";
import { repoCreate } from "@oxagen/oxagen/contracts/repo.create";
import { repoFilePut } from "@oxagen/oxagen/contracts/repo.file.put";
import { repoFork } from "@oxagen/oxagen/contracts/repo.fork";
import { repoBranchCreate } from "@oxagen/oxagen/contracts/repo.branch.create";
import { repoBranchList } from "@oxagen/oxagen/contracts/repo.branch.list";
import { repoPrOpen } from "@oxagen/oxagen/contracts/repo.pr.open";
import { repoPrGet } from "@oxagen/oxagen/contracts/repo.pr.get";
import { repoPrDiff } from "@oxagen/oxagen/contracts/repo.pr.diff";
import { repoCiStatus } from "@oxagen/oxagen/contracts/repo.ci.status";
import { agentRepoEdit } from "@oxagen/oxagen/contracts/agent.repo.edit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const repoRoute = new Hono<AppEnv>();

// PATCH /repos/:id/configure — update repo-specific ingestion config
repoRoute.patch("/:id/configure", async (c) => {
  // Path param LAST: the URL identifies the resource, so a `repoId` in the body
  // must never redirect the write to a different repo than the one addressed.
  const body = repoConfigure.input.parse({
    ...((await c.req.json()) as Record<string, unknown>),
    repoId: c.req.param("id"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoConfigure.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/:id/sync — trigger incremental or full re-index
repoRoute.post("/:id/sync", async (c) => {
  // Path param LAST — see the note on /:id/configure above.
  const body = repoSync.input.parse({
    ...((await c.req.json()) as Record<string, unknown>),
    repoId: c.req.param("id"),
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

// POST /repos — create a new GitHub repository
repoRoute.post("/", async (c) => {
  const body = repoCreate.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(repoCreate.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});

// POST /repos/fork — fork a GitHub repository into user account or organisation
repoRoute.post("/fork", async (c) => {
  const body = repoFork.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(repoFork.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});

// PUT /repos/file — commit a file (create or update) in a GitHub repository
repoRoute.put("/file", async (c) => {
  const body = repoFilePut.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(repoFilePut.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/branch — create a new branch in a GitHub repository
repoRoute.post("/branch", async (c) => {
  const body = repoBranchCreate.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(repoBranchCreate.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 201);
});

// GET /repos/branches — list branches in a GitHub repository
repoRoute.get("/branches", async (c) => {
  const body = repoBranchList.input.parse({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoBranchList.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/pulls — open a pull request in a GitHub repository
repoRoute.post("/pulls", async (c) => {
  const body = repoPrOpen.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(repoPrOpen.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});

// GET /repos/ci/status — read CI check-run + commit-status results for a ref
repoRoute.get("/ci/status", async (c) => {
  const body = repoCiStatus.input.parse({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
    ref: c.req.query("ref"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoCiStatus.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// GET /repos/pulls/:number — PR summary, stats, comments, and CI status
repoRoute.get("/pulls/:number", async (c) => {
  const body = repoPrGet.input.parse({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
    number: Number(c.req.param("number")),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoPrGet.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// GET /repos/pulls/:number/diff — per-file unified-diff patches for a PR
repoRoute.get("/pulls/:number/diff", async (c) => {
  const body = repoPrDiff.input.parse({
    owner: c.req.query("owner"),
    repo: c.req.query("repo"),
    number: Number(c.req.param("number")),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(repoPrDiff.name, body, ctx, { surface: "api" });
  return c.json(out);
});

// POST /repos/agent/edit — run the coding agent against a repo and open a PR
repoRoute.post("/agent/edit", async (c) => {
  const body = agentRepoEdit.input.parse(
    (await c.req.json()) as Record<string, unknown>,
  );
  const ctx = capabilityContext(c);
  const out = await invoke(agentRepoEdit.name, body, ctx, { surface: "api" });
  return c.json(out, 201);
});
