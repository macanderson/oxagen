import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * command.menu.suggest — LLM-powered "Suggested for this page" section.
 *
 * Accepts a SuggestionContext describing the user's current page (route, entity,
 * recent history, effective capabilities) and returns 3–5 short, verb-first
 * prompts that an Oxagen agent can answer.
 *
 * Privacy rules (from spec §7):
 *   - Only entity.summary is sent to the LLM, never the full record body.
 *   - When the org has opted out (suggest_llm_enabled = false in org settings),
 *     the handler returns [] without calling the LLM.
 *   - Suggestion content is NOT persisted (audit logs the act of calling, not
 *     the content of what was returned).
 */

/** Reference to a recently-visited entity (for context). */
const entityRef = z.object({
  kind: z.string(),
  id: z.string(),
  label: z.string().optional(),
});

/**
 * Full suggestion context sent from the client. Must NOT include raw record
 * bodies — only metadata and the entity summary.
 */
const suggestionContext = z.object({
  /** The current route, e.g. '/acme/prod/activity/runs/run_4221'. */
  route: z.string().max(2000),
  /** Extracted route params, e.g. { runId: 'run_4221' }. */
  routeParams: z.record(z.string()).default({}),
  /** Current query string params, e.g. { tab: 'trace' }. */
  queryParams: z.record(z.string()).default({}),
  /** The entity the page is "about", if registered via useRegisterPageEntity. */
  pageEntity: z
    .object({
      kind: z.string(),
      id: z.string(),
      publicId: z.string().optional(),
      /** Human-readable display name. */
      label: z.string().optional(),
      /**
       * 1-2 sentence machine summary — the ONLY entity data sent to the LLM.
       * Page authors must ensure summary contains no PII or sensitive fields.
       */
      summary: z.string().max(500).optional(),
    })
    .optional(),
  /** Last 5 entities visited in this session. */
  recentEntities: z.array(entityRef).max(5).default([]),
  /** User's effective capability ids at the current scope. */
  capabilities: z.array(z.string()).max(200).default([]),
  /** BCP-47 locale string, e.g. 'en' or 'en-US'. */
  locale: z.string().max(20).default("en"),
});

/** A single LLM-generated suggestion prompt. */
const suggestion = z.object({
  /** Verb-first, 5–12 words. E.g. "Summarize this run's failure". */
  text: z.string().min(3).max(200),
  /**
   * Semantic category for icon/grouping.
   * Mirrors PromptTemplate.category from spec §6.
   */
  category: z.enum([
    "create",
    "investigate",
    "configure",
    "communicate",
    "analyze",
  ]),
  /** LLM confidence in this suggestion's relevance (0–1). */
  confidence: z.number().min(0).max(1),
});

export const commandMenuSuggest = registerCapability({
  name: "suggest_commands",
  domain: "command",
  description:
    "Generate 3–5 context-aware 'Suggested for this page' prompts for the Command Menu " +
    "using a fast/cheap LLM tier. Accepts SuggestionContext (route, page entity summary, " +
    "recent entities, effective capabilities). Returns [] when the org has opted out of " +
    "LLM suggestions. Privacy: only entity.summary is sent to the model.",
  mode: "sync",
  surfaces: ["api", "agent"] as const,
  layers: ["schema", "api", "unit", "docs", "app"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: suggestionContext,
  output: z.object({
    suggestions: z.array(suggestion).min(0).max(5),
  }),
});

export type CommandMenuSuggestInput = z.output<typeof commandMenuSuggest.input>;
export type CommandMenuSuggestOutput = z.output<
  typeof commandMenuSuggest.output
>;
export type SuggestionContext = z.output<typeof suggestionContext>;
export type Suggestion = z.output<typeof suggestion>;
