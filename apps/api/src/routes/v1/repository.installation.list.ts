import { Hono } from "hono";
import { repositoryInstallationList } from "@oxagen/oxagen/contracts/repository.installation.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the repositories the workspace's GitHub App installation can reach —
 * the set `bind_main_repository` accepts (`list_installation_repositories`).
 * Mounted at `/repository/installation/repositories` behind session auth on
 * the org-scoped router.
 */
export const repositoryInstallationListRoute = new Hono<AppEnv>();

repositoryInstallationListRoute.get("/", async (c) => {
  const input = repositoryInstallationList.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryInstallationList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
