import { Hono } from "hono";
import { conversationGet } from "@oxagen/oxagen/contracts/conversation.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const conversationGetRoute = new Hono<AppEnv>();

/** The path segment that reads the caller's latest active conversation. */
const LATEST = "latest";

// GET /v1/:org/:workspace/conversations/latest
// GET /v1/:org/:workspace/conversations/:conversationId
//
// Query params:
//   limit (optional): the newest messages to return, 1 to 200 (default 100)
//
// `latest` reads the caller's most recently updated active conversation and
// answers `{ conversation: null }` when there is none. A `cnv_` id reads that
// conversation, archived or not, when it is the caller's; any other is a 404.
// A `cnv_` id cannot spell `latest`, so the two never collide.
conversationGetRoute.get("/:conversationId", async (c) => {
  const segment = c.req.param("conversationId");
  const limit = c.req.query("limit");
  const input = conversationGet.input.parse({
    conversationId: segment === LATEST ? null : segment,
    limit: limit === undefined ? undefined : Number(limit),
  });
  const ctx = capabilityContext(c);
  const out = await invoke(conversationGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(out);
});
