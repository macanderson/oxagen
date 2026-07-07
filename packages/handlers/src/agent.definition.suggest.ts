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
 * `create-agent` builtin skill (packages/skills/skills/create-agent.skill.md),
 * which is loaded as the system prompt — tenant copy first, builtin filesystem
 * fallback — grounded by the workspace's real skills, ontologies, MCP servers,
 * capabilities, and existing agents.
 */
import { z } from "zod";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { agentDefinitionConfigSchema } from "@oxagen/oxagen/agent-schema";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { createSkillRegistry } from "@oxagen/skills";
import { logger } from "./logger";

const CREATE_AGENT_SKILL_SLUG = "create-agent";

/** Thrown when the suggestion cannot be produced. Stable `.code` so callers can
 *  discriminate without string-matching, mirroring the agent handlers. */
export class AgentSuggestError extends Error {
  readonly code = "agent_suggest_failed";
  constructor(message: string) {
    super(message);
    this.name = "AgentSuggestError";
  }
}

// ── Builtin skill directory (lazy + guarded) ─────────────────────────────────
// A module-scope `fileURLToPath(import.meta.url)` is undefined in the CJS API
// bundle and crashes the whole function at load (FUNCTION_INVOCATION_FAILED —
// postmortem 2026-06-12). Resolve lazily inside a try. Path mirrors
// skill-workspace-seed.ts exactly (3 `..` → packages/skills/skills).
function skillsDir(): string {
  try {
    return join(fileURLToPath(import.meta.url), "../../../skills/skills");
  } catch {
    return join(process.cwd(), "packages/skills/skills");
  }
}

/**
 * Load the create-agent skill body for use as the system prompt. Prefers the
 * workspace's tenant copy (seeded into every new workspace), falling back to
 * the builtin on disk for workspaces that predate the skill and have not been
 * backfilled. Mirrors agent.skill.load's resolution order.
 */
async function loadCreateAgentSkillBody(ctx: CapabilityContext): Promise<string> {
  try {
    const loaded = (await invoke(
      "agent.skill.load",
      { skillSlug: CREATE_AGENT_SKILL_SLUG },
      ctx,
    )) as { loaded: boolean; body: string };
    if (loaded.loaded && loaded.body.trim()) return loaded.body;
  } catch (err) {
    logger.warn(
      { err, workspaceId: ctx.workspaceId },
      "agent.definition.suggest: tenant create-agent skill load failed; trying builtin",
    );
  }

  const registry = createSkillRegistry({ fsRoot: skillsDir() });
  const builtin = await registry.get(CREATE_AGENT_SKILL_SLUG);
  if (builtin?.body?.trim()) return builtin.body;

  throw new AgentSuggestError(
    "The create-agent skill is unavailable (no tenant copy and no builtin on disk).",
  );
}

// ── Candidate assembly ───────────────────────────────────────────────────────

interface Candidates {
  /** Enabled workspace graph schemas — the ontology id candidates. */
  ontologies: Array<{ id: string; displayName: string }>;
  /** Agent-surface capabilities — refs for `function` tools. */
  functions: Array<{ name: string; description: string }>;
  /** Workspace skills — refs (slugs) for `skill` tools. */
  skills: Array<{ slug: string; description: string }>;
  /** Registered MCP servers — refs (publicIds) for `mcp_server` tools. */
  mcpServers: Array<{ ref: string; name: string }>;
  /** Active workspace agents — refs (slugs) for `agent` (subagent) tools. */
  subagents: Array<{ slug: string; description: string }>;
  /** Every existing agent slug (any status) — for slug-collision de-conflict. */
  existingSlugs: string[];
}

/** Invoke a read capability, degrading to a fallback so one unavailable source
 *  never fails the whole suggestion. */
async function invokeSafe<T>(
  cap: string,
  ctx: CapabilityContext,
  fallback: T,
): Promise<T> {
  try {
    return (await invoke(cap, {}, ctx)) as T;
  } catch (err) {
    logger.warn({ err, cap }, "agent.definition.suggest: candidate source failed");
    return fallback;
  }
}

async function assembleCandidates(ctx: CapabilityContext): Promise<Candidates> {
  const [schemaOut, skillOut, mcpOut, agentOut] = await Promise.all([
    invokeSafe<{ schemas: Array<{ schemaName: string; displayName: string; enabled: boolean }> }>(
      "schema.list",
      ctx,
      { schemas: [] },
    ),
    invokeSafe<{ skills: Array<{ slug: string; description: string }> }>(
      "agent.skill.list",
      ctx,
      { skills: [] },
    ),
    invokeSafe<{ servers: Array<{ publicId: string; name: string }> }>(
      "agent.mcp.list",
      ctx,
      { servers: [] },
    ),
    invokeSafe<{
      agents: Array<{ slug: string; description: string | null; status: string }>;
    }>("agent.definition.list", ctx, { agents: [] }),
  ]);

  const functions = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .filter((c) => c.name !== agentDefinitionSuggest.name)
    .map((c) => ({ name: c.name, description: c.description }));

  return {
    ontologies: schemaOut.schemas
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.schemaName, displayName: s.displayName })),
    functions,
    skills: skillOut.skills.map((s) => ({ slug: s.slug, description: s.description })),
    mcpServers: mcpOut.servers.map((s) => ({ ref: s.publicId, name: s.name })),
    subagents: agentOut.agents
      .filter((a) => a.status === "active")
      .map((a) => ({ slug: a.slug, description: a.description ?? "" })),
    existingSlugs: agentOut.agents.map((a) => a.slug),
  };
}

function formatCandidates(c: Candidates): string {
  const section = (title: string, lines: string[]): string =>
    lines.length ? `${title}:\n${lines.join("\n")}` : `${title}:\n(none available)`;

  return [
    section(
      "ONTOLOGY CANDIDATES (use one of these ids for graph.ontologyId, or an empty string if none fit)",
      c.ontologies.map((o) => `- ${o.id} — ${o.displayName}`),
    ),
    section(
      "FUNCTION CAPABILITIES (ref for agentTools of type 'function')",
      c.functions.map((f) => `- ${f.name}: ${f.description}`),
    ),
    section(
      "SKILL CANDIDATES (ref for agentTools of type 'skill')",
      c.skills.map((s) => `- ${s.slug}: ${s.description}`),
    ),
    section(
      "MCP SERVER CANDIDATES (ref for agentTools of type 'mcp_server')",
      c.mcpServers.map((m) => `- ${m.ref} — ${m.name}`),
    ),
    section(
      "SUBAGENT CANDIDATES (ref for agentTools of type 'agent')",
      c.subagents.map((a) => `- ${a.slug}: ${a.description}`),
    ),
  ].join("\n\n");
}

// ── Synthesis schema (mirrors the contract suggestion object) ────────────────

const synthesisSchema = z.object({
  slug: z
    .string()
    .describe("Lowercase kebab-case slug derived from the agent's job, e.g. 'docs-drift-watcher'."),
  name: z.string().min(1).describe("Short human-readable name — a few words."),
  description: z
    .string()
    .min(1)
    .describe("ONE sentence stating the agent's job; drives routing and subagent selection."),
  agentType: z
    .enum(["custom", "code"])
    .describe("'code' ONLY when the agent must work over a repository; otherwise 'custom'."),
  instructions: z
    .string()
    .min(1)
    .describe(
      "The system prompt: what the agent does, its working order, standards, and boundaries. Brief and imperative. Do NOT inline knowledge available as a skill — equip the skill instead.",
    ),
  graph: z
    .object({
      ontologyId: z
        .string()
        .describe("MUST be one of the ONTOLOGY CANDIDATE ids, or an empty string if none fit."),
      mode: z
        .enum(["read", "extend"])
        .describe("'read' by default; 'extend' only when the agent must propose new nodes/edges."),
      retrieval: z.object({
        strategy: z
          .enum(["semantic", "lexical", "hybrid", "explicit"])
          .describe("Entry-node strategy; 'hybrid' is the sensible default."),
        scopeToTypes: z
          .array(z.string())
          .optional()
          .describe("Node/edge types that keep the agent in its lane; omit only if it needs all types."),
      }),
      budget: z.object({
        maxHops: z.number().int().nonnegative().describe("Max hops from an entry node; 2–3 typical."),
        maxNodes: z
          .number()
          .int()
          .positive()
          .describe("Max nodes pulled into context; a bounded cap (tens, not thousands)."),
        minRelevance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum relevance (0–1) for semantic/hybrid strategies."),
      }),
    })
    .describe("Graph access: ontology binding, write posture, retrieval, and budget."),
  agentTools: z
    .array(
      z.object({
        type: z
          .enum(["function", "mcp_server", "skill", "agent"])
          .describe("The kind of tool."),
        ref: z
          .string()
          .describe(
            "Reference matching the type: capability name (function), MCP server id (mcp_server), skill slug (skill), or agent slug (agent). MUST come from the candidate lists.",
          ),
      }),
    )
    .describe("The narrowest uniform tool list that does the job. ONLY refs from the candidate lists."),
  triggers: z
    .array(
      z.object({
        type: z.enum(["manual", "schedule", "event"]).describe("What starts a run."),
        eventSource: z
          .string()
          .optional()
          .describe("Event source system (required for event triggers)."),
        eventType: z
          .string()
          .optional()
          .describe("Event type within the source (required for event triggers)."),
        schedule: z
          .string()
          .optional()
          .describe("Cron expression (required for schedule triggers)."),
        filter: z
          .object({
            branches: z.array(z.string()).optional(),
            pathGlobs: z.array(z.string()).optional(),
          })
          .optional()
          .describe("Precise event filter — branches and path globs."),
      }),
    )
    .describe("What starts the agent. Prefer 'manual'. Every trigger is suggested disabled."),
  rationale: z
    .string()
    .min(1)
    .describe("Why this configuration — instructions framing, tool selection, graph scoping, trigger choice."),
});

type Synthesis = z.infer<typeof synthesisSchema>;

// ── Deterministic repair helpers ─────────────────────────────────────────────

function toKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Append a numeric suffix until the slug no longer collides with an existing one. */
function deconflictSlug(slug: string, existing: Set<string>): string {
  if (!existing.has(slug)) return slug;
  let n = 2;
  while (existing.has(`${slug}-${n}`)) n++;
  return `${slug}-${n}`;
}

// ── Handler ──────────────────────────────────────────────────────────────────

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

  const system = [
    skillBody,
    "",
    "---",
    "",
    "WORKSPACE CANDIDATES — you may ONLY reference items that appear below. Never invent a ref, ontology id, capability, skill, MCP server, or agent.",
    "",
    formatCandidates(candidates),
  ].join("\n");

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

  const functionRefs = new Set(candidates.functions.map((f) => f.name));
  const skillRefs = new Set(candidates.skills.map((s) => s.slug));
  const mcpRefs = new Set(candidates.mcpServers.map((m) => m.ref));
  const subagentRefs = new Set(candidates.subagents.map((a) => a.slug));
  const ontologyIds = new Set(candidates.ontologies.map((o) => o.id));
  const existingSlugs = new Set(candidates.existingSlugs);

  const agentType = object.agentType === "code" ? "code" : "custom";

  // Slug: honour the caller's nameHint, else the model's slug, else the name.
  let slug = toKebab(input.nameHint ?? object.slug) || toKebab(object.name) || "agent";
  const deconflicted = deconflictSlug(slug, existingSlugs);
  if (deconflicted !== slug) {
    warnings.push(
      `An agent with the slug "${slug}" already exists; suggested "${deconflicted}" instead.`,
    );
    slug = deconflicted;
  }

  // Tools: drop any ref not present in the candidate list for its type.
  const agentTools: Array<{ type: Synthesis["agentTools"][number]["type"]; ref: string }> = [];
  for (const tool of object.agentTools) {
    const known =
      tool.type === "function"
        ? functionRefs.has(tool.ref)
        : tool.type === "skill"
          ? skillRefs.has(tool.ref)
          : tool.type === "mcp_server"
            ? mcpRefs.has(tool.ref)
            : subagentRefs.has(tool.ref);
    if (known) {
      agentTools.push({ type: tool.type, ref: tool.ref });
    } else {
      warnings.push(
        `Removed ${tool.type} tool "${tool.ref}" — it does not exist in this workspace.`,
      );
    }
  }

  // Triggers: drop structurally-invalid ones, force every remaining one disabled.
  const triggers: Array<Record<string, unknown>> = [];
  for (const trigger of object.triggers) {
    if (trigger.type === "event" && (!trigger.eventSource || !trigger.eventType)) {
      warnings.push("Removed an event trigger that was missing its eventSource/eventType.");
      continue;
    }
    if (trigger.type === "schedule" && !trigger.schedule) {
      warnings.push("Removed a schedule trigger that was missing its cron schedule.");
      continue;
    }
    triggers.push({ ...trigger, enabled: false });
  }

  // Ontology: substitute an out-of-workspace id, or leave unbound when none exist.
  let ontologyId = object.graph.ontologyId?.trim() ?? "";
  if (ontologyId && !ontologyIds.has(ontologyId)) {
    if (candidates.ontologies.length > 0) {
      const fallback = candidates.ontologies[0]!.id;
      warnings.push(
        `Ontology "${ontologyId}" is not in this workspace; bound to "${fallback}" instead.`,
      );
      ontologyId = fallback;
    } else {
      warnings.push(
        `Ontology "${ontologyId}" is not in this workspace, which has no graph schema yet; left unbound.`,
      );
      ontologyId = "";
    }
  }

  const draftConfig = {
    graph: {
      ontologyId,
      mode: object.graph.mode,
      retrieval: {
        strategy: object.graph.retrieval.strategy,
        ...(object.graph.retrieval.scopeToTypes?.length
          ? { scopeToTypes: object.graph.retrieval.scopeToTypes }
          : {}),
      },
      budget: {
        maxHops: object.graph.budget.maxHops,
        maxNodes: object.graph.budget.maxNodes,
        ...(object.graph.budget.minRelevance !== undefined
          ? { minRelevance: object.graph.budget.minRelevance }
          : {}),
      },
    },
    agentTools,
    triggers,
    instructions: object.instructions,
  };

  // Final gate: the suggestion must parse as a real AgentDefinitionConfig so it
  // can be fed straight into agent.definition.create without reshaping.
  let config: z.infer<typeof agentDefinitionConfigSchema>;
  try {
    config = agentDefinitionConfigSchema.parse(draftConfig);
  } catch (err) {
    logger.error(
      { err, orgId: ctx.orgId, workspaceId: ctx.workspaceId },
      "agent.definition.suggest: synthesised config failed final validation",
    );
    throw new AgentSuggestError(
      `Synthesised configuration failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  logger.info(
    {
      orgId: ctx.orgId,
      workspaceId: ctx.workspaceId,
      slug,
      agentType,
      tools: config.agentTools.length,
      triggers: config.triggers.length,
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
  };
};
