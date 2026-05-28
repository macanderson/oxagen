import { Hono } from "hono";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { chatMessageSendHandler } from "@oxagen/handlers/chat.message.send";
import { capabilityContext } from "../../lib/context.js";
import type { AppEnv } from "../../app.js";

export const chatMessageSendRoute = new Hono<AppEnv>();

// The terminal record is persisted synchronously; streaming tokens land via
// the runner. UI subscribes to assistant message updates by id. The
// agent-epic SSE/RSC streaming wrapper will reuse this route + Vary header.
chatMessageSendRoute.post("/", async (c) => {
  const body = chatMessageSend.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await chatMessageSendHandler(body, ctx);
  return c.json(out, 202);
});
