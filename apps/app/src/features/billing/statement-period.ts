// The Statements form's period, as the export contract takes it
// (export_billing_statement, ADR-158). A calendar period is the UTC week,
// month, quarter or year containing a day; a custom period is a first and a
// last day, both included, which the contract takes as the half-open range
// [first 00:00 UTC, the day after last 00:00 UTC).
//
// The checks here are the ones a form can make without the server: a real
// calendar day, a range longer than 48 hours (so at least three whole days),
// at most 366 days, and not starting in the future. The handler checks the
// same rules again and is the authority; this only lets the form say which
// field is wrong before a request is made.

export const STATEMENT_KINDS = [
  "week",
  "month",
  "quarter",
  "year",
  "custom",
] as const;
export type StatementKind = (typeof STATEMENT_KINDS)[number];

export interface StatementForm {
  kind: StatementKind;
  /** A day inside the calendar period, YYYY-MM-DD. */
  anchor: string;
  /** Custom: the first day, YYYY-MM-DD. */
  firstDay: string;
  /** Custom: the last day, YYYY-MM-DD, included. */
  lastDay: string;
}

/** The export contract's period fields. */
export type StatementPeriodInput =
  | { period: Exclude<StatementKind, "custom">; anchor: string }
  | { period: "custom"; from: string; to: string };

const STATEMENT_FIELD_CODES = [
  "dayInvalid",
  "future",
  "rangeTooShort",
  "rangeTooLong",
] as const;

export type StatementFieldError = {
  field: "anchor" | "firstDay" | "lastDay";
  code: (typeof STATEMENT_FIELD_CODES)[number];
};

/**
 * Whether an invalid result's code is one the form has a message for. The
 * handler can refuse a field with a code of its own; that one is shown as a
 * general failure rather than looked up as a missing message key.
 */
export function isStatementFieldCode(
  code: string,
): code is StatementFieldError["code"] {
  return STATEMENT_FIELD_CODES.some((known) => known === code);
}

const DAY_MS = 86_400_000;
/** More than 48 hours of whole days is three days. */
const MIN_CUSTOM_DAYS = 3;
const MAX_CUSTOM_DAYS = 366;

/** Milliseconds at 00:00 UTC of a real calendar day, or null. */
function dayMs(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const ms = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return new Date(ms).toISOString().slice(0, 10) === value ? ms : null;
}

/** The form as the contract's period fields, or the field that is wrong. */
export function statementPeriodInput(
  form: StatementForm,
  today: string,
):
  | { ok: true; input: StatementPeriodInput }
  | { ok: false; error: StatementFieldError } {
  const todayMs = dayMs(today) ?? Date.now();
  if (form.kind !== "custom") {
    const anchor = dayMs(form.anchor);
    if (anchor === null)
      return { ok: false, error: { field: "anchor", code: "dayInvalid" } };
    if (anchor > todayMs)
      return { ok: false, error: { field: "anchor", code: "future" } };
    return { ok: true, input: { period: form.kind, anchor: form.anchor } };
  }
  const first = dayMs(form.firstDay);
  if (first === null)
    return { ok: false, error: { field: "firstDay", code: "dayInvalid" } };
  if (first > todayMs)
    return { ok: false, error: { field: "firstDay", code: "future" } };
  const last = dayMs(form.lastDay);
  if (last === null)
    return { ok: false, error: { field: "lastDay", code: "dayInvalid" } };
  const days = (last - first) / DAY_MS + 1;
  if (days < MIN_CUSTOM_DAYS)
    return { ok: false, error: { field: "lastDay", code: "rangeTooShort" } };
  if (days > MAX_CUSTOM_DAYS)
    return { ok: false, error: { field: "lastDay", code: "rangeTooLong" } };
  return {
    ok: true,
    input: {
      period: "custom",
      from: new Date(first).toISOString(),
      to: new Date(last + DAY_MS).toISOString(),
    },
  };
}
