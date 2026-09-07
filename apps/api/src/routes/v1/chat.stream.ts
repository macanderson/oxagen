import { Hono } from "hono";
import { z } from "zod";
import { requestTurnBudgetSchema } from "@oxagen/billing";
import { CHAT_CONTENT_MAX_CHARS } from "@oxagen/oxagen/contracts/chat.message.send";
import type { AppEnv } from "../../app";

// Request shape for POST /:org_slug/:workspace_slug/chat/stream.
//
// The schema is deliberately still here even though the turn loop is not (see
// the route comment below): it is the ingress contract this surface has always
// published, and every field is still meaningful to the governed turn that will
// serve it. Keeping it means the 400s callers already depend on — malformed
// JSON, a missing/empty message, an oversized body, a nonsense budget override
// — stay byte-identical across the excision, and the client wire format does
// not have to be rediscovered when the handler is reattached.
const BodySchema = z.object({
  // Bound the message body — the shared per-message ingress cap (see
  // CHAT_CONTENT_MAX_CHARS in the chat.message.send contract) so every chat
  // surface rejects oversized prompts identically.
  content: z.string().min(1).max(CHAT_CONTENT_MAX_CHARS),
  conversationId: z.string().nullable().default(null),
  // Per-turn MCP server allowlist. When non-empty, only those servers' tools
  // are loaded for this turn. Omit or pass [] to load all workspace MCPs.
  activeServerIds: z.array(z.string()).optional().default([]),
  // Optional model overrides — omit to use workspace/user defaults.
  tier: z.enum(["fast", "balanced", "precise"]).nullable().default(null),
  model: z.string().min(1).nullable().default(null),
  effort: z.enum(["low", "medium", "high"]).nullable().default(null),
  // Per-turn dollar-budget override. `null`/omitted means "no override for
  // this turn" — the saved default applies. Same schema and precedence as the
  // app chat route (@oxagen/billing).
  budget: requestTurnBudgetSchema.nullable().default(null),
});

export const chatStreamRoute = new Hono<AppEnv>();

// POST /:org_slug/:workspace_slug/chat/stream
//
// TEMPORARILY UNIMPLEMENTED — returns 501 { code:
// "chat_stream_pending_governed_turn" }.
//
// ADR-041 (docs/adr/ADR-041-runtime-excision.md) excised the agent runtime:
// Oxagen governs agents, it no longer runs them. This route used to drive
// `executeTurn` from what is now @oxagen/run-ledger — a ledger-only package
// where that function no longer exists — so the turn loop it depended on is
// gone rather than merely refactored.
//
// The replacement is `runGovernedTurn` in @oxagen/agent (ADR-041 §2): a thin
// in-process governed loop over @oxagen/ai with tools materialised from
// capability contracts through kernel.invoke(), with no sandbox, filesystem,
// browser or subagents. It is being built as a separate body of work. When it
// lands, this route reattaches to it and streams through the translator in
// ./chat-stream-translator (whose SSE wire shapes are unchanged) with the
// per-turn memory recall in ./chat-memory.
//
// The route stays mounted, and still authenticates, scopes and validates,
// because a 404 would tell a client the endpoint was withdrawn. 501 is the
// honest answer: the surface exists, the implementation does not yet.
chatStreamRoute.post("/", async (c) => {
  let rawBody: unknown;
  try {
    rawBody = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = BodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return c.json(
      { error: parsed.error.issues[0]?.message ?? "Invalid body" },
      400,
    );
  }

  return c.json(
    {
      error: {
        code: "chat_stream_pending_governed_turn",
        message:
          "Chat streaming is temporarily unavailable: the agent runtime was " +
          "removed (ADR-041) and this route is awaiting the governed turn " +
          "loop (runGovernedTurn in @oxagen/agent).",
      },
    },
    501,
  );
});
