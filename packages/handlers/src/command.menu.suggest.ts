/**
 * command.menu.suggest handler.
 *
 * Generates 3–5 context-aware "Suggested for this page" prompts for the
 * Command Menu using the fast/cheap LLM tier (Haiku-class via the AI gateway).
 *
 * Privacy rules from spec §7:
 *   - ONLY pageEntity.summary is forwarded to the LLM. Never raw record bodies.
 *   - The org can opt out via organizations.settings.suggest_llm_enabled = false.
 *     When opted out, the handler returns [] without any LLM call.
 *   - Suggestions are NOT persisted; the act of calling this capability IS
 *     auditable via the kernel's capability.invoked security event.
 */
import { z } from "zod";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { commandMenuSuggest } from "@oxagen/oxagen/contracts/command.menu.suggest";
import { schema, withTenantDb } from "@oxagen/database";
import { eq } from "drizzle-orm";
import { logger } from "./logger";

// ── Org opt-out check ─────────────────────────────────────────────────────────

/**
 * Read the org's `suggest_llm_enabled` toggle from the JSONB `settings` column.
 * Defaults to `true` — all orgs see suggestions unless they explicitly opt out.
 *
 * Uses withTenantDb so the org row is fetched within the correct RLS context.
 */
async function isSuggestEnabled(orgId: string): Promise<boolean> {
  try {
    const row = await withTenantDb((tx) =>
      tx.query.organizations.findFirst({
        where: eq(schema.organizations.id, orgId),
        columns: { settings: true },
      }),
    );
    if (!row) return true; // safe default: enabled
    const settings = row.settings as Record<string, unknown> | null | undefined;
    if (!settings || typeof settings !== "object") return true;
    const flag = settings.suggest_llm_enabled;
    // Explicitly false → disabled; anything else (undefined, null, true, etc.) → enabled.
    return flag !== false;
  } catch {
    // If we can't read the org settings, default to enabled.
    return true;
  }
}

// ── LLM system prompt ─────────────────────────────────────────────────────────

const SUGGESTION_SYSTEM_PROMPT = `
You generate context-aware prompt suggestions for a Command Menu in an AI orchestration platform called Oxagen.

Rules for each suggestion:
1. Start with a verb (Summarize, Show, Explain, List, Compare, Investigate, Identify, Find, Check, Generate, Analyze).
2. 5–12 words total.
3. Must be answerable by an AI agent with access to the user's workspace data.
4. Do NOT reveal or repeat the summary text verbatim — synthesize actionable questions from it.
5. Keep suggestions distinct from each other.
6. Match the locale provided.

Return exactly 3–5 suggestions. Always return valid JSON matching the schema.
`.trim();

// ── Output schema ─────────────────────────────────────────────────────────────

const suggestionSchema = z.object({
  suggestions: z
    .array(
      z.object({
        text: z.string().min(3).max(200),
        category: z.enum([
          "create",
          "investigate",
          "configure",
          "communicate",
          "analyze",
        ]),
        confidence: z.number().min(0).max(1),
      }),
    )
    .min(0)
    .max(5),
});

// ── Handler ───────────────────────────────────────────────────────────────────

export const commandMenuSuggestHandler: CapabilityHandler<
  typeof commandMenuSuggest
> = async (input, ctx) => {
  const { orgId, workspaceId } = ctx;

  // Org opt-out gate — short-circuit before any LLM call.
  const enabled = await isSuggestEnabled(orgId);
  if (!enabled) {
    logger.info({ orgId }, "command.menu.suggest: org opted out, returning []");
    return { suggestions: [] };
  }

  // Build a minimal, privacy-safe prompt. Only entity.summary is sent.
  const lines: string[] = [];
  lines.push(`Route: ${input.route}`);
  if (Object.keys(input.routeParams).length > 0) {
    lines.push(`Route params: ${JSON.stringify(input.routeParams)}`);
  }
  if (input.pageEntity) {
    lines.push(`Page entity kind: ${input.pageEntity.kind}`);
    if (input.pageEntity.label)
      lines.push(`Page entity label: ${input.pageEntity.label}`);
    // summary is the only payload-derived content we expose.
    if (input.pageEntity.summary) {
      lines.push(`Page entity summary: ${input.pageEntity.summary}`);
    }
  }
  if (input.recentEntities.length > 0) {
    lines.push(
      `Recent entities: ${input.recentEntities.map((e) => `${e.kind}/${e.label ?? e.id}`).join(", ")}`,
    );
  }
  if (input.locale !== "en") {
    lines.push(`Respond in locale: ${input.locale}`);
  }

  const prompt = lines.join("\n");

  let suggestions: z.output<typeof suggestionSchema>["suggestions"] = [];
  try {
    const { object } = await generateObjectFor({
      schema: suggestionSchema,
      system: SUGGESTION_SYSTEM_PROMPT,
      prompt,
      temperature: 0.4,
      // Use the fast tier — cheapest model, minimal latency, per spec §7 and
      // CLAUDE.md operating model (Haiku for single-file reads/lookups).
      model: selectModel({ tier: "fast" }),
      telemetry: {
        orgId,
        workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? ctx.requestId,
      },
    });
    suggestions = object.suggestions.slice(0, 5);
  } catch (err) {
    // Spec §7: if the LLM call fails, silently return [] so the menu still
    // renders without the Suggested section.
    logger.warn(
      { err, orgId, route: input.route },
      "command.menu.suggest: LLM call failed",
    );
    return { suggestions: [] };
  }

  logger.info(
    { orgId, workspaceId, route: input.route, count: suggestions.length },
    "command.menu.suggest: suggestions generated",
  );

  return { suggestions };
};
