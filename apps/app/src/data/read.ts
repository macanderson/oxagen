// The result every read returns (ARCHITECTURE.md §3.3): a value, a denial, a
// pending approval or an error, each a value a page renders. A slice with no
// backing has no read at all; a whole unbacked page is a row in
// ./unrecorded.ts. No `exhausted` variant exists: every contract the app reads
// declares `noBillingGate`, so no read can be refused for lack of GAUs (§3.2).

type ReadError = {
  ok: false;
  reason: "error";
  code: string;
  status: number;
};
type Denied = { ok: false; reason: "denied"; permission: string };
type PendingApproval = {
  ok: false;
  reason: "pending_approval";
  accessRequestId: string;
};

export type Read<T> =
  | { ok: true; value: T }
  | Denied
  | PendingApproval
  | ReadError;

export const readOk = <T>(value: T): Read<T> => ({ ok: true, value });

export const readError = (code: string, status: number): ReadError => ({
  ok: false,
  reason: "error",
  code,
  status,
});

// Every page's named failure: the error code and HTTP status its read path
// reports when the store behind it is down, and the permission a member
// without access is denied on. The kernel seam (§3.2) answers a refusal with
// the row of the page that made the read.

export type PageKey =
  | "fleet"
  | "run"
  | "agents"
  | "onboarding"
  | "organization"
  | "billing"
  | "spend"
  | "audit"
  | "skills"
  | "steering"
  | "mandates"
  | "tools"
  | "repositories"
  | "runtimes"
  | "shell";

type PageFailure = {
  error: { code: string; status: number };
  permission: string;
};

const CONTROL_PLANE_DOWN = {
  code: "control_plane_unavailable",
  status: 503,
} as const;

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
  // The gate is a row on the organization and the first frame is the ingest's:
  // a read that cannot answer says so rather than holding the page that
  // carries it (#2967).
  onboarding: {
    error: { code: "onboarding_state_unavailable", status: 503 },
    permission: "agent.register",
  },
  organization: { error: CONTROL_PLANE_DOWN, permission: "org.admin" },
  billing: {
    error: { code: "stripe_unreachable", status: 502 },
    permission: "org.billing",
  },
  // The cost rollup is rebuilt from frames; while a rebuild holds the read,
  // the page says so rather than printing a stale or partial figure.
  spend: {
    error: { code: "rollup_rebuild_in_progress", status: 504 },
    permission: "spend.read",
  },
  // The organization's audit record: a member without an owner or admin role
  // is denied rather than shown an empty record. The label names both roles
  // the handler admits (audit.log.query.ts); #3873 asks for an auditor role.
  audit: {
    error: { code: "audit_store_unavailable", status: 503 },
    permission: "org.owner or org.admin",
  },
  // The session inventory is a control-plane table read (tacho.sessions).
  skills: {
    error: { code: "session_store_unavailable", status: 503 },
    permission: "skills.read",
  },
  // The published records and the proposals are one record index; a member
  // without the workspace's steering read is denied on it.
  steering: {
    error: { code: "record_index_unavailable", status: 503 },
    permission: "steering.read",
  },
  // The mandate ledger is read on three pages — Tools, Agents and the Fleet
  // approval card — and names its own failure wherever it is read: a member
  // without a finance role is denied on it, and the ledger is what is down.
  mandates: {
    error: { code: "mandate_ledger_unavailable", status: 503 },
    permission: "org.billing",
  },
  // The registry, the credential grants and the kill switches are one read
  // path: a member whose roles do not carry the workspace's tool read is
  // denied on it rather than shown an empty registry (#2958).
  tools: {
    error: { code: "tool_registry_unavailable", status: 503 },
    permission: "tools.read",
  },
  // The Repositories page reads the workspace's bindings locally and what
  // each repository holds under .oxagen/ from GitHub, through the workspace's
  // App installation. What is down when it fails is that installation, so the
  // failure names it (the mockup's `503 installation_unreachable`).
  repositories: {
    error: { code: "installation_unreachable", status: 503 },
    permission: "repository.read",
  },
  // The Runtimes page reads the workspace's host enrollments. What is down
  // when it fails is the collector record, so the failure names it (the
  // mockup's `503 collector_unreachable`). `runtime.read` is the catalogue
  // permission over `list_tacho_hosts`.
  runtimes: {
    error: { code: "collector_unreachable", status: 503 },
    permission: "runtime.read",
  },
  // The shell's one read fails with the control plane and needs organization
  // membership alone.
  shell: { error: CONTROL_PLANE_DOWN, permission: "org.read" },
} as const satisfies Record<PageKey, PageFailure>;
