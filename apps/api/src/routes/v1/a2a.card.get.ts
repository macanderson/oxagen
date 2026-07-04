import { Hono } from "hono";
import { a2aCardGet } from "@oxagen/oxagen/contracts/a2a.card.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import { requestBaseUrl } from "../a2a/base-url";
import type { AppEnv } from "../../app";

// GET /:org_slug/:workspace_slug/a2a/card — governed (metered, IAM-gated) read
// of the workspace's A2A Agent Card. The unauthenticated discovery document is
// served separately at /.well-known/agent-card.json; this is the management
// surface with API/MCP/CLI parity.
export const a2aCardGetRoute = new Hono<AppEnv>();

a2aCardGetRoute.get("/", async (c) => {
  const ctx = capabilityContext(c);
  const out = await invoke(
    a2aCardGet.name,
    { baseUrl: requestBaseUrl(c) },
    ctx,
    { surface: "api" },
  );
  return c.json(out);
});
