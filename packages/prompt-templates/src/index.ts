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

import { parse as parseYaml } from "yaml";
import { promptTemplateSchema } from "./schema";
import type { PromptTemplate, PageContext } from "./schema";

// ---------------------------------------------------------------------------
// Built-in template YAML sources (statically bundled strings).
// Keeping them as inline imports avoids fs/path differences between
// Node (where __dirname is available) and bundlers (where it isn't).
// ---------------------------------------------------------------------------

// Each raw import returns the file contents as a string (bundler-handled).
// In Node/Vitest, we use readFileSync via a loader shim; in production Next.js
// we rely on the `yaml` webpack loader or the static string via `?raw` import
// notation. To keep the package dependency-light and universally runnable in
// Node tests, we load them lazily from the filesystem relative to this file.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TEMPLATES_DIR = resolve(__dirname, "templates");

const BUILTIN_TEMPLATE_FILES = [
  "summarize-run-failure.yaml",
  "show-similar-failed-runs.yaml",
  "open-source-playbook.yaml",
  "create-trigger-for-event.yaml",
  "connect-data-source.yaml",
  "invite-teammate.yaml",
  "explain-audit-event.yaml",
  "run-this-playbook.yaml",
  "why-is-trigger-failing.yaml",
  "summarize-workspace-activity.yaml",
] as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/** Mutable registry populated at module load and by registerTemplate(). */
const registry: PromptTemplate[] = [];

function loadBuiltins(): void {
  for (const file of BUILTIN_TEMPLATE_FILES) {
    const raw = readFileSync(resolve(TEMPLATES_DIR, file), "utf8");
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- yaml.parse returns unknown; zod validates below
    const parsed = parseYaml(raw);
    const template = promptTemplateSchema.parse(parsed);
    registry.push(template);
  }
}

// Load at module-import time (side effect, Node-only).
// In bundled/browser environments the caller must call loadBuiltins()
// explicitly or use a bundler-level YAML plugin.
try {
  loadBuiltins();
} catch {
  // Swallow in environments where fs is unavailable (e.g. Edge runtime, browser).
  // Registry will be empty until populated by registerTemplate().
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
