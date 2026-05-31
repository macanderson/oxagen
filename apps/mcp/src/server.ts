import { Hono } from "hono";
import {
  CapabilityError,
  capabilitiesForSurface,
  invoke,
} from "@oxagen/oxagen";
// Side-effect imports: bind foundation + agent handlers into the kernel.
// Loaders are lazy, so this registers thunks without pulling in the heavy
// handler dependency chains until a capability is actually invoked.
import "@oxagen/handlers/register";
import "@oxagen/agent/register";
import { resolveMcpContext } from "./context.js";

// MCP tools are no longer hand-listed. The server derives its tool surface
// from the capability registry — every capability whose contract includes the
// `mcp` surface is exposed automatically, and dispatch goes through the single
// kernel `invoke()` path (input/output validation + surface enforcement, and —
// once auth lands — the principal + spend gate). Adding a capability needs no
// edits here.

export type McpTool = {
  name: string;
  description: string;
  invoke: (raw: unknown) => Promise<unknown>;
};

export function buildServer() {
  const app = new Hono();

  app.get("/healthz", (c) => c.json({ ok: true }));

  // /mcp/tools — discovery: every capability exposed on the mcp surface.
  // Auth required: a caller must present a valid Bearer token to enumerate
  // available tools. This prevents unauthenticated capability enumeration.
  app.get("/mcp/tools", async (c) => {
    const resolution = await resolveMcpContext(c.req.header("Authorization"));
    if (!resolution.ok) {
      return c.json({ error: "Unauthorized", reason: resolution.reason }, 401);
    }

    const tools = capabilitiesForSurface("mcp").map((cap) => ({
      name: cap.name,
      description: cap.description,
      domain: cap.domain,
      mode: cap.mode,
    }));
    return c.json({ tools });
  });

  // /mcp/tools/:name — invoke by name through the kernel.
  // Auth required: reject with 401 before the capability is looked up so
  // that the error surface is uniform regardless of capability name.
  app.post("/mcp/tools/:name", async (c) => {
    const resolution = await resolveMcpContext(c.req.header("Authorization"));
    if (!resolution.ok) {
      return c.json({ error: "Unauthorized", reason: resolution.reason }, 401);
    }

    const name = c.req.param("name");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- Hono c.req.json() returns any; body is passed opaquely to the capability kernel which validates its own input via Zod.
    const body = await c.req.json().catch(() => ({}));
    try {
      const result = await invoke(name, body, resolution.ctx, { surface: "mcp" });
      return c.json({ result });
    } catch (err) {
      if (err instanceof CapabilityError) {
        // Map the failure class to an honest HTTP status: client mistakes are
        // 4xx, server-side misconfiguration / handler bugs are 5xx, so monitors
        // don't misclassify our bugs as bad client requests.
        const status =
          err.code === "unknown_capability"
            ? 404
            : err.code === "surface_denied"
              ? 403
              : err.code === "invalid_input"
                ? 400
                : 500; // no_handler, invalid_output — server-side faults
        return c.json({ error: err.message, code: err.code }, status);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 500);
    }
  });

  return app;
}
