import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryLink } from "@oxagen/oxagen/contracts/repository.link";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Link a repository to the workspace as a linked (not main) repository (`link_repository`). Mounted on the org-scoped router; the role is checked in the handler. */
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
  return c.json(output, 201);
});
