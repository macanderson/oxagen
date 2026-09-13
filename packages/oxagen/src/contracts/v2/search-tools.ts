import { z } from "zod";
import { defineTool } from "./_define";
import { SEARCHABLE_KINDS, commandMenuSearch } from "../command.menu.search";
import { commandMenuSuggest } from "../command.menu.suggest";

const suggestInput = commandMenuSuggest.input.shape;

/**
 * Appendix E: `search_tools` — "belt search meta-tool; also the UI's command
 * menu". Absorbs `search_command_menu` and `suggest_commands`.
 *
 * **Two callers, one index, and that is deliberate.** §6.6 defines
 * `search_tools(query, kinds?)` as one of the two meta-tools a model gets when
 * its belt outgrows the full-definition mode: it "returns names and one-line
 * descriptions ranked by relevance, from an index over the belt only". The
 * Command Menu asks the same question of entities. Appendix E folds them
 * because the ranking, the tenant filter and the eight-row budget are the same
 * machinery — and because the §6.6 guarantee ("a search never returns a tool
 * outside the belt … what the model cannot call, it cannot find, so it cannot
 * be prompt-injected into calling it") must hold on *every* path into the
 * index, which is easiest to prove when there is only one.
 *
 * **`kind` becomes `kinds`, and gains `tool`.** §6.6 spells the parameter
 * plural; v1's single-value `kind` could not express "tools and runs". The
 * member list is carried by import from `SEARCHABLE_KINDS` and extended with
 * the one kind the belt search needs.
 *
 * **The suggestion context is cut down hard.** `suggest_commands` took the
 * client's route params, query params, recent-entity trail, effective
 * capability ids and locale. Only the parts that steer the model survive; the
 * rest are dropped below with reasons, of which `capabilities` is the one worth
 * reading — a client asserting its own capability list is a claim the server
 * must not believe.
 */
export const searchTools = defineTool({
  name: "search_tools",
  domain: "tools",
  description:
    "Rank-search the caller's toolbelt and the workspace's entities from one index, returning at most eight rows with names, one-line descriptions and navigable hrefs. A search never returns a tool outside the belt (§6.6). Optionally drafts context-aware prompt suggestions for the current page.",
  mode: "sync",
  surfaces: ["api", "agent"] as const,
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,

  absorbs: ["search_command_menu", "suggest_commands"],
  drops: [
    {
      field: "routeParams",
      from: "suggest_commands",
      why: "redundant with `route`, which the handler already parses; two copies of the same fact let a caller disagree with itself about which entity the page is on",
    },
    {
      field: "queryParams",
      from: "suggest_commands",
      why: "same redundancy, and a query string is the likeliest place for a caller to paste something that should never reach a model",
    },
    {
      field: "recentEntities",
      from: "suggest_commands",
      why: "the visit trail is reconstructible server-side from the caller's own audit rows; taking it from the client added a second, unverifiable source for the same list",
    },
    {
      field: "capabilities",
      from: "suggest_commands",
      why: "client-asserted effective capabilities: §6.6's guarantee is that search returns nothing outside the belt, and a belt computed from what the caller claims it can do is not a belt — the gateway resolves grants itself",
    },
    {
      field: "confidence",
      from: "suggest_commands",
      why: "per-suggestion model confidence was never rendered and is not comparable between model tiers (§8); rank order already carries it",
    },
  ],

  // Both sources agree exactly: no approval, low risk, read.
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  defaultEffect: "deny",
  // Both sources spelled an org `Member` grant, which `SystemOrgRole`
  // (Owner | Admin | Compliance | Billing) does not have — it granted nothing,
  // so it is dropped rather than reproduced. The workspace side, where the
  // Command Menu is actually used, carries in full including Viewer.
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  /**
   * `mutates` is deliberately ABSENT, which means it mutates.
   *
   * `search_command_menu` declared `mutates: false` and its handler is a plain
   * read, so half of this tool is clean. `suggest_commands` declared nothing,
   * and that omission is correct: drafting suggestions calls a model through
   * the metered @oxagen/ai chokepoint, and metered usage is a write. Since the
   * suggestion half is optional per call, the honest declaration for the union
   * is the conservative default rather than a `false` that is only true when
   * `pageContext` is omitted.
   */

  input: z.object({
    // Carried by reference: min 0 (an empty query is the menu's just-opened
    // state) and the 500-char ceiling that keeps a hostile query out of the
    // ranking cost.
    query: commandMenuSearch.input.shape.query,

    /**
     * §6.6 spells this parameter plural. Members come from v1's
     * `SEARCHABLE_KINDS` plus `tool`, which is the kind the belt meta-tool
     * searches for and which no v1 contract had — the Command Menu predates
     * the belt.
     */
    kinds: z
      .array(z.enum([...SEARCHABLE_KINDS, "tool"] as const))
      .nonempty()
      .optional()
      .describe("Restrict results to these kinds; omit to search all"),

    // Carried from `search_command_menu`: the menu pushes a route on selection,
    // and building the href server-side is what saves the client a second
    // fetch. Required for the same reason it was in v1 — an href without them
    // is not navigable.
    orgSlug: commandMenuSearch.input.shape.orgSlug,
    workspaceSlug: commandMenuSearch.input.shape.workspaceSlug,

    /**
     * Present only when the caller wants the "Suggested for this page" section;
     * omit it and this is a pure belt/entity search. The two members carried
     * are the two §7's privacy rule actually allows near a model: the route,
     * and the page entity whose `summary` field is documented as the only
     * entity data that is ever sent.
     */
    pageContext: z
      .object({
        route: suggestInput.route,
        pageEntity: suggestInput.pageEntity,
        locale: suggestInput.locale,
      })
      .optional(),
  }),

  output: z.object({
    // Carried whole, cap included: §6.6's searchable belt is a ranked shortlist,
    // and eight is the budget both the menu and a model request were built for.
    rows: commandMenuSearch.output.shape.rows,

    /**
     * Empty when `pageContext` was omitted, and also when the org has opted out
     * of LLM suggestions — `suggest_commands` returns `[]` without calling the
     * model in that case, and that behaviour carries unchanged.
     */
    suggestions: z
      .array(
        z.object({
          text: commandMenuSuggest.output.shape.suggestions.element.shape.text,
          category:
            commandMenuSuggest.output.shape.suggestions.element.shape.category,
        }),
      )
      .max(5)
      .default([]),
  }),
});

export type SearchToolsInput = z.output<typeof searchTools.input>;
export type SearchToolsOutput = z.output<typeof searchTools.output>;
