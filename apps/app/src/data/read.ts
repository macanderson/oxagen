// The result every read returns (ARCHITECTURE.md §3.3): a value, a denial or
// an error, each a value a page renders. A slice with no backing has no read
// at all; a whole unbacked page is a row in ./unrecorded.ts.

type ReadError = {
  ok: false;
  reason: "error";
  code: string;
  status: number;
};
type Denied = { ok: false; reason: "denied"; permission: string };

export type Read<T> = { ok: true; value: T } | Denied | ReadError;

export const readOk = <T>(value: T): Read<T> => ({ ok: true, value });

export const readError = (code: string, status: number): ReadError => ({
  ok: false,
  reason: "error",
  code,
  status,
});

// Every page's named failure: the error code and HTTP status its read path
// reports when the store behind it is down, and the permission a member
// without access is denied on. The kernel seam (§3.2) falls back to a page's
// row when a refusal names no permission of its own.

export type PageKey = "fleet" | "run" | "organization" | "billing" | "shell";

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
  organization: { error: CONTROL_PLANE_DOWN, permission: "org.admin" },
  billing: {
    error: { code: "stripe_unreachable", status: 502 },
    permission: "org.billing",
  },
  // The shell's one read fails with the control plane and needs organization
  // membership alone.
  shell: { error: CONTROL_PLANE_DOWN, permission: "org.read" },
} as const satisfies Record<PageKey, PageFailure>;
