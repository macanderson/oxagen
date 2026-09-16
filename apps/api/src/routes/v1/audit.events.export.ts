import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { ORG_ONLY_WORKSPACE_ID } from "@oxagen/oxagen/contracts/audit.log.query";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Export the org's security audit events as a signed CSV or NDJSON file.
 *
 * An export answers for the whole organization — no workspace role grants it
 * — so the route is mounted on the organization-only router at the documented
 * `POST /v1/:org_slug/audit/events/export`, and on the workspace-scoped one so
 * a caller already inside a workspace keeps a path. Either way the capability
 * is invoked org-wide: the context carries the organization-only workspace
 * sentinel, which the handler reads as "no workspace scope", and which
 * `scoped: true` accepts where the empty string would not.
 */
export const auditEventsExportRoute = new Hono<AppEnv>();

auditEventsExportRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = auditEventsExport.input.parse(rawInput);
  const ctx = capabilityContext(c, { requireWorkspace: false });
  const output = await invoke(
    auditEventsExport.name,
    input,
    { ...ctx, workspaceId: ORG_ONLY_WORKSPACE_ID },
    { surface: "api" },
  );
  return c.json(output);
});
