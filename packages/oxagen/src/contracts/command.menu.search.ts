import { z } from "zod";
import { registerCapability } from "../registry";

/**
 * command.menu.search — entity search for the Command Menu's Search section.
 *
 * Invoked when the user's Command Menu input matches an entity-prefix pattern
 * (run #, playbook, @email, etc.). Composes results from the ontology graph
 * and operational Postgres tables, each filtered by the caller's tenant grants.
 *
 * Returns up to 8 typed result rows, each with a ready-to-navigate href so the
 * client can push the route on selection without additional data fetching.
 */

/** Closed set of searchable entity kinds from spec §10. */
export const SEARCHABLE_KINDS = [
  "run",
  "principal",
  "playbook",
  "trigger",
  "event",
  "agent",
] as const;

export type SearchableKind = (typeof SEARCHABLE_KINDS)[number];

/** A single entity result row returned by command.menu.search. */
const searchResultRow = z.object({
  kind: z.enum(SEARCHABLE_KINDS).describe("Entity kind"),
  id: z.string().describe("Stable internal id (publicId or db id)"),
  label: z.string().describe("Human-readable display name"),
  /** Scope line, e.g. 'Workspace: Production' */
  scope: z.string().describe("Scope hint shown beneath the label"),
  /** One-line context: status, last activity, etc. */
  contextLine: z
    .string()
    .nullable()
    .describe("Brief additional context (status, last-run, etc.)"),
  /** Client-side navigation target — the entity's detail page. */
  href: z.string().describe("Route the menu pushes when this item is selected"),
});

export const commandMenuSearch = registerCapability({
  name: "search_command_menu",
  domain: "command",
  description:
    "Full-text entity search for the Command Menu. Accepts an optional entity-kind filter " +
    "and a query string, returns up to 8 typed rows (label, scope, contextLine, href) " +
    "composed from the ontology graph and operational Postgres tables, filtered to the " +
    "caller's tenant grants.",
  mode: "sync",
  surfaces: ["api", "agent"] as const,
  layers: ["schema", "api", "unit", "docs"],
  scoped: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  sensitivity: "low",
  mutates: false,
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z.object({
    kind: z
      .enum(SEARCHABLE_KINDS)
      .optional()
      .describe("Restrict results to a single entity kind"),
    query: z.string().min(0).max(500).describe("Free-text search string"),
    orgSlug: z
      .string()
      .min(1)
      .describe("Organization slug for href construction"),
    workspaceSlug: z
      .string()
      .min(1)
      .describe("Workspace slug for href construction"),
  }),
  output: z.object({
    rows: z.array(searchResultRow).max(8),
  }),
});

export type CommandMenuSearchInput = z.output<typeof commandMenuSearch.input>;
export type CommandMenuSearchOutput = z.output<typeof commandMenuSearch.output>;
export type SearchResultRow = z.output<typeof searchResultRow>;
