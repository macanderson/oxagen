import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { steeringMarkdownImportCommit } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * Open one steering PR with the Markdown import's rows marked add
 * (`commit_markdown_import`, #4907). It answers 201 with the PR.
 * Mounted on the org-scoped router.
 */
export const steeringMarkdownImportCommitRoute = new Hono<AppEnv>();

// POST /v1/:org_slug/:workspace_slug/context/steering/import/commit
steeringMarkdownImportCommitRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = steeringMarkdownImportCommit.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(steeringMarkdownImportCommit.name, input, ctx, {
    surface: "api",
  });
  return c.json(output, 201);
});
