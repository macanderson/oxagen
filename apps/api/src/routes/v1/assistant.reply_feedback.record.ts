import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { assistantReplyFeedbackRecord } from "@oxagen/oxagen/contracts/assistant.reply_feedback.record";
import { invoke } from "@oxagen/oxagen/kernel";
import { capabilityContext } from "../../lib/context";
import type { AppEnv } from "../../app";

/** A person's verdict on one assistant reply, recorded against its run. */
export const assistantReplyFeedbackRecordRoute = new Hono<AppEnv>();

assistantReplyFeedbackRecordRoute.post("/", async (c) => {
  let rawInput: unknown;
  try {
    rawInput = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: "Invalid JSON body" });
  }
  const input = assistantReplyFeedbackRecord.input.parse(rawInput);
  const ctx = capabilityContext(c);
  const output = await invoke(assistantReplyFeedbackRecord.name, input, ctx, {
    surface: "api",
  });
  return c.json(output);
});
