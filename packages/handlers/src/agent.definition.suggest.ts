/**
 * agent.definition.suggest — AI-assisted agent setup.
 *
 * Turns a plain-language description into a complete DRAFT agent configuration
 * shaped exactly like `agent.definition.create` input. Nothing is persisted:
 * the model synthesises identity + config, and this handler then validates and
 * repairs the synthesis deterministically in code (drops hallucinated tool
 * refs, forces every trigger disabled, substitutes an out-of-workspace
 * ontology, de-conflicts a colliding slug) before returning it for review.
 *
 * The HOW of turning a description into a valid config lives in the
 * `create-agent` builtin skill (packages/skills/skills/create-agent/skill.toml),
 * loaded as the system prompt, and the candidate assembly + synthesis schema +
 * deterministic repair are shared with `agent.definition.revise` in
 * ./agent-suggest-core.ts — this handler owns only the description prompt and
 * the fresh-slug derivation (a brand-new agent), returning the draft for review.
 */
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { logger } from "./logger";
import {
  AgentSuggestError,
  assembleCandidates,
  buildAgentSystemPrompt,
  clampSlug,
  deconflictSlug,
  loadCreateAgentSkillBody,
  repairSynthesis,
  SLUG_MAX,
  synthesisSchema,
  toKebab,
  type Synthesis,
} from "./agent-suggest-core";

// Re-exported so existing importers (and the unit test) keep resolving it from
// this module; the class itself now lives in ./agent-suggest-core.
export { AgentSuggestError };

export const agentDefinitionSuggestHandler: CapabilityHandler<
  typeof agentDefinitionSuggest
> = async (input, ctx) => {
  if (!ctx.workspaceId) {
    throw new AgentSuggestError("workspaceId is required (scoped capability).");
  }

  const [skillBody, candidates] = await Promise.all([
    loadCreateAgentSkillBody(ctx),
    assembleCandidates(ctx),
  ]);

  const system = buildAgentSystemPrompt(skillBody, candidates);

  const prompt = [
    "Description of the agent to build:",
    input.description,
    input.nameHint ? `\nPreferred slug: ${input.nameHint}` : "",
    input.agentTypeHint ? `\nPreferred agentType: ${input.agentTypeHint}` : "",
    "",
    "Produce one complete draft agent configuration following the create-agent skill above.",
  ]
    .filter(Boolean)
    .join("\n");

  // ── Synthesis ──────────────────────────────────────────────────────────────
  let object: Synthesis;
  try {
    const result = await generateObjectFor({
      schema: synthesisSchema,
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
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "agent.definition.suggest: generateObjectFor failed",
    );
    throw new AgentSuggestError(
      `Model synthesis failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // ── Deterministic validation + repair ───────────────────────────────────────
  const warnings: string[] = [];

  // Slug: honour the caller's nameHint, else the model's slug, else the name.
  // Clamp to the 18-char budget BEFORE de-conflict — the model (or a long
  // nameHint) can exceed it, and the contract would otherwise reject the output.
  const slugBase =
    toKebab(input.nameHint ?? object.slug) || toKebab(object.name) || "agent";
  let slug = clampSlug(slugBase);
  if (slug !== slugBase) {
    warnings.push(
      `Suggested slug "${slugBase}" exceeded the ${SLUG_MAX}-character budget; truncated to "${slug}".`,
    );
  }
  const deconflicted = deconflictSlug(slug, new Set(candidates.existingSlugs));
  if (deconflicted !== slug) {
    warnings.push(
      `An agent with the slug "${slug}" already exists; suggested "${deconflicted}" instead.`,
    );
    slug = deconflicted;
  }

  const { config, agentType, recommendations } = repairSynthesis(
    object,
    candidates,
    warnings,
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      slug,
      agentType,
      tools: config.agentTools.length,
      triggers: config.triggers.length,
      recommendations: recommendations.length,
      warnings: warnings.length,
    },
    "agent.definition.suggest: suggestion produced",
  );

  return {
    suggestion: {
      slug,
      name: object.name.trim() || slug,
      description: object.description.trim() || object.name.trim() || slug,
      agentType,
      // `instructions` is optional on agentDefinitionConfigSchema but required on
      // the suggestion — synthesis guarantees a non-empty value, so re-attach it
      // explicitly to satisfy the contract's output shape.
      config: {
        graph: config.graph,
        agentTools: config.agentTools,
        triggers: config.triggers,
        instructions: object.instructions,
      },
    },
    rationale: object.rationale,
    warnings,
    recommendations,
  };
};
