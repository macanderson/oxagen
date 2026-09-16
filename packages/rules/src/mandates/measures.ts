/**
 * The pure half of the mandate check (MC spec §6.9, ADR-059 decisions 5 and
 * 6): reading a measure from a call by the tool version's declared path,
 * converting an amount to micros with string arithmetic, the UTC period key
 * a ledger row is filed under, and the tool-pattern and target matches. No
 * I/O, so every rule here has a unit test with no database.
 *
 * Values are integer strings (INV-09): micros for an amount, whole units for
 * a count. Comparisons go through BigInt; nothing here touches a float.
 */
import {
  CALLS_MEASURE,
  MEASURE_VALUE,
  type MandatePeriod,
  type MeasureDeclaration,
} from "@oxagen/oxagen/mandates/schemas";
import { matchGlob } from "@oxagen/mcp-config/permissions";

/** One measure as read from a call: a value to reserve, or a target to match. */
type ReadMeasure =
  | { kind: "value"; value: string }
  | { kind: "target"; target: string };

/** Why a measure could not be read from the call. */
type MeasureReadFailure =
  | "missing"
  | "not_a_number"
  | "negative"
  | "not_a_string";

type MeasureReadResult =
  | { ok: true; measure: ReadMeasure }
  | { ok: false; reason: MeasureReadFailure };

/** Walk a dot path into a plain object graph; undefined when any hop is absent. */
export function readPath(input: unknown, path: string): unknown {
  let cursor: unknown = input;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

/**
 * Convert an amount the tool expresses in `scale` decimal places to micros,
 * with string arithmetic: `"12.50"` at scale 2 is `12500000`. A number is
 * printed first through its shortest round-trip form; a value with more
 * decimals than `scale` is rounded down to what the tool itself can express.
 */
export function amountToMicros(
  raw: string | number,
  scale: number,
): string | null {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const whole = m[1]!;
  const frac = (m[2] ?? "").slice(0, scale).padEnd(scale, "0");
  // micros = value * 10^6 = (whole + frac / 10^scale) * 10^6
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "");
  const shift = 6 - scale;
  const micros =
    shift >= 0
      ? `${digits}${"0".repeat(shift)}`
      : (BigInt(digits) / 10n ** BigInt(-shift)).toString();
  return micros.replace(/^0+(?=\d)/, "");
}

/** Read one declared measure from the validated call input. */
export function readMeasure(
  input: unknown,
  declaration: MeasureDeclaration,
): MeasureReadResult {
  const raw = readPath(input, declaration.path);
  if (raw === undefined || raw === null)
    return { ok: false, reason: "missing" };
  switch (declaration.type) {
    case "amount": {
      if (typeof raw !== "string" && typeof raw !== "number")
        return { ok: false, reason: "not_a_number" };
      if (typeof raw === "number" && (raw < 0 || !Number.isFinite(raw)))
        return { ok: false, reason: raw < 0 ? "negative" : "not_a_number" };
      const micros = amountToMicros(raw, declaration.scale ?? 2);
      if (micros === null) return { ok: false, reason: "not_a_number" };
      return { ok: true, measure: { kind: "value", value: micros } };
    }
    case "count": {
      // A count is enforced on BigInt (`exceeds`), so it has to reach that
      // comparison as the digits the tool reported. Routing it through
      // `Number` rounded 9007199254740995 to …96 — a call one unit over its
      // mandate admitted, with the gate and the ledger each believing they
      // agreed — and turned a large value into scientific notation that
      // `BigInt` then threw on. Money has been micros-and-BigInt for exactly
      // this reason (INV-09); a count is the same rule one column over.
      if (typeof raw === "string") {
        if (!MEASURE_VALUE.test(raw))
          return { ok: false, reason: "not_a_number" };
        return { ok: true, measure: { kind: "value", value: raw } };
      }
      if (typeof raw !== "number" || !Number.isInteger(raw))
        return { ok: false, reason: "not_a_number" };
      if (raw < 0) return { ok: false, reason: "negative" };
      // A JSON number past the safe range was already inexact when it was
      // parsed, so no reading of it is the figure the tool meant. The gate
      // refuses rather than enforcing a number nobody reported — a tool that
      // needs to report a count this large reports it as a string, which the
      // branch above carries exactly.
      if (!Number.isSafeInteger(raw))
        return { ok: false, reason: "not_a_number" };
      return { ok: true, measure: { kind: "value", value: String(raw) } };
    }
    case "text": {
      if (typeof raw !== "string") return { ok: false, reason: "not_a_string" };
      return { ok: true, measure: { kind: "target", target: raw } };
    }
  }
}

/** The built-in measure: every call counts one, with no declared path. */
export function readCallsMeasure(): Extract<ReadMeasure, { kind: "value" }> {
  return { kind: "value", value: "1" };
}

export function isCallsMeasure(name: string): boolean {
  return name === CALLS_MEASURE;
}

/** ISO week number and ISO week-year, both in UTC. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return { year: t.getUTCFullYear(), week };
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD`, `YYYY-Www` or `YYYY-MM` in UTC by the limit's period. */
export function periodKey(period: MandatePeriod, at: Date): string {
  switch (period) {
    case "daily":
      return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}-${pad2(at.getUTCDate())}`;
    case "weekly": {
      const { year, week } = isoWeek(at);
      return `${year}-W${pad2(week)}`;
    }
    case "monthly":
      return `${at.getUTCFullYear()}-${pad2(at.getUTCMonth() + 1)}`;
  }
}

/**
 * A mandate's tool pattern is a flat glob over `slug@version`, or over the
 * bare slug, which matches every version.
 */
export function toolMatches(
  patterns: readonly string[],
  slug: string,
  version: number,
): boolean {
  const versioned = `${slug}@${version}`;
  return patterns.some(
    (p) => matchGlob(p, versioned) || (!p.includes("@") && matchGlob(p, slug)),
  );
}

/**
 * A target on an allow pattern passes; otherwise a target on a deny pattern
 * fails; otherwise the target passes only when the rule names no allow
 * pattern. So the spec's `{ allow: ["vendor:aws"], deny: ["*"] }` admits
 * exactly the named vendor, an allow-only rule is a whitelist and a
 * deny-only rule a blacklist.
 */
export function targetAllowed(
  target: string,
  rule: { allow: readonly string[]; deny: readonly string[] },
): boolean {
  if (rule.allow.some((p) => matchGlob(p, target))) return true;
  if (rule.deny.some((p) => matchGlob(p, target))) return false;
  return rule.allow.length === 0;
}

/** `a > b` over integer strings. */
export function exceeds(a: string, b: string): boolean {
  return BigInt(a) > BigInt(b);
}

/**
 * `perPeriod − drawn`, floored at zero: what a period still allows once
 * `drawn` (its open reservations plus its settlements) is taken out. The
 * floor covers a ceiling lowered below what the period already drew.
 */
export function remainingAfter(perPeriod: string, drawn: bigint): string {
  const r = BigInt(perPeriod) - drawn;
  return (r < 0n ? 0n : r).toString();
}
