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
import type { AutoApprovalSubject } from "./auto-approval";
import { readMeasure } from "./mandates/measures";

/** The declared tool the capability resolves to, with its active version. */
export interface DeclaredTool {
  slug: string;
  version: number;
  riskGrade: string;
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
    riskGrade: row.riskGrade,
    consequenceTags: row.consequenceTags,
    measures: measureDeclarationsSchema.parse(row.measures),
    effectIdPath: row.effectIdPath,
  };
}

/** sha256 over the call's input with keys sorted, the retry's identity. */
export function inputDigest(input: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v !== null && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v as object)
              .sort()
              .map((k) => [k, sort((v as Record<string, unknown>)[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(sort(input)) ?? "")
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
 * When a person last approved this exact call digest in this workspace, or
 * null. A rule's standing window is measured from it.
 *
 * Bound to the workspace and the digest and to nothing narrower, because no
 * approval row records the agent that raised the call (`list_approvals`
 * reports `chain.agentKey` as null for the same reason). ADR-070 decision 3.
 */
export async function lastHumanApprovalOf(
  tx: Tx,
  workspaceId: string,
  digest: string,
): Promise<Date | null> {
  const ar = schema.approvalRequests;
  const [row] = await tx
    .select({ resolvedAt: ar.resolvedAt })
    .from(ar)
    .where(
      and(
        eq(ar.workspaceId, workspaceId),
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
  return {
    capability: args.capability,
    tool:
      tool === null
        ? null
        : {
            slug: tool.slug,
            version: tool.version,
            riskGrade: tool.riskGrade,
            consequenceTags: tool.consequenceTags,
          },
    measures,
    targets,
    tainted: false,
    standingApprovalAt: await lastHumanApprovalOf(tx, args.workspaceId, digest),
    now: args.now,
  };
}
