import { Hono } from "hono";
import { orgDataPlaneGet } from "@oxagen/oxagen/contracts/org.data_plane.get";
import { orgDataPlaneSet } from "@oxagen/oxagen/contracts/org.data_plane.set";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Combined ADR-042 data-plane route — the
 * `/v1/:org_slug/:workspace_slug/org/data-plane` surface. One file covers both
 * capabilities (established combined-route precedent); each handler parses the
 * contract input, builds the kernel context, and invokes with surface "api".
 *
 * GET  /?kind=postgres  → the redacted binding (never a DSN, never a credential)
 * PUT  /                → bind a dedicated endpoint, or return to the shared plane
 *
 * PUT rather than POST: `set_data_plane` replaces the whole binding for one
 * (organisation, kind) and is idempotent under repetition with the same body.
 */
export const orgDataPlaneRoute = new Hono<AppEnv>();

orgDataPlaneRoute.get("/", async (c) => {
  const input = orgDataPlaneGet.input.parse({ kind: c.req.query("kind") });
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgDataPlaneGet.name, input, ctx, { surface: "api" }),
  );
});

orgDataPlaneRoute.put("/", async (c) => {
  const body = orgDataPlaneSet.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  return c.json(
    await invoke(orgDataPlaneSet.name, body, ctx, { surface: "api" }),
  );
});
