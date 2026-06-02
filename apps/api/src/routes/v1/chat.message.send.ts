import { Hono } from "hono";
import { chatMessageSend } from "@oxagen/oxagen/contracts/chat.message.send";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

export const chatMessageSendRoute = new Hono<AppEnv>();

// The terminal record is persisted synchronously; streaming tokens land via
// the runner. UI subscribes to assistant message updates by id. The
// agent-epic SSE/RSC streaming wrapper will reuse this route + Vary header.
chatMessageSendRoute.post("/", async (c) => {
  const body = chatMessageSend.input.parse(await c.req.json());
  const ctx = capabilityContext(c);
  const out = await invoke(chatMessageSend.name, body, ctx, { surface: "api" });
  return c.json(out, 202);
});
