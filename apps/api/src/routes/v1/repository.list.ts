import { Hono } from "hono";
import { repositoryList } from "@oxagen/oxagen/contracts/repository.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The workspace's repositories — its main repository and every linked one
 * (`list_repositories`). Mounted on the org-scoped router beside the link and
 * unlink writes.
 */
export const repositoryListRoute = new Hono<AppEnv>();

repositoryListRoute.get("/", async (c) => {
  const input = repositoryList.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
