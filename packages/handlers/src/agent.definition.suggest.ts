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
import { generateObjectFor } from "@oxagen/ai";
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { agentDefinitionConfigSchema } from "@oxagen/oxagen/agent-schema";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import { createBuiltinSkillRegistry } from "@oxagen/skills";
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

/**
 * Load the create-agent skill body for use as the system prompt. Prefers the
 * workspace's tenant copy (seeded into every new workspace), falling back to
 * the EMBEDDED builtin for workspaces that predate the skill and have not been
 * backfilled. Mirrors agent.skill.load's resolution order. The builtin is
 * embedded module data (not a filesystem read), so this fallback is always
 * available in any bundle — it is what makes the create-agent path un-brickable.
 */
async function loadCreateAgentSkillBody(ctx: CapabilityContext): Promise<string> {
  try {
    const loaded = (await invoke(
      "load_skill",
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

  const registry = createBuiltinSkillRegistry();
  const builtin = await registry.get(CREATE_AGENT_SKILL_SLUG);
  if (builtin?.body?.trim()) return builtin.body;

  // Unreachable in practice: create-agent is embedded module data that ships in
  // every bundle. If this ever throws, the generated builtins module is missing
  // the slug — a build/codegen defect, not a runtime/environment condition.
  throw new AgentSuggestError(
    "The create-agent skill is unavailable (embedded builtin missing — regenerate @oxagen/skills).",
  );
}

// ── Candidate assembly ───────────────────────────────────────────────────────

interface Candidates {
  /** Enabled workspace graph schemas — the ontology id candidates. */
  ontologies: Array<{ id: string; displayName: string }>;
  /** Agent-surface capabilities — refs for `function` tools. */
  functions: Array<{ name: string; description: string }>;
  /** Enabled workspace skills — refs (slugs) for `skill` tools. Excludes disabled
   *  skills, which are surfaced as recommendations (enable before equipping). */
  skills: Array<{ slug: string; description: string }>;
  /** Registered MCP servers — refs (publicIds) for `mcp_server` tools. */
  mcpServers: Array<{ ref: string; name: string }>;
  /** Active workspace agents — refs (slugs) for `agent` (subagent) tools. */
  subagents: Array<{ slug: string; description: string }>;
  /** Every existing agent slug (any status) — for slug-collision de-conflict. */
  existingSlugs: string[];
  /**
   * SECOND TIER — connect-first recommendation candidates. These are NOT
   * equipable (never in agentTools): the user must connect/enable them first.
   */
  /** Catalog MCP servers not registered in the workspace — refs are registry
   *  names (e.g. "github/github-mcp-server"). */
  connectableMcpServers: Array<{ ref: string; name: string; description: string }>;
  /** Workspace skills that exist but are disabled — refs are slugs. */
  disabledSkills: Array<{ ref: string; name: string; description: string }>;
}

/** Invoke a read capability, degrading to a fallback so one unavailable source
 *  never fails the whole suggestion. */
async function invokeSafe<T>(
  cap: string,
  ctx: CapabilityContext,
  fallback: T,
  input: Record<string, unknown> = {},
): Promise<T> {
  try {
    return (await invoke(cap, input, ctx)) as T;
  } catch (err) {
    logger.warn({ err, cap }, "agent.definition.suggest: candidate source failed");
    return fallback;
  }
}

async function assembleCandidates(ctx: CapabilityContext): Promise<Candidates> {
  const [schemaOut, skillOut, mcpOut, agentOut, catalogOut, wsSkillOut] = await Promise.all([
    invokeSafe<{ schemas: Array<{ schemaName: string; displayName: string; enabled: boolean }> }>(
      "list_schemas",
      ctx,
      { schemas: [] },
    ),
    invokeSafe<{ skills: Array<{ slug: string; name?: string; description: string }> }>(
      "list_agent_skills",
      ctx,
      { skills: [] },
    ),
    invokeSafe<{ servers: Array<{ publicId: string; name: string }> }>(
      "list_mcp_servers",
      ctx,
      { servers: [] },
    ),
    invokeSafe<{
      agents: Array<{ slug: string; description: string | null; status: string }>;
    }>("list_agent_defs", ctx, { agents: [] }),
    // Catalog MCP servers not yet installed in this workspace — recommendation
    // candidates. Ask for the not-installed slice directly; belt-and-suspenders
    // dedup against agent.mcp.list below handles registries lagging the flag.
    invokeSafe<{
      servers: Array<{
        name: string;
        title: string | null;
        description: string;
        installed: boolean;
      }>;
    }>("browse_plugin_catalog", ctx, { servers: [] }, {
      pluginType: "mcp_server",
      installed: false,
      limit: 50,
    }),
    // Every workspace skill WITH its enabled flag — the only source that exposes
    // disabled skills. Carries a publicId, not a slug; joined by name below.
    invokeSafe<{
      skills: Array<{ id: string; name: string; description: string; enabled: boolean }>;
    }>("list_workspace_skills", ctx, { skills: [] }),
  ]);

  const functions = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .filter((c) => c.name !== agentDefinitionSuggest.name)
    .map((c) => ({ name: c.name, description: c.description }));

  // Disabled workspace skills → recover each slug by joining skill.workspace.list
  // (has enabled + name) to agent.skill.list (has slug + name) on the name. A
  // disabled skill whose slug can't be recovered is dropped — a recommendation
  // needs a real slug ref the caller can enable.
  const slugByName = new Map(
    skillOut.skills
      .filter((s): s is { slug: string; name: string; description: string } => Boolean(s.name))
      .map((s) => [s.name.toLowerCase(), s.slug]),
  );
  const disabledSkills = wsSkillOut.skills
    .filter((s) => !s.enabled)
    .map((s) => {
      const slug = slugByName.get(s.name.toLowerCase());
      return slug ? { ref: slug, name: s.name, description: s.description } : null;
    })
    .filter((s): s is { ref: string; name: string; description: string } => s !== null);
  const disabledSlugs = new Set(disabledSkills.map((s) => s.ref));

  // Catalog servers the workspace already has — matched by the catalog's canonical
  // registry NAME against installed server names/publicIds (never the display
  // title, which is an unreliable label and would over-exclude).
  const installedMcpIdentity = new Set(
    mcpOut.servers.flatMap((s) => [s.publicId.toLowerCase(), s.name.toLowerCase()]),
  );
  const connectableMcpServers = catalogOut.servers
    .filter((s) => !s.installed)
    .filter((s) => !installedMcpIdentity.has(s.name.toLowerCase()))
    .slice(0, 50)
    .map((s) => ({ ref: s.name, name: s.title ?? s.name, description: s.description }));

  return {
    ontologies: schemaOut.schemas
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.schemaName, displayName: s.displayName })),
    functions,
    // Equippable skills exclude the disabled ones — those go to recommendations.
    skills: skillOut.skills
      .filter((s) => !disabledSlugs.has(s.slug))
      .map((s) => ({ slug: s.slug, description: s.description })),
    mcpServers: mcpOut.servers.map((s) => ({ ref: s.publicId, name: s.name })),
    subagents: agentOut.agents
      .filter((a) => a.status === "active")
      .map((a) => ({ slug: a.slug, description: a.description ?? "" })),
    existingSlugs: agentOut.agents.map((a) => a.slug),
    connectableMcpServers,
    disabledSkills,
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
    // SECOND TIER. These are deliberately fenced off from the equipable candidate
    // lists above: they do not exist in the workspace yet, so they can only be
    // RECOMMENDED (returned in `recommendations`), never equipped (`agentTools`).
    [
      "CONNECTABLE (recommendations ONLY — these are NOT equipable; never put them in agentTools).",
      "Recommend one when the description clearly needs it, with a reason tied to the description.",
      "The caller connects the MCP server / enables the skill first, then equips it in a later edit.",
    ].join("\n"),
    section(
      "CATALOG MCP SERVERS (recommend with kind 'mcp_server'; ref = the registry name shown)",
      c.connectableMcpServers.map((s) => `- ${s.ref} — ${s.name}: ${s.description}`),
    ),
    section(
      "DISABLED WORKSPACE SKILLS (recommend with kind 'skill'; ref = the slug shown; enable before equipping)",
      c.disabledSkills.map((s) => `- ${s.ref} — ${s.name}: ${s.description}`),
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
  recommendations: z
    .array(
      z.object({
        kind: z
          .enum(["mcp_server", "skill"])
          .describe(
            "'mcp_server' for a CATALOG MCP SERVER; 'skill' for a DISABLED WORKSPACE SKILL. Both come ONLY from the CONNECTABLE lists.",
          ),
        ref: z
          .string()
          .describe(
            "The EXACT ref from a CONNECTABLE list — the registry name for an mcp_server, the slug for a skill. Never invent one; never a ref from the equipable candidate lists.",
          ),
        name: z.string().describe("The human-readable name shown for it in the CONNECTABLE list."),
        reason: z
          .string()
          .describe(
            "Why THIS agent needs it, phrased against the user's description (e.g. 'watches PRs for schema changes — needs GitHub access'). One sentence.",
          ),
      }),
    )
    .optional()
    .describe(
      "Tools the agent SHOULD have that are not available in the workspace yet — connectable catalog MCP servers or disabled workspace skills. NEVER equip these (never in agentTools); the caller connects/enables them first. Omit anything already available; equip that instead.",
    ),
  rationale: z
    .string()
    .min(1)
    .describe("Why this configuration — instructions framing, tool selection, graph scoping, trigger choice."),
});

type Synthesis = z.infer<typeof synthesisSchema>;

// ── Deterministic repair helpers ─────────────────────────────────────────────

// Agent slugs are capped so the global agent key (org_ns.workspace_ns.slug) never
// exceeds 32 chars — see the contract's slug .max(18). The model can return a
// longer slug; code clamps it here so the contract never rejects the suggestion.
const SLUG_MAX = 18;

function toKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Truncate a kebab slug to `max` chars, trimming any trailing hyphen the cut
 *  leaves behind so the result stays valid kebab-case. */
function clampSlug(slug: string, max = SLUG_MAX): string {
  if (slug.length <= max) return slug;
  return slug.slice(0, max).replace(/-+$/g, "");
}

/**
 * Append a numeric suffix until the slug no longer collides with an existing one,
 * keeping the result within the `max` budget: the base is re-truncated to leave
 * room for the `-N` suffix, so `super-long-name` + `-2` never blows past 18.
 */
function deconflictSlug(slug: string, existing: Set<string>, max = SLUG_MAX): string {
  if (!existing.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const base = clampSlug(slug, Math.max(1, max - suffix.length));
    const candidate = `${base}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
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
  // Clamp to the 18-char budget BEFORE de-conflict — the model (or a long
  // nameHint) can exceed it, and the contract would otherwise reject the output.
  const slugBase = toKebab(input.nameHint ?? object.slug) || toKebab(object.name) || "agent";
  let slug = clampSlug(slugBase);
  if (slug !== slugBase) {
    warnings.push(
      `Suggested slug "${slugBase}" exceeded the ${SLUG_MAX}-character budget; truncated to "${slug}".`,
    );
  }
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

  // Recommendations: catalog MCP servers + disabled skills the agent SHOULD have
  // but that are not available yet. Validated against the connectable candidate
  // lists; a ref that is actually already available is moved into agentTools
  // (where it belongs) rather than recommended; unknown refs are dropped.
  const connectableMcpByRef = new Map(
    candidates.connectableMcpServers.map((s) => [s.ref, s]),
  );
  const disabledSkillByRef = new Map(candidates.disabledSkills.map((s) => [s.ref, s]));
  const equippedMcp = new Set(
    agentTools.filter((t) => t.type === "mcp_server").map((t) => t.ref),
  );
  const equippedSkills = new Set(
    agentTools.filter((t) => t.type === "skill").map((t) => t.ref),
  );

  const recommendations: Array<{
    kind: "mcp_server" | "skill";
    ref: string;
    name: string;
    reason: string;
  }> = [];
  const seenRec = new Set<string>();

  for (const rec of object.recommendations ?? []) {
    const key = `${rec.kind}:${rec.ref}`;
    if (seenRec.has(key)) continue;
    seenRec.add(key);

    if (rec.kind === "mcp_server") {
      const cand = connectableMcpByRef.get(rec.ref);
      if (cand) {
        recommendations.push({ kind: "mcp_server", ref: rec.ref, name: cand.name, reason: rec.reason });
      } else if (mcpRefs.has(rec.ref)) {
        // Already registered → it is equipable, not a recommendation. Move it.
        if (!equippedMcp.has(rec.ref)) {
          agentTools.push({ type: "mcp_server", ref: rec.ref });
          equippedMcp.add(rec.ref);
        }
        warnings.push(
          `Recommended MCP server "${rec.ref}" is already registered; equipped it as a tool instead.`,
        );
      } else {
        warnings.push(
          `Dropped recommended MCP server "${rec.ref}" — it is not in the connectable catalog.`,
        );
      }
    } else {
      const cand = disabledSkillByRef.get(rec.ref);
      if (cand) {
        recommendations.push({ kind: "skill", ref: rec.ref, name: cand.name, reason: rec.reason });
      } else if (skillRefs.has(rec.ref)) {
        // Enabled skill → equipable, not a recommendation. Move it.
        if (!equippedSkills.has(rec.ref)) {
          agentTools.push({ type: "skill", ref: rec.ref });
          equippedSkills.add(rec.ref);
        }
        warnings.push(
          `Recommended skill "${rec.ref}" is enabled; equipped it as a tool instead.`,
        );
      } else {
        warnings.push(
          `Dropped recommended skill "${rec.ref}" — it is not a disabled workspace skill.`,
        );
      }
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
