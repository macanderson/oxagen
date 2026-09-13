// Every page's named failure (plan §2.1): the error code and HTTP status its
// read path reports when the store behind it is down, and the permission a
// member without access is denied on. The codes and permissions are the
// mockup's (mc.html @ mc-baseline-w1, each page's errorState/deniedState).
//
// The fixture adapter's `mc_state` switch returns these, and lane L2's
// `PageState` can read the same table rather than keep a second copy.

export const PAGE_KEYS = [
  "fleet",
  "run",
  "agents",
  "agent",
  "mandate",
  "tools",
  "ontology",
  "steering",
  "spend",
  "organization",
  "billing",
  "audit",
  "shell",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export type PageFailure = {
  error: { code: string; status: number };
  /** The permission (or, where the mockup names one, the role) access needs. */
  permission: string;
};

export const PAGE_FAILURES = {
  fleet: {
    error: { code: "run_index_unavailable", status: 503 },
    permission: "workspace.read",
  },
  run: {
    error: { code: "frame_store_unreachable", status: 502 },
    permission: "run.read",
  },
  agents: {
    error: { code: "iam_principals_unavailable", status: 503 },
    permission: "agent.read",
  },
  agent: {
    error: { code: "iam_principals_unavailable", status: 503 },
    permission: "agent.read",
  },
  mandate: {
    error: { code: "mandate_ledger_unavailable", status: 503 },
    permission: "org.billing",
  },
  tools: {
    error: { code: "tool_registry_unavailable", status: 503 },
    permission: "tools.read",
  },
  ontology: {
    error: { code: "graph_read_timeout", status: 504 },
    permission: "graph.read",
  },
  steering: {
    error: { code: "record_index_unavailable", status: 503 },
    permission: "steering.read",
  },
  spend: {
    error: { code: "rollup_rebuild_in_progress", status: 504 },
    permission: "spend.read",
  },
  organization: {
    error: { code: "control_plane_unavailable", status: 503 },
    permission: "org.admin",
  },
  billing: {
    error: { code: "stripe_unreachable", status: 502 },
    permission: "org.billing",
  },
  audit: {
    error: { code: "audit_store_unavailable", status: 503 },
    permission: "org.auditor",
  },
  // The shell has no page of its own in the mockup; its reads fail with the
  // notification store and need only organization membership.
  shell: {
    error: { code: "notification_store_unavailable", status: 503 },
    permission: "org.read",
  },
} as const satisfies Record<PageKey, PageFailure>;

export function isPageKey(value: string): value is PageKey {
  return (PAGE_KEYS as readonly string[]).includes(value);
}
