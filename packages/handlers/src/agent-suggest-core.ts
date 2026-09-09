/**
 * agent-suggest-core — shared AI-authoring core for agent definitions.
 *
 * Holds everything `agent.definition.suggest` (AI-create) and
 * `agent.definition.revise` (AI-edit) have in common: the authoring system
 * prompt, the workspace grounding candidates, the synthesis schema the model is
 * forced to, and the deterministic repair pass that drops hallucinated refs,
 * substitutes an out-of-workspace ontology, and validates the final
 * AgentDefinitionConfig.
 *
 * ADR-043 scope: Oxagen governs agents, it does not run them. A definition is
 * therefore a REGISTRY record — identity, versioned instructions, the graph
 * scope it may reason over, the memory policy it inherits, and the allowlist of
 * things it may reach (platform capabilities and registered MCP servers). There
 * are no skills, no sandboxes, no code mode and no subagents to author, so the
 * model is never shown any of that vocabulary.
 *
 * The ONLY thing the two callers own separately is the slug: `suggest` derives
 * and de-conflicts a fresh slug for a brand-new agent, whereas `revise` keeps
 * the target agent's existing (immutable) slug. So slug handling stays in the
 * callers, using the exported helpers here.
 */
import { z } from "zod";
import type { CapabilityContext } from "@oxagen/oxagen";
import { listCapabilities, getSurfaces } from "@oxagen/oxagen";
import { invoke } from "@oxagen/oxagen/kernel";
import { agentDefinitionConfigSchema } from "@oxagen/oxagen/agent-schema";
import { agentDefinitionSuggest } from "@oxagen/oxagen/contracts/agent.definition.suggest";
import type { AgentMemoryPolicyReadOutput } from "@oxagen/oxagen/contracts/agent.memory_policy.read";
import { logger } from "./logger";

/** Thrown when a suggestion/revision cannot be produced. Stable `.code` so
 *  callers can discriminate without string-matching. Shared by both the
 *  suggest and revise handlers. */
export class AgentSuggestError extends Error {
  readonly code = "agent_suggest_failed";
  constructor(message: string) {
    super(message);
    this.name = "AgentSuggestError";
  }
}

/**
 * The authoring instructions the model follows — the HOW of turning a
 * plain-language description into a valid governed-agent definition.
 *
 * This used to be loaded from a tenant-installed `create-agent` skill with an
 * embedded builtin fallback. Skills are gone (ADR-043), and a governance
 * product should not make its own authoring prompt a tenant-editable,
 * un-versioned document anyway: it is platform behaviour, so it is code, and it
 * ships identically in every bundle and every environment.
 */
export const AGENT_AUTHORING_SYSTEM_PROMPT = [
  "You design GOVERNED AGENT DEFINITIONS for Oxagen.",
  "",
  "An agent definition is a registry record, not a program. It declares WHO the",
  "agent is, WHAT knowledge it may reason over, and WHICH governed tools it may",
  "reach. Oxagen does not execute code, run sandboxes, edit repositories, or",
  "fan work out to subagents — never design for any of that, and never mention",
  "it in the instructions you write.",
  "",
  "A definition has exactly four authored parts:",
  "",
  "1. IDENTITY — a kebab-case slug, a short name, and ONE sentence saying what",
  "   the agent's job is. The description is what a human governs the agent by,",
  "   so it must state the job, not the implementation.",
  "",
  "2. INSTRUCTIONS — the system prompt. Brief and imperative: what the agent",
  "   does, the order it works in, the standards it holds to, and the boundaries",
  "   it must not cross. Say what it must refuse. Do not restate the tool list;",
  "   the allowlist already carries that.",
  "",
  "3. GRAPH ACCESS — bind the agent to ONE ontology from the candidates, choose",
  "   `read` unless the agent must propose new nodes or edges (then `extend`),",
  "   pick a retrieval strategy (`hybrid` is the sensible default), scope it to",
  "   the node/edge types that keep the agent in its lane, and set a bounded",
  "   budget (maxHops 2-3, maxNodes in the tens — never thousands).",
  "",
  "4. TOOL ALLOWLIST — the NARROWEST set of tools that does the job. Two kinds",
  "   exist and no others: `function` (one platform capability invoked through",
  "   the kernel, carrying its IAM, entitlement and metering gates) and",
  "   `mcp_server` (a registered MCP connection, governed by the workspace's",
  "   tool RBAC rules and consent ledger). Every ref MUST appear verbatim in the",
  "   candidate lists. A tool you cannot justify against the description is a",
  "   tool you must not grant.",
  "",
  "The workspace memory policy is shown for context. It is inherited, not",
  "authored: never try to change it, and do not restate its numbers in the",
  "instructions — write instructions that are correct under it (e.g. do not",
  "tell the agent to rely on observations that will have decayed).",
  "",
  "Ground every choice in the candidate lists below. Never invent a ref, an",
  "ontology id, or a capability name. Prefer granting nothing over guessing.",
].join("\n");

// ── Candidate assembly ───────────────────────────────────────────────────────

export interface Candidates {
  /** Enabled workspace graph schemas — the ontology id candidates. */
  ontologies: Array<{ id: string; displayName: string }>;
  /** Agent-surface capabilities — refs for `function` tools. */
  functions: Array<{ name: string; description: string }>;
  /** Registered MCP servers — refs (publicIds) for `mcp_server` tools. */
  mcpServers: Array<{ ref: string; name: string }>;
  /** Every existing agent slug (any status) — for slug-collision de-conflict. */
  existingSlugs: string[];
  /**
   * SECOND TIER — connect-first recommendation candidates. These are NOT
   * equipable (never in agentTools): the user must connect them first.
   *
   * Catalog MCP servers not registered in the workspace — refs are registry
   * names (e.g. "github/github-mcp-server").
   */
  connectableMcpServers: Array<{
    ref: string;
    name: string;
    description: string;
  }>;
  /** The workspace memory policy the agent inherits. Context only — never authored. */
  memoryPolicy: AgentMemoryPolicyReadOutput | null;
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
    logger.warn({ err, cap }, "agent-suggest-core: candidate source failed");
    return fallback;
  }
}

export async function assembleCandidates(
  ctx: CapabilityContext,
): Promise<Candidates> {
  const [schemaOut, mcpOut, agentOut, catalogOut, memoryPolicy] =
    await Promise.all([
      invokeSafe<{
        schemas: Array<{
          schemaName: string;
          displayName: string;
          enabled: boolean;
        }>;
      }>("list_schemas", ctx, { schemas: [] }),
      invokeSafe<{ servers: Array<{ publicId: string; name: string }> }>(
        "list_mcp_servers",
        ctx,
        { servers: [] },
      ),
      invokeSafe<{
        agents: Array<{
          slug: string;
          description: string | null;
          status: string;
        }>;
      }>("list_agent_defs", ctx, { agents: [] }),
      // Catalog MCP servers not yet installed in this workspace — recommendation
      // candidates. Ask for the not-installed slice directly; belt-and-suspenders
      // dedup against the registered list below handles registries lagging the flag.
      invokeSafe<{
        servers: Array<{
          name: string;
          title: string | null;
          description: string;
          installed: boolean;
        }>;
      }>(
        "browse_plugin_catalog",
        ctx,
        { servers: [] },
        {
          pluginType: "mcp_server",
          installed: false,
          limit: 50,
        },
      ),
      invokeSafe<AgentMemoryPolicyReadOutput | null>(
        "get_memory_policy",
        ctx,
        null,
      ),
    ]);

  const functions = listCapabilities()
    .filter((c) => getSurfaces(c).includes("agent"))
    .filter((c) => c.name !== agentDefinitionSuggest.name)
    .map((c) => ({ name: c.name, description: c.description }));

  // Catalog servers the workspace already has — matched by the catalog's canonical
  // registry NAME against installed server names/publicIds (never the display
  // title, which is an unreliable label and would over-exclude).
  const installedMcpIdentity = new Set(
    mcpOut.servers.flatMap((s) => [
      s.publicId.toLowerCase(),
      s.name.toLowerCase(),
    ]),
  );
  const connectableMcpServers = catalogOut.servers
    .filter((s) => !s.installed)
    .filter((s) => !installedMcpIdentity.has(s.name.toLowerCase()))
    .slice(0, 50)
    .map((s) => ({
      ref: s.name,
      name: s.title ?? s.name,
      description: s.description,
    }));

  return {
    ontologies: schemaOut.schemas
      .filter((s) => s.enabled)
      .map((s) => ({ id: s.schemaName, displayName: s.displayName })),
    functions,
    mcpServers: mcpOut.servers.map((s) => ({ ref: s.publicId, name: s.name })),
    existingSlugs: agentOut.agents.map((a) => a.slug),
    connectableMcpServers,
    memoryPolicy,
  };
}

export function formatCandidates(c: Candidates): string {
  const section = (title: string, lines: string[]): string =>
    lines.length
      ? `${title}:\n${lines.join("\n")}`
      : `${title}:\n(none available)`;

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
      "MCP SERVER CANDIDATES (ref for agentTools of type 'mcp_server')",
      c.mcpServers.map((m) => `- ${m.ref} — ${m.name}`),
    ),
    section(
      "INHERITED MEMORY POLICY (context only — never authored, never changed)",
      c.memoryPolicy
        ? [
            `- observation half-life: ${c.memoryPolicy.halfLifeLowDays} days`,
            `- rule half-life: ${c.memoryPolicy.halfLifeHighDays} days`,
            `- recall threshold: ${c.memoryPolicy.recallThreshold}`,
            `- compliance threshold: ${c.memoryPolicy.complianceThreshold}`,
            `- decay floor: ${c.memoryPolicy.defaultDecayFloor}`,
          ]
        : [],
    ),
    // SECOND TIER. Deliberately fenced off from the equipable candidate lists
    // above: these do not exist in the workspace yet, so they can only be
    // RECOMMENDED (returned in `recommendations`), never equipped (`agentTools`).
    [
      "CONNECTABLE (recommendations ONLY — these are NOT equipable; never put them in agentTools).",
      "Recommend one when the description clearly needs it, with a reason tied to the description.",
      "The caller connects the MCP server first, then equips it in a later edit.",
    ].join("\n"),
    section(
      "CATALOG MCP SERVERS (recommend with kind 'mcp_server'; ref = the registry name shown)",
      c.connectableMcpServers.map(
        (s) => `- ${s.ref} — ${s.name}: ${s.description}`,
      ),
    ),
  ].join("\n\n");
}

/** Assemble the shared system prompt: the authoring instructions + strictly-fenced
 *  workspace candidates. Identical for suggest and revise — only the user prompt
 *  differs between the two. */
export function buildAgentSystemPrompt(candidates: Candidates): string {
  return [
    AGENT_AUTHORING_SYSTEM_PROMPT,
    "",
    "---",
    "",
    "WORKSPACE CANDIDATES — you may ONLY reference items that appear below. Never invent a ref, ontology id, capability, or MCP server.",
    "",
    formatCandidates(candidates),
  ].join("\n");
}

// ── Synthesis schema (mirrors the contract suggestion object) ────────────────

export const synthesisSchema = z.object({
  slug: z
    .string()
    .describe(
      "Lowercase kebab-case slug derived from the agent's job, e.g. 'docs-drift-watcher'.",
    ),
  name: z.string().min(1).describe("Short human-readable name — a few words."),
  description: z
    .string()
    .min(1)
    .describe(
      "ONE sentence stating the agent's job; drives routing and agent selection.",
    ),
  instructions: z
    .string()
    .min(1)
    .describe(
      "The system prompt: what the agent does, its working order, standards, and boundaries. Brief and imperative.",
    ),
  graph: z
    .object({
      ontologyId: z
        .string()
        .describe(
          "MUST be one of the ONTOLOGY CANDIDATE ids, or an empty string if none fit.",
        ),
      mode: z
        .enum(["read", "extend"])
        .describe(
          "'read' by default; 'extend' only when the agent must propose new nodes/edges.",
        ),
      retrieval: z.object({
        strategy: z
          .enum(["semantic", "lexical", "hybrid", "explicit"])
          .describe("Entry-node strategy; 'hybrid' is the sensible default."),
        scopeToTypes: z
          .array(z.string())
          .optional()
          .describe(
            "Node/edge types that keep the agent in its lane; omit only if it needs all types.",
          ),
      }),
      budget: z.object({
        maxHops: z
          .number()
          .int()
          .nonnegative()
          .describe("Max hops from an entry node; 2–3 typical."),
        maxNodes: z
          .number()
          .int()
          .positive()
          .describe(
            "Max nodes pulled into context; a bounded cap (tens, not thousands).",
          ),
        minRelevance: z
          .number()
          .min(0)
          .max(1)
          .optional()
          .describe("Minimum relevance (0–1) for semantic/hybrid strategies."),
      }),
    })
    .describe(
      "Graph access: ontology binding, write posture, retrieval, and budget.",
    ),
  agentTools: z
    .array(
      z.object({
        type: z.enum(["function", "mcp_server"]).describe("The kind of tool."),
        ref: z
          .string()
          .describe(
            "Reference matching the type: a capability name (function) or a registered MCP server id (mcp_server). MUST come from the candidate lists.",
          ),
      }),
    )
    .describe(
      "The narrowest uniform tool list that does the job. ONLY refs from the candidate lists.",
    ),
  recommendations: z
    .array(
      z.object({
        ref: z
          .string()
          .describe(
            "The EXACT registry name from the CATALOG MCP SERVERS list. Never invent one; never a ref from the equipable candidate lists.",
          ),
        name: z
          .string()
          .describe(
            "The human-readable name shown for it in the CATALOG MCP SERVERS list.",
          ),
        reason: z
          .string()
          .describe(
            "Why THIS agent needs it, phrased against the user's description (e.g. 'answers questions about open PRs — needs GitHub access'). One sentence.",
          ),
      }),
    )
    .optional()
    .describe(
      "MCP servers the agent SHOULD have that are not connected to the workspace yet. NEVER equip these (never in agentTools); the caller connects them first. Omit anything already registered; equip that instead.",
    ),
  rationale: z
    .string()
    .min(1)
    .describe(
      "Why this configuration — instructions framing, tool selection, and graph scoping.",
    ),
});

export type Synthesis = z.infer<typeof synthesisSchema>;
export type AgentDefinitionConfig = z.infer<typeof agentDefinitionConfigSchema>;

/**
 * A connect-first recommendation. `kind` is always `"mcp_server"`: an MCP
 * connection is the only thing a governed agent can be granted that the
 * workspace might not have yet. The field is retained (rather than dropped)
 * because both contracts' output schemas still carry it.
 */
export type Recommendation = {
  kind: "mcp_server";
  ref: string;
  name: string;
  reason: string;
};

// ── Deterministic repair helpers ─────────────────────────────────────────────

// Agent slugs are capped so the global agent key (org_ns.workspace_ns.slug) never
// exceeds 32 chars — see the contract's slug .max(18). The model can return a
// longer slug; code clamps it here so the contract never rejects the suggestion.
export const SLUG_MAX = 18;

export function toKebab(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Truncate a kebab slug to `max` chars, trimming any trailing hyphen the cut
 *  leaves behind so the result stays valid kebab-case. */
export function clampSlug(slug: string, max = SLUG_MAX): string {
  if (slug.length <= max) return slug;
  return slug.slice(0, max).replace(/-+$/g, "");
}

/**
 * Append a numeric suffix until the slug no longer collides with an existing one,
 * keeping the result within the `max` budget: the base is re-truncated to leave
 * room for the `-N` suffix, so `super-long-name` + `-2` never blows past 18.
 */
export function deconflictSlug(
  slug: string,
  existing: Set<string>,
  max = SLUG_MAX,
): string {
  if (!existing.has(slug)) return slug;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const base = clampSlug(slug, Math.max(1, max - suffix.length));
    const candidate = `${base}${suffix}`;
    if (!existing.has(candidate)) return candidate;
  }
}

export interface RepairResult {
  /** The validated AgentDefinitionConfig, ready to feed create/update input. */
  config: AgentDefinitionConfig;
  /** Connect-first recommendations that survived validation. */
  recommendations: Recommendation[];
}

/**
 * Deterministic validation + repair of a raw model synthesis, shared by suggest
 * and revise. Drops tool/recommendation refs that don't exist in the workspace,
 * substitutes an out-of-workspace ontology, and finally parses the result as a
 * real AgentDefinitionConfig (throws AgentSuggestError if it still fails).
 * Appends any adjustments it made to `warnings` (mutated in place). Slug
 * handling is intentionally NOT here — each caller owns its slug policy
 * (create de-conflicts a new slug; revise keeps the agent's immutable one).
 */
export function repairSynthesis(
  object: Synthesis,
  candidates: Candidates,
  warnings: string[],
): RepairResult {
  const functionRefs = new Set(candidates.functions.map((f) => f.name));
  const mcpRefs = new Set(candidates.mcpServers.map((m) => m.ref));
  const ontologyIds = new Set(candidates.ontologies.map((o) => o.id));

  // Tools: drop any ref not present in the candidate list for its type.
  const agentTools: Array<{
    type: Synthesis["agentTools"][number]["type"];
    ref: string;
  }> = [];
  for (const tool of object.agentTools) {
    const known =
      tool.type === "function"
        ? functionRefs.has(tool.ref)
        : mcpRefs.has(tool.ref);
    if (known) {
      agentTools.push({ type: tool.type, ref: tool.ref });
    } else {
      warnings.push(
        `Removed ${tool.type} tool "${tool.ref}" — it does not exist in this workspace.`,
      );
    }
  }

  // Recommendations: catalog MCP servers the agent SHOULD have but that are not
  // connected yet. Validated against the connectable candidate list; a ref that
  // is actually already registered is moved into agentTools (where it belongs)
  // rather than recommended; unknown refs are dropped.
  const connectableMcpByRef = new Map(
    candidates.connectableMcpServers.map((s) => [s.ref, s]),
  );
  const equippedMcp = new Set(
    agentTools.filter((t) => t.type === "mcp_server").map((t) => t.ref),
  );

  const recommendations: Recommendation[] = [];
  const seenRec = new Set<string>();

  for (const rec of object.recommendations ?? []) {
    if (seenRec.has(rec.ref)) continue;
    seenRec.add(rec.ref);

    const cand = connectableMcpByRef.get(rec.ref);
    if (cand) {
      recommendations.push({
        kind: "mcp_server",
        ref: rec.ref,
        name: cand.name,
        reason: rec.reason,
      });
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
    instructions: object.instructions,
  };

  // Final gate: the synthesis must parse as a real AgentDefinitionConfig so it
  // can be fed straight into agent.definition.create / .update without reshaping.
  let config: AgentDefinitionConfig;
  try {
    config = agentDefinitionConfigSchema.parse(draftConfig);
  } catch (err) {
    logger.error(
      { err },
      "agent-suggest-core: synthesised config failed final validation",
    );
    throw new AgentSuggestError(
      `Synthesised configuration failed validation: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return { config, recommendations };
}
