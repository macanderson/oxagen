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
import {
  effectiveSideEffect,
  unionConsequenceTags,
} from "@oxagen/oxagen/contracts/tool.classification";
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
    // Both halves, through the one function every reader of this fact uses
    // (@oxagen/oxagen/contracts/tool.classification). The floor and the
    // rule-authoring gate read the same union, so a rule cannot be authored
    // under a gate that cannot see a tag the floor will later enforce.
    sideEffect: effectiveSideEffect(row),
    consequenceTags: unionConsequenceTags(row),
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

/** A key that already starts with `$`, and so has to be escaped past the markers. */
const MARKER_LIKE = /^\$/;

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
    case "boolean":
      return v;
    case "number":
      // NaN and the infinities are not JSON: `JSON.stringify` writes them as
      // `null`, so every one of them would share a digest with each other and
      // with a literal null. They have no business in a capability input, so
      // this refuses rather than inventing an encoding for them.
      if (!Number.isFinite(v)) {
        throw new UndigestibleInputError(`the non-finite number ${String(v)}`);
      }
      return v;
    case "undefined":
      // Encoded, not dropped. `JSON.stringify` removes an undefined property
      // and rewrites an undefined array element as `null`, so `{ x: undefined }`
      // hashed as `{}` and `[undefined]` as `[null]`. Unlike the non-finite
      // numbers this one is reachable from ordinary validated output, so it
      // gets an encoding rather than a refusal — unforgeable under the same
      // escaping rule as the others.
      return { $undefined: true };
    case "bigint":
      // JSON.stringify throws on a BigInt, so this was never a silent
      // collision — it is encoded by value so the call works at all.
      return { $bigint: v.toString() };
    case "function":
      throw new UndigestibleInputError("a function");
    case "symbol":
      throw new UndigestibleInputError("a symbol");
  }
  // `Array.from`, not `.map`: a sparse array's holes are SKIPPED by `.map`
  // and survive to `JSON.stringify` as `null`, so `[1, , 3]` hashed the same
  // as `[1, null, 3]`. `Array.from` materialises a hole as undefined, which
  // the branch above then encodes.
  if (Array.isArray(v)) return Array.from(v, (x) => canonicalize(x));
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
  // Escape any user key that could be mistaken for one of the markers above.
  // `$date` → `$$date`, `$$date` → `$$$date`, everything else untouched.
  //
  // The property this establishes, and the reason the markers alone were not
  // enough: NO USER INPUT CAN PRODUCE THE ENCODER'S OUTPUT. A marker is
  // exactly one `$` followed by a name; escaping maps a user key of n leading
  // `$` (n >= 1) to n + 1, so a user key can only ever arrive with two or
  // more and never collides with a marker's one. The map is total and
  // injective, so two different inputs still cannot share a digest.
  //
  // Reachable rather than theoretical: `record_execution` takes
  // `inputPayload: z.unknown()`, so the key space is caller-controlled and a
  // plain `{ $date: "…" }` would otherwise be byte-identical to a real Date's
  // encoding and inherit its standing approval.
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [
        MARKER_LIKE.test(k) ? `$${k}` : k,
        canonicalize((v as Record<string, unknown>)[k]),
      ]),
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
