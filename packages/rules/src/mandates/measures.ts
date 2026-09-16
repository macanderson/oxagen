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
  | "not_a_string"
  | "too_precise";

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

/** An amount converted to micros, or why it could not be. */
export type AmountToMicros =
  | { ok: true; micros: string }
  | { ok: false; reason: "not_a_number" | "too_precise" };

/**
 * Convert an amount the tool expresses in `scale` decimal places to micros,
 * with string arithmetic: `"12.50"` at scale 2 is `12500000`. A number is
 * printed first through its shortest round-trip form.
 *
 * A value this cannot represent EXACTLY is refused, never rounded down. Two
 * ways that happens, and both used to truncate:
 *
 * - more decimals than the measure declares — `"10.009"` at scale 2 became
 *   `10000000`, the same micros as `"10.00"`;
 * - a scale above 6, which is finer than micros — `"1.2345678"` at scale 7
 *   became `1234567`, dropping the last digit.
 *
 * Truncating is not a rounding preference, it is a fail-open. The decision
 * path would judge a smaller number than the one the handler goes on to
 * execute, so a rule whose ceiling sits at the truncated value releases a
 * call that is actually over it, and both halves look self-consistent. Every
 * caller treats an unreadable measure as a refusal — the mandate gate denies
 * (`measure_unreadable`), the auto-approval evaluator records
 * `measure_unreadable:<measure>` and leaves the call with a person — so
 * refusing here sends the call to a human rather than releasing it on a
 * number nobody wrote.
 */
export function amountToMicros(
  raw: string | number,
  scale: number,
): AmountToMicros {
  const text = typeof raw === "number" ? String(raw) : raw.trim();
  const m = DECIMAL.exec(text);
  if (!m) return { ok: false, reason: "not_a_number" };
  const whole = m[1]!;
  const fracRaw = m[2] ?? "";
  if (fracRaw.length > scale) return { ok: false, reason: "too_precise" };
  const frac = fracRaw.padEnd(scale, "0");
  // micros = value * 10^6 = (whole + frac / 10^scale) * 10^6
  const digits = `${whole}${frac}`.replace(/^0+(?=\d)/, "");
  const shift = 6 - scale;
  if (shift >= 0) {
    return {
      ok: true,
      micros: `${digits}${"0".repeat(shift)}`.replace(/^0+(?=\d)/, ""),
    };
  }
  // scale > 6: the declaration is finer than micros. Exact only when the
  // digits past the sixth are zero.
  const divisor = 10n ** BigInt(-shift);
  const value = BigInt(digits);
  if (value % divisor !== 0n) return { ok: false, reason: "too_precise" };
  return { ok: true, micros: (value / divisor).toString() };
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
      if (!micros.ok) return { ok: false, reason: micros.reason };
      return { ok: true, measure: { kind: "value", value: micros.micros } };
    }
    case "count": {
      const n =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && MEASURE_VALUE.test(raw)
            ? Number(raw)
            : Number.NaN;
      if (!Number.isInteger(n)) return { ok: false, reason: "not_a_number" };
      if (n < 0) return { ok: false, reason: "negative" };
      return { ok: true, measure: { kind: "value", value: String(n) } };
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
