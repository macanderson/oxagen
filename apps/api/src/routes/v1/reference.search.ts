import { Hono } from "hono";
import { referenceSearch } from "@oxagen/oxagen/contracts/reference.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const referenceSearchRoute = new Hono<AppEnv>();

// Typed autocomplete search behind the chat composer's @-mention picker.
// Accepts a free-text query, an optional reference-kind filter, and an optional
// `slug` for exact public-id resolution of an existing mention chip; returns up
// to 25 typed reference rows (type, slug, location, label, description,
// properties). The route is org + workspace scoped (see app.ts) so the
// capability context already carries orgId and workspaceId.
referenceSearchRoute.post("/", async (c) => {
  const body = referenceSearch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(referenceSearch.name, body, ctx, { surface: "api" });
  return c.json(out, 200);
});
