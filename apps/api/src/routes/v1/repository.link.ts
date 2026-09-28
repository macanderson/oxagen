import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Propose linking a repository to the workspace (`link_repository`). The
 * handler opens a steering PR, and the link follows its merge (ADR-212), so
 * the route answers 202 Accepted. Mounted on the org-scoped router. The
 * handler checks the role.
 */
export const repositoryLinkRoute = new Hono<AppEnv>();

repositoryLinkRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryLink.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryLink.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 202);
});
