import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryTreeGet } from "@oxagen/oxagen/contracts/repository.tree.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Read what one of the workspace's repositories holds under `.oxagen/` on its production branch (`get_repository_tree`). A POST because it takes a binding id and makes live GitHub reads. Mounted on the org-scoped router. */
export const repositoryTreeGetRoute = new Hono<AppEnv>();

repositoryTreeGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryTreeGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryTreeGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
