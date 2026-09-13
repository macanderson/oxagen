// Per-page error codes and denied permissions (plan §2.1), taken from the
// mockup's error and denied states at mc-baseline-w1. A port's failed read
// carries its own code or permission; this table is the fallback when it does
// not, and the one place a page's failure vocabulary is written down.

export const PAGE_KEYS = [
  "home",
  "fleet",
  "run",
  "agents",
  "agent",
  "agentSource",
  "mandate",
  "tools",
  "ontology",
  "steering",
  "spend",
  "register",
  "welcome",
  "organization",
  "roles",
  "apiKeys",
  "billing",
  "audit",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export type PageErrorSpec = {
  /** The stable error code the page reports when its read fails. */
  code: string;
  /** The HTTP status that code travels with. */
  status: number;
  /** The permission (or role) a member needs to see the page. */
  permission: string;
};

export const PAGE_ERRORS: Readonly<Record<PageKey, PageErrorSpec>> = {
  home: {
    code: "control_plane_unavailable",
    status: 503,
    permission: "workspace.read",
  },
  fleet: {
    code: "run_index_unavailable",
    status: 503,
    permission: "workspace.read",
  },
  run: { code: "frame_store_unreachable", status: 502, permission: "run.read" },
  agents: {
    code: "iam_principals_unavailable",
    status: 503,
    permission: "agent.read",
  },
  agent: {
    code: "iam_principals_unavailable",
    status: 503,
    permission: "agent.read",
  },
  agentSource: {
    code: "iam_principals_unavailable",
    status: 503,
    permission: "agent.read",
  },
  mandate: {
    code: "mandate_ledger_unavailable",
    status: 503,
    permission: "org.billing",
  },
  tools: {
    code: "tool_registry_unavailable",
    status: 503,
    permission: "tools.read",
  },
  ontology: {
    code: "graph_read_timeout",
    status: 504,
    permission: "graph.read",
  },
  steering: {
    code: "record_index_unavailable",
    status: 503,
    permission: "steering.read",
  },
  spend: {
    code: "rollup_rebuild_in_progress",
    status: 504,
    permission: "spend.read",
  },
  register: {
    code: "iam_principals_unavailable",
    status: 503,
    permission: "agent.register",
  },
  welcome: {
    code: "control_plane_unavailable",
    status: 503,
    permission: "org.create",
  },
  organization: {
    code: "control_plane_unavailable",
    status: 503,
    permission: "org.admin",
  },
  roles: {
    code: "control_plane_unavailable",
    status: 503,
    permission: "org.admin",
  },
  apiKeys: {
    code: "control_plane_unavailable",
    status: 503,
    permission: "org.admin",
  },
  billing: {
    code: "stripe_unreachable",
    status: 502,
    permission: "org.billing",
  },
  audit: {
    code: "audit_store_unavailable",
    status: 503,
    permission: "org.auditor",
  },
};

export function isPageKey(value: string): value is PageKey {
  return (PAGE_KEYS as readonly string[]).includes(value);
}
