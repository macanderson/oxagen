/**
 * agent.definition.revise — AI-driven edit of an existing agent definition.
 *
 * The edit counterpart to agent.definition.suggest (AI-create). Reads the
 * target agent's current config, has the model redesign it from a plain-language
 * change request — grounded in the same workspace candidates and create-agent
 * skill as suggest (see ./agent-suggest-core) — then persists the repaired
 * config as a NEW unpublished version by composing agent.definition.update
 * (which bumps the version number). The agent's slug is immutable, so it is
 * never touched; publishing stays a separate explicit step, so a revision never
 * silently changes what is live.
 */
import { z } from "zod";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { agentDefinitionRevise } from "@oxagen/oxagen/contracts/agent.definition.revise";
import type { AgentDefinitionGetOutput } from "@oxagen/oxagen/contracts/agent.definition.get";
import type { AgentDefinitionUpdateOutput } from "@oxagen/oxagen/contracts/agent.definition.update";
import { logger } from "./logger";
import {
  AgentSuggestError,
  assembleCandidates,
  buildAgentSystemPrompt,
  loadCreateAgentSkillBody,
  repairSynthesis,
  synthesisSchema,
} from "./agent-suggest-core";

/** Thrown for revise-specific preconditions (agent not found, managed/read-only).
 *  Synthesis + validation failures bubble as AgentSuggestError from the core. */
export class AgentReviseError extends Error {
  readonly code = "agent_revise_failed";
  constructor(message: string) {
    super(message);
    this.name = "AgentReviseError";
  }
}

// The synthesis shape is shared with suggest, extended with a change summary the
// model fills describing exactly what it altered versus the current config —
// surfaced to the user as the revision's diff line.
const reviseSynthesisSchema = synthesisSchema.extend({
  changeSummary: z
    .array(z.string())
    .describe(
      "Short bullets stating exactly what you changed versus the CURRENT AGENT configuration shown — one bullet per change (e.g. 'Bound graph to the billing ontology', 'Equipped the github MCP server', 'Rewrote the system prompt for a terser tone').",
    ),
});
type ReviseSynthesis = z.infer<typeof reviseSynthesisSchema>;

/** Serialise the current definition into a compact, model-legible block. */
function formatCurrentAgent(current: AgentDefinitionGetOutput): string {
  return [
    "CURRENT AGENT (revise THIS — keep whatever the change request does not touch):",
    `- slug (IMMUTABLE — never change): ${current.slug}`,
    `- name: ${current.name}`,
    `- description: ${current.description ?? "(none)"}`,
    `- agentType: ${current.agentType}`,
    "- config:",
    JSON.stringify(current.config, null, 2),
  ].join("\n");
}

export const agentDefinitionReviseHandler: CapabilityHandler<
  typeof agentDefinitionRevise
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new AgentReviseError("workspaceId is required (scoped capability).");
  }

  // ── Load the current definition ──────────────────────────────────────────────
  const current = (await invoke(
    "get_agent_def",
    { agentId: input.agentId },
    ctx,
  )) as AgentDefinitionGetOutput;

  if (current.managed) {
    throw new AgentReviseError(
      `Agent "${current.slug}" is product-managed and read-only; it cannot be revised.`,
    );
  }

  // ── Ground the model exactly as suggest does, plus the current config ────────
  const [skillBody, candidates] = await Promise.all([
    loadCreateAgentSkillBody(ctx),
    assembleCandidates(ctx),
  ]);

  const system = buildAgentSystemPrompt(skillBody, candidates);

  const prompt = [
    formatCurrentAgent(current),
    "",
    "CHANGE REQUEST:",
    input.prompt,
    "",
    "Produce the COMPLETE revised agent configuration (not a diff) following the create-agent skill above.",
    "Preserve everything the change request does not ask to alter. The slug is fixed and cannot change.",
    "Fill `changeSummary` with one bullet per change you made versus the current configuration.",
  ].join("\n");

  // ── Synthesis ────────────────────────────────────────────────────────────────
  let object: ReviseSynthesis;
  try {
    const result = await generateObjectFor({
      schema: reviseSynthesisSchema,
      system,
      prompt,
      temperature: 0.3,
      telemetry: {
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        surface: ctx.surface,
        messageId: ctx.messageId ?? null,
      },
    });
    object = result.object;
  } catch (err) {
    logger.error(
      {
        err,
        orgId: ctx.orgId,
        workspaceId: ctx.workspaceId,
        agentId: input.agentId,
      },
      "agent.definition.revise: generateObjectFor failed",
    );
    throw new AgentSuggestError(
      `Model synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Deterministic validation + repair (slug is fixed — not derived here) ─────
  const warnings: string[] = [];
  const { config, agentType, recommendations } = repairSynthesis(
    object,
    candidates,
    warnings,
  );

  // ── Persist as a new unpublished version via the existing update path ────────
  const updated = (await invoke(
    "update_agent_def",
    {
      agentId: input.agentId,
      name: object.name.trim() || current.name,
      description:
        object.description.trim() || current.description || undefined,
      agentType,
      config,
    },
    ctx,
  )) as AgentDefinitionUpdateOutput;

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      agentId: current.publicId,
      version: updated.version,
      agentType,
      tools: config.agentTools.length,
      changes: object.changeSummary.length,
      warnings: warnings.length,
    },
    "agent.definition.revise: new version created",
  );

  return {
    agentId: current.publicId,
    version: updated.version,
    isPublished: updated.isPublished,
    rationale: object.rationale,
    changeSummary: object.changeSummary,
    warnings,
    recommendations,
  };
};
