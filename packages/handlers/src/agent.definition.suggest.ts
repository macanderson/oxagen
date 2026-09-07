/**
 * agent.definition.suggest — AI-assisted agent setup.
 *
 * Turns a plain-language description into a complete DRAFT agent configuration
 * shaped exactly like `agent.definition.create` input. Nothing is persisted:
 * the model synthesises identity + config, and this handler then validates and
 * repairs the synthesis deterministically in code (drops hallucinated tool
 * refs, substitutes an out-of-workspace ontology, de-conflicts a colliding
 * slug) before returning it for review.
 *
 * The HOW of turning a description into a valid definition — the authoring
 * system prompt, the candidate assembly, the synthesis schema and the
 * deterministic repair — is shared with `agent.definition.revise` in
 * ./agent-suggest-core.ts. This handler owns only the description prompt and
 * the fresh-slug derivation (a brand-new agent), returning the draft for review.
 */
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { listCapabilities } from "@oxagen/oxagen";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { logger } from "./logger";
import { selectAgentCapabilities } from "./lib/agent-role-defaults";
import { suggestNarrowestAgentRole } from "./lib/agent-role-suggest";
import {
  AgentSuggestError,
  assembleCandidates,
  buildAgentSystemPrompt,
  clampSlug,
  deconflictSlug,
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

  const candidates = await assembleCandidates(ctx);

  const system = buildAgentSystemPrompt(candidates);

  const prompt = [
    "Description of the agent to build:",
    input.description,
    input.nameHint ? `\nPreferred slug: ${input.nameHint}` : "",
    "",
    "Produce one complete draft agent definition following the authoring instructions above.",
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

  const { config, recommendations } = repairSynthesis(
    object,
    candidates,
    warnings,
  );

  // ── Suggested role (Agent RBAC Phase 5b) ────────────────────────────────────
  //
  // The narrowest system role that can still run what was just drafted. Derived
  // from the REPAIRED config (hallucinated tool refs are already gone, so the
  // suggestion reflects what the agent will actually be equipped with) and from
  // the live capability registry's agent metadata — the same category/riskLevel
  // pairs AGENT_ROLE_SPECS computes its grants from. Purely deterministic: no
  // model output feeds this decision.
  //
  // Attendance: an agent definition is a registry record with no trigger
  // fields, so it carries no attended/unattended signal. Pass no trigger types
  // — the suggestion defaults to the attended reading; the human-reviewed role
  // picker and `assign_agent_role` remain the sole authority on the ceiling
  // actually attached.
  const suggestedRole = suggestNarrowestAgentRole(
    {
      agentTools: config.agentTools,
      graphMode: config.graph.mode,
      triggerTypes: [],
    },
    selectAgentCapabilities(listCapabilities()),
  );

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      slug,
      tools: config.agentTools.length,
      recommendations: recommendations.length,
      warnings: warnings.length,
      suggestedRole: suggestedRole.roleName,
    },
    "agent.definition.suggest: suggestion produced",
  );

  return {
    suggestion: {
      slug,
      name: object.name.trim() || slug,
      description: object.description.trim() || object.name.trim() || slug,
      // ADR-043 removed code mode; every governed agent definition is "custom".
      agentType: "custom",
      // `instructions` is optional on agentDefinitionConfigSchema but required on
      // the suggestion — synthesis guarantees a non-empty value, so re-attach it
      // explicitly to satisfy the contract's output shape.
      config: {
        graph: config.graph,
        agentTools: config.agentTools,
        instructions: object.instructions,
      },
    },
    rationale: object.rationale,
    warnings,
    recommendations,
    suggestedRole,
  };
};
