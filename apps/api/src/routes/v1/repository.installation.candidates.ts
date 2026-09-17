import { Hono } from "hono";
import { repositoryInstallationCandidates } from "@oxagen/oxagen/contracts/repository.installation.candidates";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the GitHub App installations the workspace's stored GitHub
 * authorization can reach — the set `attach_github_installation` accepts
 * (`list_github_installations`). Mounted at
 * `/repository/installation/candidates` behind session auth on the org-scoped
 * router.
 */
export const repositoryInstallationCandidatesRoute = new Hono<AppEnv>();

repositoryInstallationCandidatesRoute.get("/", async (c) => {
  const input = repositoryInstallationCandidates.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(
    repositoryInstallationCandidates.name,
    input,
    ctx,
    { surface: "api" },
  );
  return c.json(output, 200);
});
