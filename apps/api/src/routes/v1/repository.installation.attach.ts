import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryInstallationAttach } from "@oxagen/oxagen/contracts/repository.installation.attach";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Make one of the workspace's reachable GitHub App installations the one it
 * acts through (`attach_github_installation`). The id is verified against the
 * caller's own `/user/installations` inside the handler before anything is
 * written. Mounted on the org-scoped router behind session auth.
 */
export const repositoryInstallationAttachRoute = new Hono<AppEnv>();

repositoryInstallationAttachRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryInstallationAttach.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryInstallationAttach.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
