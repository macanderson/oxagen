import { Hono } from "hono";
import { runEvidenceSubmit } from "@oxagen/oxagen/contracts/run.evidence.submit";
import { runEvidenceList } from "@oxagen/oxagen/contracts/run.evidence.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

// Combined run-evidence route: POST submits a RunEvidenceManifestV1, GET lists
// evidence-manifest summaries. Both are thin adapters — contract-parse →
// capabilityContext → invoke — mounted at /run/evidence (org+workspace scoped).
export const runEvidenceRoute = new Hono<AppEnv>();

// POST /run/evidence — submit_run_evidence
runEvidenceRoute.post("/", async (c) => {
  const body = runEvidenceSubmit.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(runEvidenceSubmit.name, body, ctx, {
    surface: "api",
  });
  return c.json(out);
});

// GET /run/evidence — list_run_evidence
runEvidenceRoute.get("/", async (c) => {
  const limitParam = c.req.query("limit");
  const input = runEvidenceList.input.parse({
    runId: c.req.query("runId") ?? undefined,
    repositoryId: c.req.query("repositoryId") ?? undefined,
    limit: limitParam ? Number(limitParam) : undefined,
    cursor: c.req.query("cursor") ?? undefined,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(runEvidenceList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
