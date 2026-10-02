import { Hono } from "hono";
import { steeringRepoDestinationsList } from "@oxagen/oxagen/contracts/steering_repo.destinations.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Where a new workspace's steering repo can go: the GitHub organizations,
 * personal accounts, and GitLab groups the organization's stored tokens
 * reach, the organization's default, and the default name for `?slug=`
 * (`list_steering_repo_destinations`). Mounted org-only, like
 * `POST /workspaces`, because the caller may have no workspace yet.
 */
export const steeringRepoDestinationsListRoute = new Hono<AppEnv>();

// GET /v1/:org_slug/steering-repo/destinations?slug=<workspace slug>
steeringRepoDestinationsListRoute.get("/", async (c) => {
  const slug = c.req.query("slug");
  const input = steeringRepoDestinationsList.input.parse(
    slug === undefined || slug === "" ? {} : { slug },
  );
  const ctx = capabilityContext(c, { requireWorkspace: false });
  const output = await invoke(steeringRepoDestinationsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
