import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryMainBind } from "@oxagen/oxagen/contracts/repository.main.bind";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Bind the workspace's main repository. Mounted on the org-scoped router behind session auth. */
export const repositoryMainBindRoute = new Hono<AppEnv>();

repositoryMainBindRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryMainBind.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryMainBind.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
