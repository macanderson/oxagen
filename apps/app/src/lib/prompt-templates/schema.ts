/**
 * schema.ts — Zod schemas for the prompt-template registry.
 *
 * Mirrors the spec in docs/specs/command-menu/spec.md §6.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// TemplateVariable
// ---------------------------------------------------------------------------

export const templateVariableSchema = z.object({
  /** Variable name, used as {{name}} in the template body. */
  name: z.string().min(1),
  /**
   * How to resolve the variable from the current page context.
   *  param   — from a URL route param (e.g. params.runId)
   *  query   — from a query-string param (e.g. query.tab)
   *  session — from the current user session (e.g. session.user.id)
   *  page    — from the page-registered entity (e.g. page.entity.name)
   *  ask     — prompt the user inline before sending
   */
  resolver: z.enum(["param", "query", "session", "page", "ask"]),
  /**
   * Dot-path describing where to find the value within the resolver's
   * namespace, e.g. "params.runId" or "page.entity.label".
   */
  source: z.string().min(1),
  /** If true and the variable cannot be resolved, the template is hidden. */
  required: z.boolean(),
});

export type TemplateVariable = z.infer<typeof templateVariableSchema>;

// ---------------------------------------------------------------------------
// ContextMatcher
// ---------------------------------------------------------------------------

export const contextMatcherSchema = z.object({
  /**
   * Route pattern using Express-style colon params.
   * e.g. "/{org}/{ws}/activity/runs/:runId"
   *
   * A wildcard "*" matches any single segment; "**" matches any suffix.
   * An empty routePattern matches all routes (use for universal templates).
   */
  routePattern: z.string(),
  /** Optional scope restriction. Omit for templates valid at all scopes. */
  scope: z.enum(["org", "workspace", "account"]).optional(),
});

export type ContextMatcher = z.infer<typeof contextMatcherSchema>;

// ---------------------------------------------------------------------------
// PromptTemplate
// ---------------------------------------------------------------------------

export const promptTemplateSchema = z.object({
  /** Stable kebab-case identifier, unique across the registry. */
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, "id must be kebab-case"),
  /** Short human label shown in the Command Menu. */
  title: z.string().min(1),
  /** One-sentence description shown as tooltip / secondary text. */
  description: z.string().min(1),
  /**
   * Functional category — drives the icon shown next to the template.
   *  create       — create a new entity
   *  investigate  — explore or diagnose
   *  configure    — change settings or wiring
   *  communicate  — send messages, notify, invite
   *  analyze      — report, summarize, trend
   */
  category: z.enum([
    "create",
    "investigate",
    "configure",
    "communicate",
    "analyze",
  ]),
  /** Tags for future filtering / search. */
  tags: z.array(z.string()).default([]),
  /**
   * Routes where this template is offered.
   * Multiple matchers = template offered on any matching route (union, not
   * intersection). An empty array means the template never shows.
   */
  applicableTo: z.array(contextMatcherSchema).min(1),
  /**
   * Capability slug required to invoke the template.
   * Omit for templates available to all users regardless of capability.
   */
  capability: z.string().optional(),
  /**
   * If true, after rendering the template is submitted to the agent
   * immediately without the user needing to press Enter.
   */
  autoSubmit: z.boolean(),
  /**
   * Optional keyboard shortcut assigned to this template (e.g. "⌘+E").
   * Must be unique across all loaded templates (CI enforces this).
   */
  shortcut: z.string().optional(),
  /**
   * Mustache-style template body using {{variableName}} interpolation.
   * No conditional logic or loops — keep complexity in the agent, not here.
   */
  body: z.string().min(1),
  /** Variable definitions — each {{name}} in body must have a matching entry. */
  variables: z.array(templateVariableSchema).default([]),
});

export type PromptTemplate = z.infer<typeof promptTemplateSchema>;

/**
 * Pre-parse shape of a PromptTemplate: fields with schema defaults (tags,
 * variables) are optional. This is the type of the statically bundled built-in
 * template data (built-in-templates.ts), which holds raw authored values before
 * promptTemplateSchema.parse() applies defaults at registry load.
 */
export type PromptTemplateInput = z.input<typeof promptTemplateSchema>;

// ---------------------------------------------------------------------------
// Page context shape (consumed by getApplicableTemplates)
// ---------------------------------------------------------------------------

/**
 * PageContext — the runtime context the Command Menu provides when asking
 * which templates apply to the current page.
 *
 * Mirrors SuggestionContext from spec §7, trimmed to what the template
 * registry needs (no LLM-related fields).
 */
export const pageContextSchema = z.object({
  /** Current pathname, e.g. "/acme/prod/activity/runs/run_4221" */
  pathname: z.string(),
  /** Route params extracted from the URL, e.g. { runId: "run_4221" } */
  routeParams: z.record(z.string(), z.string()).default({}),
  /** Query-string params, e.g. { tab: "trace" } */
  queryParams: z.record(z.string(), z.string()).default({}),
  /** Page-registered entity, if any. */
  pageEntity: z
    .object({
      kind: z.string(),
      id: z.string(),
      label: z.string().optional(),
      summary: z.string().optional(),
    })
    .optional(),
  /** Effective capability slugs for the current user at this scope. */
  capabilities: z.array(z.string()).default([]),
  /** BCP-47 locale, e.g. "en-US". */
  locale: z.string().default("en"),
});

export type PageContext = z.infer<typeof pageContextSchema>;
