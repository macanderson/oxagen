import { Hono } from "hono";
import { commandMenuSuggest } from "@oxagen/oxagen/contracts/command.menu.suggest";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const commandMenuSuggestRoute = new Hono<AppEnv>();

// Synchronous LLM-powered "Suggested for this page" generation for the Command
// Menu. Accepts a privacy-safe SuggestionContext (route, page-entity summary,
// recent entities, effective capabilities) and returns 3–5 short prompts. The
// route is org + workspace scoped (see app.ts), so the capability context
// already carries orgId and workspaceId.
commandMenuSuggestRoute.post("/", async (c) => {
  const body = commandMenuSuggest.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(commandMenuSuggest.name, body, ctx, {
    surface: "api",
  });
  return c.json(out, 200);
});
