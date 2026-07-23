/**
 * agent.definition.summarize — LLM-inferred agent summary.
 *
 * Produces (and caches) a short plain-text description of what an agent does,
 * derived from its name, instructions (system prompt), equipped tools, and
 * triggers. The summary is cached against a SHA-256 checksum of the config it
 * was derived from (the same canonicalization agent_versions.checksum uses), so
 * a re-summarize is a cheap no-op unless the config changed since — or `force`
 * is set. The list/get surfaces read the persisted `summary`; this capability is
 * what fills it (e.g. the Studio Agents list summarizes the first few agents that
 * lack one, and create/update regenerate on save).
 *
 * Reads the LATEST version's config (max version), not the active one, so a save
 * (create → v1, update → vN+1) always advances the checksum and regenerates —
 * the summary tracks the newest authored intent, not only the published one.
 *
 * LLM failure throws a typed `AgentSummarizeError`; callers treat it fail-open
 * (a missing summary is never fatal to a list render).
 */
import { z } from "zod";
import { generateObjectFor, selectModel } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentDefinitionSummarize } from "@oxagen/oxagen/contracts/agent.definition.summarize";
import { parseAgentDefinitionConfig } from "@oxagen/oxagen/agent-schema";
import { computeConfigChecksum } from "@oxagen/oxagen/interactive-agent";
import { resolveAgent } from "@oxagen/agent/handlers/_agent-definition";
import { schema, withTenantDb } from "@oxagen/database";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "./logger";

/** Hard cap on the persisted summary (matches the column contract, <=256 chars). */
const SUMMARY_MAX_LEN = 256;

/**
 * Thrown when a summary cannot be produced (agent missing, no version config, or
 * the model call failed). Stable `.code` so callers discriminate without
 * string-matching, mirroring AgentSuggestError.
 */
export class AgentSummarizeError extends Error {
  readonly code = "agent_summarize_failed";
  constructor(message: string) {
    super(message);
    this.name = "AgentSummarizeError";
  }
}

const SUMMARY_SYSTEM_PROMPT = [
  "You write a one-line description of an AI agent for a list view.",
  "Write a single plain-text sentence or two, max 240 characters, describing what",
  "this agent does and what it works with. No markdown, no quotes, no preamble —",
  "return only the description.",
].join(" ");

const summarySchema = z.object({
  summary: z
    .string()
    .min(1)
    .describe(
      "Plain-text description of what the agent does and what it works with. One or two sentences, max 240 characters, no markdown or quotes.",
    ),
});

/** Compose the model prompt from the agent's identity + parsed config. */
function buildPrompt(
  agent: { name: string; description: string | null; agentType: string },
  config: ReturnType<typeof parseAgentDefinitionConfig>,
): string {
  const lines: string[] = [];
  lines.push(`Agent name: ${agent.name}`);
  if (agent.description) lines.push(`Author description: ${agent.description}`);
  lines.push(`Agent type: ${agent.agentType}`);

  if (config.instructions?.trim()) {
    lines.push(`System prompt / instructions:\n${config.instructions.trim()}`);
  }

  if (config.agentTools.length > 0) {
    lines.push(
      `Equipped tools: ${config.agentTools
        .map((t) => `${t.type}:${t.ref}`)
        .join(", ")}`,
    );
  } else {
    lines.push("Equipped tools: none");
  }

  if (config.graph?.ontologyId) {
    lines.push(`Knowledge-graph ontology: ${config.graph.ontologyId}`);
  }

  return lines.join("\n");
}

export const agentDefinitionSummarizeHandler: CapabilityHandler<
  typeof agentDefinitionSummarize
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new AgentSummarizeError(
      "workspaceId is required (scoped capability).",
    );
  }

  // ── Load the agent + its latest version config (one tenant transaction) ──────
  const loaded = await withTenantDb(async (tx) => {
    const agent = await resolveAgent(input.agentId, ctx.workspaceId, tx);
    if (!agent) {
      throw new AgentSummarizeError(
        `Agent "${input.agentId}" not found in this workspace`,
      );
    }
    const [latest] = await tx
      .select({ config: schema.agentVersions.config })
      .from(schema.agentVersions)
      .where(eq(schema.agentVersions.agentId, agent.id))
      .orderBy(desc(schema.agentVersions.version))
      .limit(1);
    if (!latest) {
      throw new AgentSummarizeError(
        `Agent "${input.agentId}" has no version config to summarize`,
      );
    }
    return { agent, config: latest.config };
  });

  // Checksum of the config the summary is derived from — same canonicalization
  // as agent_versions.checksum, so summary staleness keys off the real config.
  const checksum = computeConfigChecksum(loaded.config);

  // ── Cache short-circuit ──────────────────────────────────────────────────────
  // A summary already exists AND was derived from this exact config → return it,
  // no model call. `force` skips the cache to regenerate unconditionally.
  if (
    !input.force &&
    loaded.agent.summary &&
    loaded.agent.summaryChecksum === checksum
  ) {
    return {
      agentId: loaded.agent.publicId,
      summary: loaded.agent.summary,
      checksum,
    };
  }

  const config = parseAgentDefinitionConfig(loaded.config);
  const prompt = buildPrompt(loaded.agent, config);

  // ── Generation ───────────────────────────────────────────────────────────────
  let raw: string;
  try {
    const { object } = await generateObjectFor({
      schema: summarySchema,
      system: SUMMARY_SYSTEM_PROMPT,
      prompt,
      temperature: 0.3,
      // Fast/cheap tier — a one-line summary needs no reasoning model.
      model: selectModel({ tier: "fast" }),
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? null,
      },
    });
    raw = object.summary;
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
      },
      "agent.definition.summarize: generateObjectFor failed",
    );
    throw new AgentSummarizeError(
      `Model summarization failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Normalize whitespace and hard-truncate to the column budget.
  const summary = raw.trim().replace(/\s+/g, " ").slice(0, SUMMARY_MAX_LEN);
  if (!summary) {
    throw new AgentSummarizeError("Model returned an empty summary.");
  }

  // ── Persist summary + checksum ───────────────────────────────────────────────
  await withTenantDb((tx) =>
    tx
      .update(schema.agents)
      .set({ summary, summaryChecksum: checksum, updatedAt: new Date() })
      .where(
        and(
          eq(schema.agents.id, loaded.agent.id),
          eq(schema.agents.workspaceId, ctx.workspaceId),
        ),
      ),
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: loaded.agent.publicId,
      length: summary.length,
      forced: input.force ?? false,
    },
    "agent.definition.summarize: summary generated",
  );

  return { agentId: loaded.agent.publicId, summary, checksum };
};
