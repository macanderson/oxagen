/**
 * `search_tools`: the belt search meta-tool, and the ⌘K search over the
 * workspace's own records (MC spec App. E, §6.6). One ranked index, at most
 * eight rows, four kinds:
 *
 * - `tool`: capabilities the in-app agent may call — the contracts exposed
 *   on the `agent` surface, ranked by name and description. Inside a turn
 *   the engine-facing twin of this search reads the materialised set, so
 *   what the model cannot call it cannot find; here the same rule holds
 *   over the registry.
 * - `run`: the workspace's runs by public id or goal, the in-app agent's own
 *   turns excluded as in `list_runs`.
 * - `agent`: the workspace's agents by slug or name.
 * - `approval`: pending approvals by id or the capability they parked.
 *
 * Rows carry ids, never hrefs: the app builds every navigation target from
 * a typed route builder (apps/app/ARCHITECTURE.md INV-13), so a server-built
 * path would be a second source for the same route.
 *
 * A console read is never a governed action (ADR-052 exclusion 2):
 * `noBillingGate: true`. Ontology is out of scope: nothing here reads the
 * graph.
 */
import { z } from "zod";
import { registerCapability } from "../registry";

export const SEARCH_KINDS = ["tool", "run", "agent", "approval"] as const;
export const SEARCH_ROW_LIMIT = 8;

export const searchRowSchema = z
  .object({
    kind: z.enum(SEARCH_KINDS),
    /** A public id (`arun_…`, `tse_…`, `agt_…`, `apr_…`) or a capability name. */
    id: z.string().min(1),
    label: z.string().min(1),
    /** One line of context: a status, a description, an expiry. Null when the row has none. */
    contextLine: z.string().nullable(),
  })
  .strict();

export const toolsSearch = registerCapability({
  name: "search_tools",
  domain: "tools",
  description:
    "Rank-search the capabilities the in-app agent may call and the workspace's runs, agents and pending approvals from one index; at most eight rows with ids the caller navigates from.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  mutates: false,
  noBillingGate: true,
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  agent: { requiresApproval: false, riskLevel: "low", category: "read" },
  input: z
    .object({
      /** Empty is the menu's just-opened state: the newest rows of each kind. */
      query: z.string().max(500).default(""),
      /** Omit to search every kind. */
      kinds: z.array(z.enum(SEARCH_KINDS)).nonempty().optional(),
    })
    .strict(),
  output: z
    .object({
      rows: z.array(searchRowSchema).max(SEARCH_ROW_LIMIT),
    })
    .strict(),
});

export type ToolsSearchInput = z.output<typeof toolsSearch.input>;
export type ToolsSearchOutput = z.output<typeof toolsSearch.output>;
export type SearchRow = z.output<typeof searchRowSchema>;
export type SearchKind = (typeof SEARCH_KINDS)[number];
