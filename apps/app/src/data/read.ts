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
  | "organization"
  | "billing"
  | "spend"
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
  // The shell's one read fails with the control plane and needs organization
  // membership alone.
  shell: { error: CONTROL_PLANE_DOWN, permission: "org.read" },
} as const satisfies Record<PageKey, PageFailure>;
