import { Hono } from "hono";
import { commandMenuSearch } from "@oxagen/oxagen/contracts/command.menu.search";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const commandMenuSearchRoute = new Hono<AppEnv>();

// Synchronous entity search for the Command Menu's Search section. Accepts an
// optional entity-kind filter, a free-text query, and the org/workspace slugs
// used for href construction, and returns up to 8 typed result rows. The route
// is org + workspace scoped (see app.ts) so the capability context already
// carries orgId and workspaceId.
commandMenuSearchRoute.post("/", async (c) => {
  const body = commandMenuSearch.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(commandMenuSearch.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
