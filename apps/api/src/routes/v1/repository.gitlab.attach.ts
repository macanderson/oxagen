import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryGitlabAttach } from "@oxagen/oxagen/contracts/repository.gitlab.attach";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Connect a gitlab.com project with a project access token
 * (`attach_gitlab_project`, #3762). The handler verifies the token against
 * GitLab and stores it encrypted; the response never carries it. Mounted on
 * the org-scoped router behind session auth.
 */
export const repositoryGitlabAttachRoute = new Hono<AppEnv>();

repositoryGitlabAttachRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryGitlabAttach.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryGitlabAttach.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
