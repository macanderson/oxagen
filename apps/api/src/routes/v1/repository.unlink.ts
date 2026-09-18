import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { repositoryUnlink } from "@oxagen/oxagen/contracts/repository.unlink";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** Unlink a linked repository from the workspace (`unlink_repository`); the main repository is refused. Mounted on the org-scoped router; the role is checked in the handler. */
export const repositoryUnlinkRoute = new Hono<AppEnv>();

repositoryUnlinkRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = repositoryUnlink.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(repositoryUnlink.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
