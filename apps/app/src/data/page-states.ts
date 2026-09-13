// Every page's named failure (plan §2.1): the error code and HTTP status its
// read path reports when the store behind it is down, and the permission a
// member without access is denied on. The codes and permissions are the
// mockup's (mc.html @ mc-baseline-w1, each page's errorState/deniedState).
//
// The one table: the fixture adapter's `mc_state` switch returns these, and
// `PageState` (src/ui/page-state.tsx) falls back to them when a failed read
// names no code or permission of its own.

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
  "shell",
] as const;
export type PageKey = (typeof PAGE_KEYS)[number];

export type PageFailure = {
  error: { code: string; status: number };
  /** The permission (or, where the mockup names one, the role) access needs. */
  permission: string;
};

const IAM_DOWN = { code: "iam_principals_unavailable", status: 503 } as const;
const CONTROL_PLANE_DOWN = {
  code: "control_plane_unavailable",
  status: 503,
} as const;

export const PAGE_FAILURES = {
  home: { error: CONTROL_PLANE_DOWN, permission: "workspace.read" },
  fleet: {
    error: { code: "run_index_unavailable", status: 503 },
    permission: "workspace.read",
  },
  run: {
    error: { code: "frame_store_unreachable", status: 502 },
    permission: "run.read",
  },
  agents: { error: IAM_DOWN, permission: "agent.read" },
  agent: { error: IAM_DOWN, permission: "agent.read" },
  agentSource: { error: IAM_DOWN, permission: "agent.read" },
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
  // Register an agent and the onboarding gate: the enrollment read path.
  register: { error: IAM_DOWN, permission: "agent.register" },
  welcome: { error: CONTROL_PLANE_DOWN, permission: "org.create" },
  organization: { error: CONTROL_PLANE_DOWN, permission: "org.admin" },
  roles: { error: CONTROL_PLANE_DOWN, permission: "org.admin" },
  apiKeys: { error: CONTROL_PLANE_DOWN, permission: "org.admin" },
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
