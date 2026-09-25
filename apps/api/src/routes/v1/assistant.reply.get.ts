import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assistantReplyGet } from "@oxagen/oxagen/contracts/assistant.reply.get";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/**
 * The reply an in-app agent turn left on the record, by its run: how a client
 * whose `/chat/stream` dropped reads the finished reply (ADR-XXX). Mounted on
 * the org-scoped router behind session auth.
 */
export const assistantReplyGetRoute = new Hono<AppEnv>();

assistantReplyGetRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }

  const input = assistantReplyGet.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(assistantReplyGet.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
