/**
 * Illustrative sketch: wrapping a Vercel AI SDK agent with Tacho.
 *
 * Design reference only — not a runnable package. The AI SDK exposes
 * `wrapLanguageModel` middleware; tacho composes it and intercepts tool
 * execution so both model calls and tool calls are chained events.
 */

import { tacho } from "@oxagen/tacho";
import { openai } from "@ai-sdk/openai";
import { generateText, tool, wrapLanguageModel } from "ai";
import { z } from "zod";

// --- Style (a): one-line wrap of the model + tools -----------------------

const session = tacho.startSession({
  agentId: "agnt_billing_helper",
  fleetId: "flt_acme_billing",
});

const model = tacho.wrapModel(openai("gpt-5"), session);
// Internally: wrapLanguageModel({ model, middleware: tachoMiddleware(session) })
// — every request/response becomes an `llm_call` event (digests, token usage,
// latency), enqueued on the lock-free buffer. Never blocks the call.

const refund = tacho.wrapTool(
  tool({
    description: "Refund an order",
    parameters: z.object({ orderId: z.string(), amountUsd: z.number() }),
    execute: async ({ orderId, amountUsd }) => refundOrder(orderId, amountUsd),
  }),
  session,
);
// wrapTool checks standing grants before execute(); a refund over policy
// triggers elevation: approval_request → PDP → Biscuit token → offline
// verify → token_use → execute. Denied → throws TachoDenied (fail-closed).

const { text } = await generateText({
  model,
  tools: { refund },
  prompt: "Customer 42 was double-charged on order 123; fix it.",
});

// --- Style (b): explicit middleware, for users who want the wiring -------

const explicitModel = wrapLanguageModel({
  model: openai("gpt-5"),
  middleware: tacho.middleware(session), // the same object wrapModel installs
});
