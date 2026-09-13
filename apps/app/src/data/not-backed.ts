// The result every read port returns. A read with no backing store today is not
// an error and never a zero: it names the milestone and backend gap (plan §3.4)
// that will back it, and the page renders an honest "not recorded yet" state.

export type Milestone =
  | "M1"
  | "M2"
  | "M3"
  | "M4"
  | "M5"
  | "M6"
  | "spec-decision";

/** A backend gap id from plan §3.4 (G1–G15). */
export type GapId = `G${number}`;

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
