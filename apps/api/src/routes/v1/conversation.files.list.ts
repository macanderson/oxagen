import { Hono } from "hono";
import { conversationFilesList } from "@oxagen/oxagen/contracts/conversation.files.list";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationFilesListRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/conversations/:conversationId/files
//
// Query params:
//   kind    — optional; one of image|video|document|spreadsheet|presentation|pdf|archive
//   limit   — optional; default 50, max 200
//   cursor  — optional; ISO createdAt of the last row from the previous page
conversationFilesListRoute.get("/:conversationId/files", async (c) => {
  const conversationId = c.req.param("conversationId");
  const input = conversationFilesList.input.parse({
    conversationId,
    kind: c.req.query("kind") ?? undefined,
    limit:
      c.req.query("limit") !== undefined
        ? Number(c.req.query("limit"))
        : undefined,
    cursor: c.req.query("cursor") ?? null,
  });
  const ctx = capabilityContext(c);
  const out = await invoke(conversationFilesList.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
