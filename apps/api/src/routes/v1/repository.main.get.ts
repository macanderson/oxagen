import { Hono } from "hono";
import { repositoryMainGet } from "@oxagen/oxagen/contracts/repository.main.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Read the workspace's main repository, whether a GitHub App installation is
 * attached, and the signed URLs to install or to change which repositories it
 * reaches (`get_main_repository`). Mounted on the same `/repository/main` path
 * as the bind, behind session auth on the org-scoped router.
 */
export const repositoryMainGetRoute = new Hono<AppEnv>();

repositoryMainGetRoute.get("/", async (c) => {
  const input = repositoryMainGet.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryMainGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
