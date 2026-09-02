/**
 * render.ts — Safe Mustache-style template rendering.
 *
 * Substitutes {{variableName}} placeholders in a template body with resolved
 * values. No eval, no loops, no conditionals — static text + variable
 * interpolation only (per spec §6 safety requirement).
 *
 * Variable names must be alphanumeric + underscores. Any unrecognised pattern
 * inside {{ }} is left as-is (defensive: don't silently strip unrecognised
 * syntax).
 */

/** Allowlisted variable name pattern: word characters only. */
const VAR_NAME_RE = /^[a-zA-Z_]\w*$/;

/** Global regex that matches every {{variableName}} token in the template. */
const TEMPLATE_TOKEN_RE = /\{\{([^}]+)\}\}/g;

export type RenderVariables = Record<string, string>;

export interface RenderResult {
  /** The rendered prompt string. */
  rendered: string;
  /**
   * Names of variables that appeared in the template but were not present
   * in the supplied `variables` map.
   */
  missing: string[];
}

/**
 * Render a template body by substituting {{name}} tokens with values from
 * the `variables` map.
 *
 * @param body      The raw template body string.
 * @param variables Map of variable name → resolved string value.
 * @returns         Rendered text and a list of any missing variables.
 *
 * @example
 * const { rendered, missing } = renderTemplate(
 *   "Summarize run {{run_id}} in workspace {{workspace}}.",
 *   { run_id: "run_4221" }
 * );
 * // rendered: "Summarize run run_4221 in workspace {{workspace}}."
 * // missing: ["workspace"]
 */
export function renderTemplate(
  body: string,
  variables: RenderVariables,
): RenderResult {
  const missing: string[] = [];

  const rendered = body.replace(
    TEMPLATE_TOKEN_RE,
    (_match, rawName: string) => {
      const name = rawName.trim();
      // Only substitute if the name is an allowed identifier.
      if (!VAR_NAME_RE.test(name)) {
        // Unknown syntax — leave as-is.
        return _match;
      }
      if (Object.prototype.hasOwnProperty.call(variables, name)) {
        return variables[name] ?? "";
      }
      missing.push(name);
      // Leave the placeholder in place so the user can see what's missing.
      return _match;
    },
  );

  return { rendered, missing };
}

/**
 * Resolve the variables for a template from the current page context.
 *
 * Returns a map of resolved values and a list of variable names that could not
 * be resolved. The caller decides whether to hide the template (for required
 * variables) or render with placeholders (for optional ones).
 */
export function resolveVariables(
  variables: Array<{
    name: string;
    resolver: "param" | "query" | "session" | "page" | "ask";
    source: string;
    required: boolean;
  }>,
  context: {
    routeParams?: Record<string, string>;
    queryParams?: Record<string, string>;
    pageEntity?: {
      kind?: string;
      id?: string;
      label?: string;
      summary?: string;
    };
    session?: Record<string, string>;
  },
): { resolved: RenderVariables; unresolved: string[] } {
  const resolved: RenderVariables = {};
  const unresolved: string[] = [];

  for (const variable of variables) {
    let value: string | undefined;

    if (variable.resolver === "param") {
      // source = "params.runId" → look up routeParams["runId"]
      const key = variable.source.replace(/^params\./, "");
      value = context.routeParams?.[key];
    } else if (variable.resolver === "query") {
      // source = "query.tab" → look up queryParams["tab"]
      const key = variable.source.replace(/^query\./, "");
      value = context.queryParams?.[key];
    } else if (variable.resolver === "session") {
      // source = "session.user.id" → look up session["user.id"] (flat)
      const key = variable.source.replace(/^session\./, "");
      value = context.session?.[key];
    } else if (variable.resolver === "page") {
      // source = "page.entity.label" → look up pageEntity.label.
      // Only these four sources are recognised; anything else stays undefined.
      if (variable.source === "page.entity.id") value = context.pageEntity?.id;
      else if (variable.source === "page.entity.kind")
        value = context.pageEntity?.kind;
      else if (variable.source === "page.entity.label")
        value = context.pageEntity?.label;
      else if (variable.source === "page.entity.summary")
        value = context.pageEntity?.summary;
    } else if (variable.resolver === "ask") {
      // "ask" resolver means prompt the user at invocation time — mark as
      // unresolved for now; the UI shows a follow-up dialog.
      unresolved.push(variable.name);
      continue;
    }

    if (value !== undefined) {
      resolved[variable.name] = value;
    } else if (variable.required) {
      unresolved.push(variable.name);
    }
  }

  return { resolved, unresolved };
}
