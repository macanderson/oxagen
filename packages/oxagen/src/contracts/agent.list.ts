// list_agents — the identities table of the Agents page (MC spec §6.2, App. E;
// #2956). One row per agent registered in the workspace: the identity half
// from Postgres (principal, harness, operator, status), the enrollment and
// credential counts, and the 30-day figures the run stores can answer.
//
// A console read is outside the metering surface (ADR-052 exclusion 2,
// INV-28): `noBillingGate: true`, `mutates: false`.
//
// Every figure is either counted from a store that exists or null with the
// reason on the field. No rollup table exists (spec §12 names one; none is
// migrated), so the 30-day figures are counted from the run stores directly:
// runs from `agent.agent_runs` and root `tacho.sessions`; spend from the
// priced wrapped sessions, client-attested; proven and mandates from stores
// that do not exist, so null.
import { z } from "zod";
import { registerCapability } from "../registry";
import { costSchema } from "./spend.shared";

const instant = z.string().datetime({ offset: true });

/** MC spec §6.2. `custom` is the value the legacy `create_agent_def` path implied. */
export const agentHarnessSchema = z.enum([
  "stella",
  "claude-code",
  "claude-agent-sdk",
  "custom",
]);
export type AgentHarness = z.output<typeof agentHarnessSchema>;

/**
 * The identity's state, derived on the read:
 * `retired` when the agent row is archived (`retire_agent`);
 * `suspended` when the principal is suspended (`suspend_agent`);
 * `enrolled` when it holds an active credential or an active host;
 * `unenrolled` otherwise (spec §6.2: "its status is unenrolled until
 * credentials are issued").
 */
export const agentIdentityStatusSchema = z.enum([
  "unenrolled",
  "enrolled",
  "suspended",
  "retired",
]);
export type AgentIdentityStatus = z.output<typeof agentIdentityStatusSchema>;

export const agentListItem = z
  .object({
    /** `agt_…`. */
    id: z.string().regex(/^agt_[0-9a-z]+$/),
    slug: z.string().min(1),
    name: z.string().min(1),
    /** `org_ns.ws_ns.slug` (ADR-024); null until the namespaces are backfilled. */
    agentKey: z.string().nullable(),
    harness: agentHarnessSchema,
    /** `prn_…` of the delegated principal; null on a row that predates Agent RBAC. */
    principalId: z.string().nullable(),
    /** `usr_…` of the person the agent acts for (`principals.parent_user_id`); null when none. */
    operatorId: z.string().nullable(),
    status: agentIdentityStatusSchema,
    /** The model tier the definition names. No store records it on the identity row: null. */
    tier: z.string().nullable(),
    /** Tools in the computed belt. Computed per agent by `get_agent_toolbelt`, not on the list: null. */
    beltSize: z.number().int().nonnegative().nullable(),
    /** Ledger runs plus root wrapped sessions started in the last 30 days. */
    runs30d: z.number().int().nonnegative(),
    /**
     * The sum of the agent's priced wrapped sessions started in the last 30
     * days, as the harness reported it (`client_attested`). Null when no
     * session in the window carries a priced basis. Gateway-observed spend of
     * ledger runs lives in ClickHouse and is not rolled up per agent.
     */
    spend30d: costSchema.nullable(),
    /** Runs with a verified outcome. No store records verification: null. */
    proven30d: z.number().int().nonnegative().nullable(),
    /** Mandates held. No mandate store exists: null. */
    mandates: z.number().int().nonnegative().nullable(),
    /** Open `tacho.incidents` rows on the agent's hosts. */
    incidents: z.number().int().nonnegative(),
    /** Active long-lived agent credentials (`auth.api_keys`, purpose `agent_credential_v1`). */
    credentials: z.number().int().nonnegative(),
    /** Active `tacho.hosts` rows enrolled under the agent's key. */
    hosts: z.number().int().nonnegative(),
    registeredAt: instant,
  })
  .strict();

export const agentList = registerCapability({
  name: "list_agents",
  domain: "agent",
  description:
    "List the agent identities registered in this workspace with their principal, harness, operator, status, enrollment and credential counts, and the 30-day run, spend and incident figures the stores record.",
  mode: "sync",
  surfaces: ["api", "mcp"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow", Member: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      limit: z.number().int().min(1).max(100).default(50),
      /** The `nextCursor` of the previous page. */
      cursor: z.string().max(256).optional(),
    })
    .strict(),
  output: z
    .object({
      items: z.array(agentListItem).max(100),
      nextCursor: z.string().nullable(),
      /** The stat tiles over the whole workspace, not the page. */
      totals: z
        .object({
          identities: z.number().int().nonnegative(),
          enrolled: z.number().int().nonnegative(),
          /** No mandate store exists: null. */
          holdingMandate: z.number().int().nonnegative().nullable(),
          /** Open incidents of a tamper kind across the workspace's hosts. */
          tamperIncidents: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
});

export type AgentListInput = z.output<typeof agentList.input>;
export type AgentListOutput = z.output<typeof agentList.output>;
export type AgentListItem = z.output<typeof agentListItem>;
