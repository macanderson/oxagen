/**
 * The facts a decision reads off one call: its canonical digest, the declared
 * tool behind the capability, and the measures and targets the tool's own
 * declarations name paths for.
 *
 * Both decisions use them. The mandate check (ADR-059) reads the tool's
 * consequence tags and the measures a mandate limits; the auto-approval
 * evaluator (ADR-070) reads the same tool's safety classification and every
 * measure a rule may cap or allow-list. They live here so neither module has
 * to import the other.
 */
import { createHash } from "node:crypto";
import { schema, type Tx } from "@oxagen/database";
import {
  measureDeclarationsSchema,
  type MeasureDeclarations,
} from "@oxagen/oxagen/mandates/schemas";
import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { AutoApprovalRule } from "@oxagen/oxagen/approval-rules/schemas";
import {
  selectAutoApprovalRule,
  type AutoApprovalSubject,
} from "./auto-approval";
import { readMeasure } from "./mandates/measures";

/** The declared tool the capability resolves to, with its active version. */
export interface DeclaredTool {
  slug: string;
  version: number;
  /** The effective risk grade: the classified one when set, else the declared one. */
  riskGrade: string;
  /** The effective side-effect class: the more severe of declared and classified. */
  sideEffect: string | null;
  /** The declared consequence tags unioned with the classified ones. */
  consequenceTags: string[];
  measures: MeasureDeclarations;
  effectIdPath: string | null;
}

/** Side-effect classes from least to most severe (toolSideEffectClassSchema). */
const SIDE_EFFECT_SEVERITY = ["read", "write", "irreversible"];

/**
 * The more severe of two side-effect classes, with an unknown or absent value
 * contributing nothing.
 *
 * `max`, never "the classified one": see the union note on
 * `effectiveConsequenceTags`. There is no declared side-effect COLUMN today —
 * the class exists only inside `classification` — so this currently reduces to
 * the classified value. It is written as a max anyway so that the day a
 * declared column lands, a reclassification still cannot lower what the
 * manifest declared.
 */
function moreSevereSideEffect(
  a: string | null,
  b: string | null,
): string | null {
  const rank = (v: string | null) =>
    v === null ? -1 : SIDE_EFFECT_SEVERITY.indexOf(v);
  return rank(a) >= rank(b) ? a : b;
}

/**
 * The tags the floor reads: the declared column UNIONED with the classified
 * ones, deduplicated and sorted.
 *
 * A union, deliberately, and the asymmetry is the whole argument. The two
 * halves are written by different capabilities behind different gates:
 * `publish_tool_declaration` writes the column behind `assertConsequenceRole`,
 * and `set_tool_classification` writes the jsonb behind Owner/Admin. Letting
 * the jsonb REPLACE the column would let an Owner lower an approval floor
 * without passing the consequence-role gate, which is a real bypass.
 *
 * A union cannot do that, because it is monotonic for a floor — it only ever
 * adds reasons a call needs a person, never removes one:
 *
 *   declared {}, classified {destroys_data} → {destroys_data} → floor fires.
 *     An Owner RAISED the floor. That is the fix.
 *   declared {destroys_data}, classified {} → {destroys_data} → floor fires.
 *     An Owner CANNOT lower it. The bypass does not exist.
 *
 * So the objection to reading the jsonb is an objection to replacement, not to
 * union, and it does not apply here. Recorded next to the code because the
 * next person to read this will have the same objection.
 */
function effectiveConsequenceTags(
  declared: readonly string[],
  classified: readonly string[],
): string[] {
  return [...new Set([...declared, ...classified])].sort();
}

/** The classification an administrator set, read defensively off the jsonb. */
function readClassification(raw: unknown): {
  sideEffect: string | null;
  consequenceTags: string[];
} {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { sideEffect: null, consequenceTags: [] };
  }
  const c = raw as Record<string, unknown>;
  const tags = Array.isArray(c.consequenceTags)
    ? c.consequenceTags.filter((t): t is string => typeof t === "string")
    : [];
  return {
    sideEffect: typeof c.sideEffect === "string" ? c.sideEffect : null,
    consequenceTags: tags,
  };
}

/** The workspace's enabled declared tool for this capability, or null. */
export async function loadDeclaredTool(
  tx: Tx,
  workspaceId: string,
  capability: string,
): Promise<DeclaredTool | null> {
  const [row] = await tx
    .select({
      slug: schema.tools.slug,
      version: schema.toolVersions.versionNumber,
      riskGrade: schema.toolVersions.riskGrade,
      classifiedRiskGrade: schema.toolVersions.classifiedRiskGrade,
      classification: schema.toolVersions.classification,
      consequenceTags: schema.toolVersions.consequenceTags,
      measures: schema.toolVersions.measures,
      effectIdPath: schema.toolVersions.effectIdPath,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.id, schema.tools.activeVersionId),
    )
    .where(
      and(
        eq(schema.tools.workspaceId, workspaceId),
        eq(schema.tools.slug, capability),
        eq(schema.tools.enabled, true),
        isNull(schema.tools.deletedAt),
      ),
    )
    .limit(1);
  if (!row) return null;
  const classified = readClassification(row.classification);
  return {
    slug: row.slug,
    version: row.version,
    // The effective grade, not the declared one. `risk_grade` is what the
    // manifest declared and is part of the version checksum;
    // `classified_risk_grade` is what an administrator set with
    // `set_tool_classification` and is deliberately outside the checksum, so
    // reclassifying does not make an unchanged manifest look changed. The
    // registry already shows `classifiedRiskGrade ?? riskGrade`
    // (tool.version.list.ts), and the critical_hazard floor has to agree with
    // the page: reading only the declared column means an administrator who
    // classifies a version `critical` over a lower declared grade never
    // raises the floor, and the call can skip a person. A floor that fails
    // open is worse than no floor, because the record says a rule judged it.
    riskGrade: row.classifiedRiskGrade ?? row.riskGrade,
    sideEffect: moreSevereSideEffect(null, classified.sideEffect),
    consequenceTags: effectiveConsequenceTags(
      row.consequenceTags,
      classified.consequenceTags,
    ),
    measures: measureDeclarationsSchema.parse(row.measures),
    effectIdPath: row.effectIdPath,
  };
}

/**
 * Raised when the call carries a value this canonicaliser will not reduce to
 * a digest. Every consumer treats a throw here as a refusal, so the call goes
 * to a person rather than sharing a digest with a call it is not.
 */
export class UndigestibleInputError extends Error {
  readonly code = "undigestible_input";
  constructor(description: string) {
    super(
      `a call carrying ${description} cannot be digested: the standing-approval window is identity, so an unencodable value would silently share one person's approval with a call they never saw`,
    );
    this.name = "UndigestibleInputError";
  }
}

/** A value with no prototype, or exactly Object's — everything else is typed. */
function isPlainObject(v: object): boolean {
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * The call's input in a form two equal calls share and two different calls do
 * not, with object keys sorted.
 *
 * Every typed value is encoded BY VALUE under a tag, never by its enumerable
 * keys. Walking keys is what made this wrong: a `Date` has none, so every
 * date collapsed to `{}` and two calls differing only in a timestamp — the
 * `z.coerce.date()` fields on `record_execution`, for instance — shared a
 * digest. The digest is the identity a standing approval is keyed on, so that
 * handed one person's approval to a call they never saw.
 *
 * The tags (`$date`, `$bigint`, …) are why encoding by value is not enough on
 * its own: an untagged ISO string would make `new Date(x)` collide with the
 * string `x`, trading one collision for another.
 *
 * Anything not listed here THROWS rather than being reduced to `{}`, because
 * silently canonicalising an unrecognised type is this same bug waiting for
 * the next type. Throwing is the safe direction for the same reason refusing
 * an over-precise amount is: `skipsThePerson` catches and declines to
 * auto-approve, and `checkMandate` throws to refuse, so both paths leave the
 * call with a person.
 */
function canonicalize(v: unknown): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "number":
    case "boolean":
    case "undefined":
      return v;
    case "bigint":
      // JSON.stringify throws on a BigInt, so this was never a silent
      // collision — it is encoded by value so the call works at all.
      return { $bigint: v.toString() };
    case "function":
      throw new UndigestibleInputError("a function");
    case "symbol":
      throw new UndigestibleInputError("a symbol");
  }
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new UndigestibleInputError("an invalid Date");
    }
    return { $date: v.toISOString() };
  }
  if (v instanceof Map) {
    // Insertion order is not identity, so the entries are sorted by their
    // canonical key.
    return {
      $map: [...v.entries()]
        .map(([k, val]) => [canonicalize(k), canonicalize(val)])
        .sort((a, b) => (JSON.stringify(a[0]) < JSON.stringify(b[0]) ? -1 : 1)),
    };
  }
  if (v instanceof Set) {
    return {
      $set: [...v]
        .map(canonicalize)
        .sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
    };
  }
  if (v instanceof RegExp) return { $regexp: [v.source, v.flags] };
  if (v instanceof URL) return { $url: v.href };
  if (ArrayBuffer.isView(v) || v instanceof ArrayBuffer) {
    // Binary does not belong in a capability input, and guessing an encoding
    // for it would be inventing identity rather than reading it.
    throw new UndigestibleInputError("binary data");
  }
  if (!isPlainObject(v)) {
    throw new UndigestibleInputError(
      `an instance of ${v.constructor?.name ?? "an anonymous class"}`,
    );
  }
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
  );
}

/** sha256 over the call's input with keys sorted, the retry's identity. */
export function inputDigest(input: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(input)) ?? "")
    .digest("hex");
}

/**
 * Every declared measure read off the call, split the way the evaluator reads
 * them: an amount or a count is a value a ceiling is measured against, a text
 * measure is a target an allow list is matched against. A measure the call
 * does not carry is simply absent, and the rule that names it records
 * `measure_unreadable` rather than passing on a value nobody read.
 */
export function readDeclaredMeasures(
  input: unknown,
  declarations: MeasureDeclarations,
): { measures: Record<string, string>; targets: Record<string, string> } {
  const measures: Record<string, string> = {};
  const targets: Record<string, string> = {};
  for (const [name, declaration] of Object.entries(declarations)) {
    const read = readMeasure(input, declaration);
    if (!read.ok) continue;
    if (read.measure.kind === "value") measures[name] = read.measure.value;
    else targets[name] = read.measure.target;
  }
  return { measures, targets };
}

/**
 * When a person last approved this exact call in this workspace, or null. A
 * rule's standing window is measured from it.
 *
 * A call is a capability AND its input, so the lookup is narrowed on both.
 * `inputDigest` is sha256 over the input alone, so two capabilities called
 * with the same payload share a digest — without the capability in the
 * predicate, a person's approval of `archive_thing {"id":"x"}` would satisfy
 * a standing window for `delete_thing {"id":"x"}`, which is the worst thing
 * this subsystem could do.
 *
 * It is NOT narrowed to the agent that raised the call, and that is a
 * different axis: no approval row records one (`list_approvals` reports
 * `chain.agentKey` as null for the same reason), so the column to filter on
 * does not exist. It arrives with the lane that records the agent on an
 * approval. ADR-070 decision 3.
 *
 * Only a PERSON's approval counts (`resolved_by_user_id` is not null), so one
 * auto-approval can never open the window for the next.
 */
export async function lastHumanApprovalOf(
  tx: Tx,
  workspaceId: string,
  capability: string,
  digest: string,
): Promise<Date | null> {
  const ar = schema.approvalRequests;
  const [row] = await tx
    .select({ resolvedAt: ar.resolvedAt })
    .from(ar)
    .where(
      and(
        eq(ar.workspaceId, workspaceId),
        eq(ar.capabilityName, capability),
        eq(ar.inputDigest, digest),
        eq(ar.resolution, "approved"),
        isNotNull(ar.resolvedByUserId),
        isNotNull(ar.resolvedAt),
      ),
    )
    .orderBy(desc(ar.resolvedAt))
    .limit(1);
  return row?.resolvedAt ?? null;
}

interface SubjectArgs {
  capability: string;
  input: unknown;
  workspaceId: string;
  /** The declared tool, when the caller already loaded it. */
  tool?: DeclaredTool | null;
  /** The call's canonical digest, when the caller already computed it. */
  digest?: string;
  /**
   * The clause the subject will be judged against. Given it, the builder
   * skips the standing-approval lookup unless the rule that answers for this
   * call names a window. Omit it and the lookup always runs.
   */
  rules?: readonly AutoApprovalRule[];
  now: Date;
}

/**
 * Assemble everything the auto-approval evaluator reads.
 *
 * `tainted` is false here and nowhere else decides it: no frame in this tree
 * records whether a call's arguments derive from untrusted input (spec §6.7),
 * so the floor that refuses a tainted call is written, tested and live, and
 * the fact it reads binds when the frame that carries taint lands. It is not
 * defaulted to true because that would refuse every auto-approval and make
 * the feature inert.
 */
export async function buildAutoApprovalSubject(
  tx: Tx,
  args: SubjectArgs,
): Promise<AutoApprovalSubject> {
  const tool =
    args.tool !== undefined
      ? args.tool
      : await loadDeclaredTool(tx, args.workspaceId, args.capability);
  const digest = args.digest ?? inputDigest(args.input);
  const { measures, targets } =
    tool === null
      ? { measures: {}, targets: {} }
      : readDeclaredMeasures(args.input, tool.measures);
  const coverage = {
    capability: args.capability,
    tool:
      tool === null
        ? null
        : {
            slug: tool.slug,
            version: tool.version,
            riskGrade: tool.riskGrade,
            sideEffect: tool.sideEffect,
            consequenceTags: tool.consequenceTags,
          },
  };
  // The standing-approval lookup is a scan of approval history sorted by
  // resolved_at, on the decision hot path, and only one condition reads it.
  // When the caller hands over the rules, run it only if the rule that will
  // actually answer for this call names a standing window: a workspace whose
  // rules are all disabled, cover other tools, or set no window pays nothing.
  // Without the rules the lookup still runs, so a caller that does not know
  // them cannot be handed a subject that quietly lacks the fact.
  const rule =
    args.rules === undefined
      ? undefined
      : selectAutoApprovalRule(args.rules, coverage);
  const needsStanding =
    args.rules === undefined ||
    (rule !== undefined && rule.standingWindowMs !== null);
  return {
    ...coverage,
    measures,
    targets,
    tainted: false,
    standingApprovalAt: needsStanding
      ? await lastHumanApprovalOf(tx, args.workspaceId, args.capability, digest)
      : null,
    now: args.now,
  };
}
