import { Hono } from "hono";
import { workingCopyList } from "@oxagen/oxagen/contracts/repository.working_copy.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The directories the CLI linked to this workspace, most recently seen first
 * (`list_working_copies`). `?limit=` is optional. Mounted on the org-scoped
 * router at `/working-copies`, beside the write.
 */
export const workingCopyListRoute = new Hono<AppEnv>();

workingCopyListRoute.get("/", async (c) => {
  const limit = c.req.query("limit");
  const input = workingCopyList.input.parse(
    limit === undefined ? {} : { limit: Number(limit) },
  );
  const ctx = capabilityContext(c);
  const output = await invoke(workingCopyList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
