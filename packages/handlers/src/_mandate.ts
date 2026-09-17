// Shared pieces of the six mandate handlers (MC spec §6.9 part 3, ADR-059):
// the agent lookup, the denied-by-construction
// check of tool patterns against declared measures, the readability rule,
// and the row → contract mapping with remaining authority from the ledger.
//
// Every lookup is workspace-scoped and runs in the caller's tenant
// transaction; only public ids leave through the mapping.

import { schema, type Tx } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import { unionConsequenceTags } from "@oxagen/oxagen/contracts/tool.classification";
import { HandlerError, type CheckedContext } from "@oxagen/oxagen";
import {
  CALLS_MEASURE,
  measureDeclarationsSchema,
  type MandateLimits,
  type MandateOut,
  type MandateTargets,
  type OrgRoleName,
} from "@oxagen/oxagen/mandates/schemas";
import {
  parseMandateRow,
  readAuthority,
  toolMatches,
  type MandateRecord,
} from "@oxagen/rules";
import { and, eq, inArray, isNull } from "drizzle-orm";

/** The org roles that read every mandate in the workspace (the accountable office). */
export const ACCOUNTABLE_ORG_ROLES: readonly OrgRoleName[] = [
  "Owner",
  "Admin",
  "Billing",
  "Compliance",
];

export function requireWorkspace(ctx: CheckedContext, name: string): string {
  if (!ctx.workspaceId) {
    throw new Error(`[${name}] workspaceId is required (scoped capability)`);
  }
  return ctx.workspaceId;
}

interface AgentRef {
  id: string;
  publicId: string;
  slug: string;
  principalId: string;
  createdById: string | null;
}

/** The agent an `agt_…` id names in this workspace, with its delegated principal. */
export async function resolveAgent(
  tx: Tx,
  workspaceId: string,
  agentPublicId: string,
): Promise<AgentRef> {
  const [row] = await tx
    .select({
      id: schema.agents.id,
      publicId: schema.agents.publicId,
      slug: schema.agents.slug,
      principalId: schema.agents.principalId,
      createdById: schema.agents.createdById,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        eq(schema.agents.publicId, agentPublicId),
        isNull(schema.agents.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "agent_not_found",
      message: `No agent ${agentPublicId} in this workspace`,
    });
  }
  if (row.principalId === null) {
    throw new HandlerError({
      code: "conflict",
      reason: "agent_has_no_principal",
      message: `Agent ${agentPublicId} has no delegated principal to bind a mandate to`,
    });
  }
  return { ...row, principalId: row.principalId };
}

/**
 * Denied by construction (§6.9 rule 1): every tool pattern matches at least
 * one declared, enabled tool whose active version carries a consequence tag,
 * and every matched tool declares a measure for every limit and every target
 * the mandate names. `calls` is built in and needs no declaration. An
 * untagged tool is left out because the gate has no opinion on its calls
 * (`decideMandate`), so a mandate naming it would govern nothing.
 */
export async function assertToolsDeclareMeasures(
  tx: Tx,
  workspaceId: string,
  args: {
    tools: readonly string[];
    limits: MandateLimits;
    targets: MandateTargets;
  },
): Promise<void> {
  const declared = await tx
    .select({
      slug: schema.tools.slug,
      version: schema.toolVersions.versionNumber,
      measures: schema.toolVersions.measures,
      consequenceTags: schema.toolVersions.consequenceTags,
      classification: schema.toolVersions.classification,
    })
    .from(schema.tools)
    .innerJoin(
      schema.toolVersions,
      eq(schema.toolVersions.id, schema.tools.activeVersionId),
    )
    .where(
      and(
        eq(schema.tools.workspaceId, workspaceId),
        eq(schema.tools.enabled, true),
        isNull(schema.tools.deletedAt),
      ),
    );
  const limitMeasures = Object.keys(args.limits).filter(
    (k) => k !== CALLS_MEASURE,
  );
  // The built-in measure is exempt from the declared-measure check below
  // because no tool declares it: every call draws exactly one, whatever a tool
  // says. That exemption is about the *declaration*, not about the *unit* —
  // `calls` has a correct denomination and it is its own name. Without this,
  // `{ calls: { perPeriod: "250000000", currencyOrUnit: "USD" } }` is accepted
  // by the contract, enforced by the gate as a ceiling of 250 million calls,
  // and rendered by every screen as $250.00: the same two-halves-a-billion-
  // apart failure the declared-measure unit check closes, reached through the
  // exemption beside it. An exemption from a check needs its own rule rather
  // than silence, so this one is checked against a constant where the others
  // are checked against a declaration.
  const callsLimit = args.limits[CALLS_MEASURE];
  if (callsLimit !== undefined && callsLimit.currencyOrUnit !== CALLS_MEASURE) {
    throw new HandlerError({
      code: "conflict",
      reason: "measure_unit_mismatch",
      message: `the built-in "${CALLS_MEASURE}" measure is denominated in ${CALLS_MEASURE}; the mandate denominates its limit in ${callsLimit.currencyOrUnit}`,
    });
  }
  const targetMeasures = Object.keys(args.targets);
  for (const pattern of args.tools) {
    // "Tagged" means EFFECTIVELY tagged — the declared column unioned with the
    // classified jsonb, through the one function every reader of this fact
    // uses. `decideMandate` governs a call by the same union, so reading only
    // the column here made the two disagree about which tools a mandate can
    // name: a tool with no declared tag that an administrator classified
    // `moves_money` is governed at call time and was refused at grant time as
    // `no_tool_matches`.
    const matched = declared.filter(
      (t) =>
        unionConsequenceTags(t).length > 0 &&
        toolMatches([pattern], t.slug, t.version),
    );
    if (matched.length === 0) {
      throw new HandlerError({
        code: "conflict",
        reason: "no_tool_matches",
        message: `Tool pattern "${pattern}" matches no declared tool with a consequence tag in this workspace`,
      });
    }
    for (const tool of matched) {
      const measures = measureDeclarationsSchema.safeParse(tool.measures);
      const declaredMeasures = measures.success ? measures.data : {};
      for (const name of limitMeasures) {
        const d = declaredMeasures[name];
        if (d === undefined || d.type === "text") {
          throw new HandlerError({
            code: "conflict",
            reason: "measure_not_declared",
            message: `${tool.slug}@${tool.version} declares no measure "${name}" for the limit the mandate names`,
          });
        }
        // The unit is the third field of the same declaration, and the gate
        // reads the call by the declaration: `readMeasure` takes a count as
        // the tool reported it, in the tool's unit, and compares it against
        // this limit's figure. A limit denominated in anything else is
        // therefore enforced in the tool's unit while every screen shows the
        // operator's — a tool declaring `storage` in GB accepts a limit read
        // by a person as "50 bytes" and admits a call of 50 GB. Both halves
        // are self-consistent and they differ by a billion, which is why this
        // is checked here, where the declaration is in hand, and not at a
        // caller: every path that writes a measure limit comes through here.
        const asked = args.limits[name]?.currencyOrUnit;
        if (asked !== undefined && asked !== d.unit) {
          throw new HandlerError({
            code: "conflict",
            reason: "measure_unit_mismatch",
            message: `${tool.slug}@${tool.version} declares measure "${name}" in ${d.unit}; the mandate denominates its limit in ${asked}`,
          });
        }
      }
      for (const name of targetMeasures) {
        if (declaredMeasures[name] === undefined) {
          throw new HandlerError({
            code: "conflict",
            reason: "measure_not_declared",
            message: `${tool.slug}@${tool.version} declares no measure "${name}" for the target the mandate names`,
          });
        }
      }
    }
  }
}

/**
 * Who may read: an accountable org role reads every mandate; any other
 * acting user (the signed-in user, or the API key's creator) reads the
 * mandates of agents they created. Returns null
 * for the office, or the user id to filter agents by.
 */
export async function readerFilter(
  ctx: CheckedContext,
): Promise<string | null> {
  const actingUserId = await resolveActingUserId(ctx);
  try {
    await assertOrgRole(
      { ...ctx, userId: actingUserId },
      { org: ACCOUNTABLE_ORG_ROLES },
    );
    return null;
  } catch (err) {
    if (
      err instanceof HandlerError &&
      err.reason === "org_role_required" &&
      actingUserId
    ) {
      return actingUserId;
    }
    throw err;
  }
}

/** Public ids of the users a set of mandate rows name. */
async function userPublicIds(
  tx: Tx,
  ids: readonly (string | null)[],
): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => v !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({ id: schema.users.id, publicId: schema.users.publicId })
    .from(schema.users)
    .where(inArray(schema.users.id, wanted));
  return new Map(rows.map((r) => [r.id, r.publicId]));
}

/** Agents by principal id, for the rows' `agentId` and `agentSlug`. */
async function agentsByPrincipal(
  tx: Tx,
  workspaceId: string,
  principalIds: readonly string[],
): Promise<Map<string, { publicId: string; slug: string }>> {
  const wanted = [...new Set(principalIds)];
  if (wanted.length === 0) return new Map();
  const rows = await tx
    .select({
      principalId: schema.agents.principalId,
      publicId: schema.agents.publicId,
      slug: schema.agents.slug,
    })
    .from(schema.agents)
    .where(
      and(
        eq(schema.agents.workspaceId, workspaceId),
        inArray(schema.agents.principalId, wanted),
      ),
    );
  const out = new Map<string, { publicId: string; slug: string }>();
  for (const r of rows) {
    if (r.principalId)
      out.set(r.principalId, { publicId: r.publicId, slug: r.slug });
  }
  return out;
}

/** Map mandate rows to the contract shape, with authority read from the ledger. */
export async function mapMandates(
  tx: Tx,
  workspaceId: string,
  rows: readonly (typeof schema.mandates.$inferSelect)[],
): Promise<MandateOut[]> {
  const users = await userPublicIds(
    tx,
    rows.flatMap((r) => [r.requestedBy, r.grantedBy, r.revokedBy]),
  );
  const agents = await agentsByPrincipal(
    tx,
    workspaceId,
    rows.map((r) => r.agentPrincipalId),
  );
  const out: MandateOut[] = [];
  for (const row of rows) {
    const record: MandateRecord = parseMandateRow(row);
    const agent = agents.get(row.agentPrincipalId);
    if (!agent) {
      throw new HandlerError({
        code: "not_found",
        reason: "agent_not_found",
        message: `The agent mandate ${row.publicId} binds is not in this workspace`,
      });
    }
    out.push({
      id: row.publicId,
      agentId: agent.publicId,
      agentSlug: agent.slug,
      requestedBy: row.requestedBy
        ? (users.get(row.requestedBy) ?? null)
        : null,
      grantedBy: row.grantedBy ? (users.get(row.grantedBy) ?? null) : null,
      roleAtGrant: row.roleAtGrant,
      consequenceTags: record.consequenceTags,
      limits: record.limits,
      targets: record.targets,
      tools: record.tools,
      approval: record.approval,
      purpose: row.purpose,
      validFrom: row.validFrom.toISOString(),
      validTo: row.validTo.toISOString(),
      status: record.status,
      revokedBy: row.revokedBy ? (users.get(row.revokedBy) ?? null) : null,
      revokedReason: row.revokedReason,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      authority: await readAuthority(tx, record),
    });
  }
  return out;
}

/** One mandate row by public id in this workspace, or a not_found refusal. */
export async function loadMandateRow(
  tx: Tx,
  workspaceId: string,
  publicId: string,
): Promise<typeof schema.mandates.$inferSelect> {
  const [row] = await tx
    .select()
    .from(schema.mandates)
    .where(
      and(
        eq(schema.mandates.workspaceId, workspaceId),
        eq(schema.mandates.publicId, publicId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "mandate_not_found",
      message: `No mandate ${publicId} in this workspace`,
    });
  }
  return row;
}
