// The result every read port returns. A read with no backing store today is not
// an error and never a zero: it names the milestone and backend gap (plan §3.4)
// that will back it, and the page renders an honest "not recorded yet" state.

/**
 * A spec §17 milestone. `M0` (Foundations) marks a slice whose store exists
 * today but whose live adapter is not wired yet (Batch 3 wires it).
 */
export type Milestone =
  | "M0"
  | "M1"
  | "M2"
  | "M3"
  | "M4"
  | "M5"
  | "M6"
  | "spec-decision";

/** A backend gap id from plan §3.4 (G1–G15), or `G0` for none. */
export type GapId = `G${number}`;

/**
 * No numbered gap: either the store exists and only the adapter is missing
 * (`M0`), or the slice waits on a milestone that §3.4 gives no gap id.
 */
export const NO_GAP = "G0" satisfies GapId;

export type NotBacked = {
  ok: false;
  reason: "not_backed";
  milestone: Milestone;
  gap: GapId;
};
export type ReadError = {
  ok: false;
  reason: "error";
  code: string;
  status: number;
};
export type Denied = { ok: false; reason: "denied"; permission: string };

export type Read<T> = { ok: true; value: T } | NotBacked | ReadError | Denied;

/** Any failed read: what `PageState` renders. */
export type ReadFailure = Exclude<Read<never>, { ok: true }>;

export const notBacked = (milestone: Milestone, gap: GapId): NotBacked =>
  ({ ok: false, reason: "not_backed", milestone, gap }) as const;

export const readOk = <T>(value: T): Read<T> => ({ ok: true, value });

export const readError = (code: string, status: number): ReadError => ({
  ok: false,
  reason: "error",
  code,
  status,
});

export const denied = (permission: string): Denied => ({
  ok: false,
  reason: "denied",
  permission,
});
