import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryInitPrOpen } from "@oxagen/oxagen/contracts/repository.init_pr.open";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Open the pull request that adds `.oxagen/` to a repository (`open_init_pr`). Mounted on the org-scoped router; the role is checked in the handler. */
export const repositoryInitPrOpenRoute = new Hono<AppEnv>();

repositoryInitPrOpenRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryInitPrOpen.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryInitPrOpen.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
