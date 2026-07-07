import { Hono } from "hono";
import { conversationExport } from "@oxagen/oxagen/contracts/conversation.export";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationExportRoute = new Hono<AppEnv>();

// GET /v1/:org/:workspace/conversations/:conversationId/export
//
// Query params:
//   format — required; "markdown" | "pdf"
//
// Markdown returns the serialized document inline in `content`; PDF persists a
// private generated asset and returns its access-controlled serve URL in `url`.
conversationExportRoute.get("/:conversationId/export", async (c) => {
  const conversationId = c.req.param("conversationId");
  const input = conversationExport.input.parse({
    conversationId,
    format: c.req.query("format"),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(conversationExport.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
