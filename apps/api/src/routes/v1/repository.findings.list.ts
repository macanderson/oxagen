import { Hono } from "hono";
import { codeRepositoryFindingsList } from "@oxagen/oxagen/contracts/repository.findings.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * List the instruction-file statements in the workspace's linked code
 * repositories that repeat or contradict a steering record
 * (`list_code_repository_findings`, #4518). The Repositories page shows them
 * in its Instruction files section. The read takes no input and writes
 * nothing, so it answers 200. Mounted on the org-scoped router.
 */
export const codeRepositoryFindingsListRoute = new Hono<AppEnv>();

// GET /v1/:org_slug/:workspace_slug/repository/findings
codeRepositoryFindingsListRoute.get("/", async (c) => {
  const input = codeRepositoryFindingsList.input.parse({});
  const ctx = capabilityContext(c);
  const output = await invoke(codeRepositoryFindingsList.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 200);
});
