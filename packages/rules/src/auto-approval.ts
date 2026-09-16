/**
 * Auto-approval: the conditions under which an approval resolves without a
 * person (MC spec §6.9 part 2, ADR-070).
 *
 * An auto-approval rule is the second clause of a workspace's rule set. The
 * first clause, `rules`, decides at the kernel gate: allow, deny, or a person
 * must look. The second clause answers one question about a call the first
 * clause sent to a person: may Oxagen skip the human? The spec names the
 * conditions that may answer yes — a measure under a threshold, a counterparty
 * or environment on an allow list, a standing approval of the same call digest
 * inside a window the rule names, and business hours — and the answer is
 * recorded as an approval whose approver is `policy:<rule id>`, so the receipt
 * says plainly that no person looked.
 *
 * ## The floors are code, never configuration
 *
 * Four conditions refuse an auto-approval whatever a rule says, and they are
 * checked before any rule's own conditions: a tool with no declared safety
 * classification (there is nothing to judge), untrusted input, a risk grade of
 * `critical`, and a consequence the record marks irreversible. A rule cannot name them, turn
 * them off, or outrank them. `REASON` carries their codes and
 * `HARD_FLOOR_REASONS` is the set the recorded result is checked against.
 *
 * ## Why this evaluator is pure
 *
 * Same call, same rules, same facts, same answer (§6.12). Every fact it reads
 * is on the subject the caller assembles, so the result recorded beside an
 * approval re-derives from the record, and every reason string is testable
 * with no database.
 */
import type {
  AutoApprovalBusinessHours,
  AutoApprovalRule,
} from "@oxagen/oxagen/approval-rules/schemas";
import { matchGlob } from "@oxagen/mcp-config/permissions";
import { exceeds, targetAllowed, toolMatches } from "./mandates/measures";

/** Everything the evaluator reads, assembled by the caller from the call and the record. */
export interface AutoApprovalSubject {
  /** The registered capability the call asked for. */
  capability: string;
  /**
   * The declared tool version behind the capability, with the safety
   * classification the floors read. Null when the workspace declares no
   * enabled tool for it — nothing to judge, so nothing is auto-approved.
   */
  tool: {
    slug: string;
    version: number;
    /** The effective grade: the classified one when set, else the declared one. */
    riskGrade: string;
    /**
     * The effective side-effect class — the more severe of what the manifest
     * declared and what an administrator classified. Null when the version
     * carries no classification.
     */
    sideEffect: string | null;
    /**
     * The union of the declared consequence tags and the classified ones.
     * A union, never a replacement: see `loadDeclaredTool`.
     */
    consequenceTags: string[];
  } | null;
  /** measure name → the value read from the call, as an integer string. Absent when unreadable. */
  measures: Record<string, string>;
  /** measure name → the target read from the call. Absent when unreadable. */
  targets: Record<string, string>;
  /** True when the call's arguments derive from untrusted input (§6.7). */
  tainted: boolean;
  /** When a person last approved this same call digest, or null. */
  standingApprovalAt: Date | null;
  now: Date;
}

/** The recorded result: the rule that was evaluated, whether it qualified, and every reason it did not. */
export interface AutoApprovalOutcome {
  ruleId: string;
  ruleName: string;
  ok: boolean;
  /** Empty when `ok`. Each entry is a `REASON` code, some with a `:<measure>` suffix. */
  reasons: string[];
  /** True when at least one reason is a hard floor no rule can lift. */
  floor: boolean;
}

/**
 * Every reason an evaluation can record. The app maps a code to its copy, so
 * the strings here are the wire form and never prose.
 */
export const REASON = {
  /** No enabled declared tool backs the capability, so it carries no classification. */
  toolNotDeclared: "tool_not_declared",
  /** The call's arguments derive from untrusted input. */
  taintedInput: "tainted_input",
  /** The tool version's risk grade is `critical`. */
  criticalHazard: "critical_hazard",
  /** The tool version carries a consequence the record marks irreversible. */
  irreversibleConsequence: "irreversible_consequence",
  /** `measure_above_ceiling:<measure>` — the value exceeds the rule's ceiling. */
  measureAboveCeiling: "measure_above_ceiling",
  /** `measure_unreadable:<measure>` — the rule caps a measure the call does not carry. */
  measureUnreadable: "measure_unreadable",
  /** `target_not_allowed:<measure>` — the target matches none of the rule's allow globs. */
  targetNotAllowed: "target_not_allowed",
  /** `target_unreadable:<measure>` — the rule allow-lists a target the call does not carry. */
  targetUnreadable: "target_unreadable",
  /** No person approved this digest inside the rule's standing window. */
  noStandingApproval: "no_standing_approval",
  /** The call arrived outside the rule's business hours. */
  outsideBusinessHours: "outside_business_hours",
} as const;

/**
 * The floors. A reason in this set means no rule could ever have admitted the
 * call — the conditions ADR-070 decision 1 fixes in code.
 */
export const HARD_FLOOR_REASONS: readonly string[] = [
  REASON.toolNotDeclared,
  REASON.taintedInput,
  REASON.criticalHazard,
  REASON.irreversibleConsequence,
];

/**
 * The consequences that are irreversible on the record. The spec's
 * `irreversible` side-effect class is not a column any tool version carries
 * (ADR-070 decision 1), so the floor reads the starter-set tag that means the
 * same thing: an action that destroys data cannot be undone.
 */
export const IRREVERSIBLE_CONSEQUENCE_TAGS: readonly string[] = [
  "destroys_data",
];

/** The side-effect class that means the same thing as an irreversible tag. */
export const IRREVERSIBLE_SIDE_EFFECT = "irreversible";

/** True when a recorded result was stopped by a floor rather than by a rule's own condition. */
export function isFloorReason(reason: string): boolean {
  return HARD_FLOOR_REASONS.includes(reason.split(":")[0] ?? reason);
}

/**
 * The rule that answers for this call: the first enabled one in authoring
 * order whose tool patterns match, or undefined when none covers it.
 *
 * `evaluateAutoApproval` and the subject builder both go through this, so the
 * rule whose needs decide what the builder loads is the same rule that later
 * judges the call. Two copies of this `find` would be a silent way for the
 * two to disagree.
 */
export function selectAutoApprovalRule(
  rules: readonly AutoApprovalRule[],
  subject: AutoApprovalCoverage,
): AutoApprovalRule | undefined {
  return rules.find((r) => r.enabled && ruleCovers(r, subject));
}

/**
 * Judge one parked call against the workspace's auto-approval rules.
 *
 * Returns the first enabled rule in authoring order whose tool patterns match
 * the call, with every reason it does not qualify, or `null` when no rule
 * covers the call at all — null is "this workspace has no opinion here", and
 * the caller leaves the call with the person it was already going to.
 */
export function evaluateAutoApproval(
  rules: readonly AutoApprovalRule[],
  subject: AutoApprovalSubject,
): AutoApprovalOutcome | null {
  const rule = selectAutoApprovalRule(rules, subject);
  if (rule === undefined) return null;

  const reasons = [...floorReasons(subject), ...ruleReasons(rule, subject)];
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    ok: reasons.length === 0,
    reasons,
    floor: reasons.some(isFloorReason),
  };
}

/**
 * The part of a subject that decides which rule answers for a call. Splitting
 * it out lets the subject builder pick the applicable rule before it has
 * finished assembling the subject, so it can skip work only that rule needs
 * (`selectAutoApprovalRule`).
 */
export type AutoApprovalCoverage = Pick<
  AutoApprovalSubject,
  "capability" | "tool"
>;

/** A rule covers a call by its tool patterns: `slug@version` when declared, the capability name otherwise. */
function ruleCovers(
  rule: AutoApprovalRule,
  subject: AutoApprovalCoverage,
): boolean {
  if (subject.tool !== null) {
    return toolMatches(rule.tools, subject.tool.slug, subject.tool.version);
  }
  // An undeclared capability still matches by name, so the floor below can
  // record WHY it was refused rather than reading as "no rule covers this".
  return rule.tools.some((p) =>
    matchGlob(p.split("@")[0] ?? p, subject.capability),
  );
}

/** The conditions no rule can lift. */
function floorReasons(subject: AutoApprovalSubject): string[] {
  const reasons: string[] = [];
  if (subject.tool === null) reasons.push(REASON.toolNotDeclared);
  if (subject.tainted) reasons.push(REASON.taintedInput);
  if (subject.tool?.riskGrade === "critical") {
    reasons.push(REASON.criticalHazard);
  }
  // Two ways the record says this call cannot be taken back, and either one
  // is the same floor: the side-effect class the classification names, and a
  // consequence tag the record marks irreversible. One reason, not two, so
  // the approval card does not say the same thing twice.
  if (
    subject.tool?.sideEffect === IRREVERSIBLE_SIDE_EFFECT ||
    subject.tool?.consequenceTags.some((t) =>
      IRREVERSIBLE_CONSEQUENCE_TAGS.includes(t),
    )
  ) {
    reasons.push(REASON.irreversibleConsequence);
  }
  return reasons;
}

/** The rule's own conditions, in the order §6.9 part 2 names them. */
function ruleReasons(
  rule: AutoApprovalRule,
  subject: AutoApprovalSubject,
): string[] {
  const reasons: string[] = [];

  for (const [measure, ceiling] of sorted(rule.maxMeasures)) {
    const value = subject.measures[measure];
    if (value === undefined) {
      reasons.push(`${REASON.measureUnreadable}:${measure}`);
    } else if (exceeds(value, ceiling)) {
      reasons.push(`${REASON.measureAboveCeiling}:${measure}`);
    }
  }

  for (const [measure, allow] of sorted(rule.allowTargets)) {
    const target = subject.targets[measure];
    if (target === undefined) {
      reasons.push(`${REASON.targetUnreadable}:${measure}`);
    } else if (!targetAllowed(target, { allow, deny: [] })) {
      reasons.push(`${REASON.targetNotAllowed}:${measure}`);
    }
  }

  if (rule.standingWindowMs !== null) {
    const at = subject.standingApprovalAt;
    const fresh =
      at !== null &&
      subject.now.getTime() - at.getTime() <= rule.standingWindowMs;
    if (!fresh) reasons.push(REASON.noStandingApproval);
  }

  if (
    rule.businessHours !== null &&
    !withinBusinessHours(subject.now, rule.businessHours)
  ) {
    reasons.push(REASON.outsideBusinessHours);
  }

  return reasons;
}

/** jsonb keeps its own key order; a recorded reason list must not depend on it. */
function sorted<T>(record: Record<string, T>): [string, T][] {
  return Object.entries(record).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
}

/**
 * Whether an instant falls inside a rule's hours, in the rule's own zone.
 *
 * The wall-clock parts come from `Intl.DateTimeFormat` with the zone, which
 * applies whatever offset was in effect at that instant — so a window written
 * as 09:00–17:00 stays 09:00–17:00 across a daylight-saving change rather
 * than sliding by an hour twice a year.
 */
export function withinBusinessHours(
  at: Date,
  hours: AutoApprovalBusinessHours,
): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: hours.timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((p) => p.type === type)?.value ?? "";

  const isoDay = ISO_WEEKDAY[read("weekday")];
  if (isoDay === undefined || !hours.days.includes(isoDay)) return false;

  // `hour12: false` renders midnight as "24" in some ICU versions; both forms
  // mean minute zero of the day.
  const hour = Number(read("hour")) % 24;
  const minutes = hour * 60 + Number(read("minute"));
  return minutes >= toMinutes(hours.start) && minutes < toMinutes(hours.end);
}

const ISO_WEEKDAY: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}
