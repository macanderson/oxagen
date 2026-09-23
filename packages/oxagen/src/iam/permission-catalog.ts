// permission-catalog.ts — the permission catalogue the role editor speaks
// (ADR-063; Mission Control mockup `PERMS`, `mc.html`).
//
// A permission is a named bundle of registered capabilities in one of seven
// groups. The catalogue is the vocabulary of `create_role` and
// `set_role_grants` and the fold `list_iam_roles` reports a role's grants in;
// the kernel's resolver keeps reading `iam.role_grants` per capability, so a
// ticked permission is stored as one `allow` grant per capability it names
// and a permission reads as held when every one of them is allowed.
//
// Every capability named here is a registered contract name
// (`permission-catalog.test.ts` walks the registry), a permission names at
// least one, and an id appears once. The mockup's permissions with no
// capability behind them today — repository writes, mandates, kill switches,
// policy simulation, exports — are absent rather than listed as a grant the
// kernel would never read; `org.*` is the system org Owner role itself
// (resolver rule 7.5), never a grant.

export const PERMISSION_GROUPS = [
  "Runs",
  "Agents",
  "Tools and policy",
  "Repository",
  "Graph and steering",
  "Money",
  "Audit",
] as const;
export type PermissionGroup = (typeof PERMISSION_GROUPS)[number];

export interface Permission {
  /** Stable id, `<subject>.<verb>` (the mockup's `PERMS` vocabulary). */
  readonly id: string;
  readonly group: PermissionGroup;
  /** One line, what holding it lets a principal ask for. */
  readonly description: string;
  /** Registered capability names one `allow` grant each is written for. */
  readonly capabilities: readonly string[];
}

export const PERMISSION_CATALOG: readonly Permission[] = [
  // ── Runs ─────────────────────────────────────────────────────────────────
  {
    id: "run.read",
    group: "Runs",
    description: "Read runs, their approvals and the commands sent to them",
    capabilities: [
      "list_runs",
      "get_run",
      "list_approvals",
      "list_commands",
      "list_tacho_sessions",
      "get_tacho_session",
    ],
  },
  {
    id: "run.control",
    group: "Runs",
    description: "Pause, resume, cancel and steer runs",
    capabilities: ["dispatch_command"],
  },
  {
    id: "run.approve",
    group: "Runs",
    description: "Approve or deny a tool call waiting on a person",
    capabilities: ["resolve_approval"],
  },
  // ── Agents ───────────────────────────────────────────────────────────────
  {
    id: "agent.read",
    group: "Agents",
    description: "Read agent definitions, their roles and their toolbelts",
    capabilities: [
      "list_agent_defs",
      "get_agent_def",
      "get_agent_role",
      "list_agent_roles",
      "list_agent_tools",
    ],
  },
  {
    id: "agent.register",
    group: "Agents",
    description: "Create, change, publish, deploy and retire agents",
    capabilities: [
      "create_agent_def",
      "update_agent_def",
      "revise_agent_def",
      "publish_agent_def",
      "deploy_agent",
      "delete_agent_def",
    ],
  },
  {
    id: "agent.roles.assign",
    group: "Agents",
    description: "Assign and revoke an agent's roles",
    capabilities: ["assign_agent_role", "revoke_agent_role"],
  },
  {
    // The Runtimes page's read (roadmap mockups/pages/runtimes.md,
    // Permissions). Unenroll (`revoke_tacho_enrollment`) is not a permission
    // here: its handler admits an org Owner or Admin whatever the role grants
    // say, so a ticked `runtime.unenroll` would be a grant the write ignores
    // (#3857 moves the handler onto role grants and adds the two writes).
    id: "runtime.read",
    group: "Agents",
    description: "Read the hosts agents run on and their enrollments",
    capabilities: ["list_tacho_hosts"],
  },
  // ── Tools and policy ─────────────────────────────────────────────────────
  {
    id: "tool.read",
    group: "Tools and policy",
    description: "Read the tool registry, MCP servers and consents",
    capabilities: [
      "list_tool_declarations",
      "list_mcp_servers",
      "list_mcp_consents",
    ],
  },
  {
    id: "tool.grant",
    group: "Tools and policy",
    description: "Publish tools, register MCP servers and settle consents",
    capabilities: [
      "publish_tool_declaration",
      "register_mcp_server",
      "delete_mcp_server",
      "set_mcp_enabled",
      "resolve_mcp_consent",
    ],
  },
  // ── Repository ───────────────────────────────────────────────────────────
  {
    id: "repo.read",
    group: "Repository",
    description:
      "Read branches, pull requests, CI status and repository metrics",
    capabilities: [
      "list_branches",
      "get_pr",
      "get_pr_diff",
      "get_ci_status",
      "get_repo_metrics",
    ],
  },
  {
    id: "repo.configure",
    group: "Repository",
    description: "Bind, sync, pause and resume a repository",
    capabilities: ["configure_repo", "sync_repo", "pause_repo", "resume_repo"],
  },
  // ── Graph and steering ───────────────────────────────────────────────────
  {
    id: "graph.search",
    group: "Graph and steering",
    description: "Search and traverse the knowledge graph",
    capabilities: [
      "search_graph",
      "search_nodes",
      "get_node",
      "list_nodes",
      "get_node_labels",
      "get_graph_stats",
      "query_ontology",
      "get_ontology_neighbors",
    ],
  },
  {
    id: "context.recall",
    group: "Graph and steering",
    description: "Recall and cite memories",
    capabilities: [
      "recall_memory",
      "list_memories",
      "list_memory_citations",
      "cite_memory",
    ],
  },
  {
    id: "steering.read",
    group: "Graph and steering",
    description: "Read steering records and promotion candidates",
    capabilities: ["list_context_records", "list_memory_promotions"],
  },
  {
    id: "steering.propose",
    group: "Graph and steering",
    description:
      "Promote, publish, revise, demote and dismiss steering records",
    capabilities: [
      "promote_context_record",
      "revise_context_record",
      "publish_context_record",
      "promote_memory",
      "demote_memory",
      "dismiss_memory_promotion",
    ],
  },
  // ── Money ────────────────────────────────────────────────────────────────
  {
    id: "invoice.read",
    group: "Money",
    description: "Read the subscription, invoices, rates and usage",
    capabilities: [
      "get_subscription",
      "get_gau_bucket",
      "get_contract_rate",
      "list_invoices",
      "get_rate_card",
      "get_usage_breakdown",
      "preview_action_cost",
    ],
  },
  {
    id: "budget.set",
    group: "Money",
    description: "Read and set spend budgets and the budget policy",
    capabilities: [
      "get_spend_budget",
      "set_spend_budget",
      "get_budget_policy",
      "update_budget_policy",
    ],
  },
  // ── Audit ────────────────────────────────────────────────────────────────
  {
    id: "audit.read",
    group: "Audit",
    description: "Query the audit log",
    capabilities: ["query_audit_log"],
  },
  {
    id: "frame.read",
    group: "Audit",
    description: "Read execution traces",
    capabilities: ["list_executions", "get_execution_trace"],
  },
];

const [firstId, ...restIds] = PERMISSION_CATALOG.map((p) => p.id);
if (firstId === undefined) throw new Error("The permission catalogue is empty");
/** The ids as the non-empty tuple `z.enum` takes. */
export const PERMISSION_IDS: readonly [string, ...string[]] = [
  firstId,
  ...restIds,
];

const byId = new Map(PERMISSION_CATALOG.map((p) => [p.id, p]));

/** The capability set a list of permission ids expands to, deduplicated and sorted. */
export function capabilitiesOf(permissionIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of permissionIds) {
    const permission = byId.get(id);
    if (!permission) throw new Error(`Unknown permission: ${id}`);
    for (const capability of permission.capabilities) out.add(capability);
  }
  return [...out].sort();
}

/**
 * The permissions a set of `allow` grants covers: every capability the
 * permission names is allowed. A partial cover is not the permission.
 */
export function permissionsHeldBy(
  allowedCapabilities: ReadonlySet<string>,
): string[] {
  return PERMISSION_CATALOG.filter((p) =>
    p.capabilities.every((c) => allowedCapabilities.has(c)),
  ).map((p) => p.id);
}
