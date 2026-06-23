/**
 * index.ts — prompt-template registry.
 *
 * Loads built-in YAML templates at module-import time (sync, via statically
 * bundled imports — no runtime fs reads required in the browser).
 *
 * Public API:
 *   getAllTemplates()         — all registered templates
 *   getApplicableTemplates(context) — filtered + ranked for the current page
 *   registerTemplate(t)      — add a runtime-injected template (tests / future)
 */

import { promptTemplateSchema } from "./schema";
import type { PromptTemplate, PageContext } from "./schema";
import { BUILTIN_TEMPLATE_DATA } from "./built-in-templates";

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Mutable registry populated at module load and by registerTemplate(). */
const registry: PromptTemplate[] = [];

// Built-in templates are inlined as static data (src/built-in-templates.ts,
// generated from src/templates/*.yaml at author time) and validated through the
// schema here. This deliberately avoids reading YAML from node:fs at runtime —
// this module is imported by the "use client" ⌘K Command Menu, and a node:fs
// reference would pull Node built-ins into the browser bundle and break the
// Turbopack build. zod validation runs fine in every runtime.
for (const data of BUILTIN_TEMPLATE_DATA) {
  registry.push(promptTemplateSchema.parse(data));
}

/**
 * Register an additional template at runtime.
 * Useful for tests or future user-defined templates.
 * If a template with the same id already exists, it is replaced.
 */
export function registerTemplate(template: PromptTemplate): void {
  const idx = registry.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    registry[idx] = template;
  } else {
    registry.push(template);
  }
}

/** Return all registered templates (built-ins + runtime-registered). */
export function getAllTemplates(): PromptTemplate[] {
  return [...registry];
}

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

/**
 * Match a pathname against a routePattern.
 *
 * Pattern syntax:
 *   - {org} / {ws}   → named placeholder (curly-brace style from spec)
 *   - :param         → Express-style named param
 *   - *              → wildcard single segment
 *   - **             → wildcard suffix (any number of segments)
 *   - empty string   → matches nothing
 */
export function matchesRoute(pattern: string, pathname: string): boolean {
  if (!pattern) return false;
  // Normalise trailing slashes.
  const normPath = pathname.replace(/\/$/, "");
  const normPattern = pattern.replace(/\/$/, "");

  // Build the regex by tokenising the pattern left-to-right so that ** is
  // handled before * and named placeholders don't collide with special chars.
  //
  // Tokens (in priority order):
  //   **               → .* (any suffix, including path separators)
  //   {word} or :word  → [^/]+ (any single URL segment)
  //   *                → [^/]+ (any single URL segment)
  //   literal chars    → regex-escaped
  const TOKEN_RE = /\*\*|[{][^}]+[}]|:[a-zA-Z_]\w*|\*|[^*:{}/]+|[/]/g;
  let regexStr = "";
  for (const token of normPattern.matchAll(TOKEN_RE)) {
    const t = token[0];
    if (t === "**") {
      regexStr += ".*";
    } else if (t.startsWith("{") || t.startsWith(":")) {
      regexStr += "[^/]+";
    } else if (t === "*") {
      regexStr += "[^/]+";
    } else {
      // Escape literal regex metacharacters.
      regexStr += t.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }

  const re = new RegExp(`^${regexStr}$`);
  return re.test(normPath);
}

// ---------------------------------------------------------------------------
// Context-based filtering
// ---------------------------------------------------------------------------

/**
 * Given the current page context, return the subset of registered templates
 * that apply, in ranked order (max 6 per spec §8).
 *
 * Filtering rules (all must pass):
 *   1. At least one ContextMatcher's routePattern matches the current pathname.
 *   2. All required variables can be resolved from the context.
 *   3. If the template declares a capability, the user must have it.
 *
 * Ranking:
 *   - Templates with more specific route patterns (longer pattern string) rank
 *     higher — entity-specific actions surface above workspace-wide ones.
 *   - Within equal specificity, order of registration (built-in file order) is
 *     preserved.
 */
export function getApplicableTemplates(
  context: PageContext,
  options: {
    /** Hard cap; defaults to 6 per spec §8. */
    limit?: number;
  } = {},
): PromptTemplate[] {
  const limit = options.limit ?? 6;
  const { pathname, routeParams, queryParams, pageEntity, capabilities } = context;

  const candidates: Array<{ template: PromptTemplate; specificity: number }> = [];

  for (const template of registry) {
    // 1. Route matching — at least one matcher must match.
    const matchingRoute = template.applicableTo.find((m) =>
      matchesRoute(m.routePattern, pathname),
    );
    if (!matchingRoute) continue;

    // 2. Capability gate — user must have the declared capability.
    if (template.capability && !capabilities.includes(template.capability)) continue;

    // 3. Required variable resolution.
    const unresolvable = template.variables
      .filter((v) => v.required && v.resolver !== "ask")
      .filter((v) => {
        if (v.resolver === "param") {
          const key = v.source.replace(/^params\./, "");
          return routeParams[key] === undefined;
        }
        if (v.resolver === "query") {
          const key = v.source.replace(/^query\./, "");
          return queryParams[key] === undefined;
        }
        if (v.resolver === "page") {
          if (!pageEntity) return true;
          if (v.source === "page.entity.id") return !pageEntity.id;
          if (v.source === "page.entity.kind") return !pageEntity.kind;
          if (v.source === "page.entity.label") return pageEntity.label === undefined;
          if (v.source === "page.entity.summary") return pageEntity.summary === undefined;
          return true;
        }
        return false;
      });
    if (unresolvable.length > 0) continue;

    // Specificity: longer route pattern = more specific.
    const specificity = matchingRoute.routePattern.length;
    candidates.push({ template, specificity });
  }

  // Sort by specificity descending, then by original registry order (stable).
  candidates.sort((a, b) => b.specificity - a.specificity);

  return candidates.slice(0, limit).map((c) => c.template);
}

// Re-export types and schema for consumers.
export type { PromptTemplate, PageContext, TemplateVariable, ContextMatcher } from "./schema";
export { promptTemplateSchema, pageContextSchema, templateVariableSchema, contextMatcherSchema } from "./schema";
export { renderTemplate, resolveVariables } from "./render";
export type { RenderResult, RenderVariables } from "./render";
