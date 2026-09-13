// The live steering adapter (Batch 3, lane A6).
//
//   records               wired, capability first. `list_context_records` is
//                         invoked through the kernel as the signed-in person, so
//                         IAM (default deny, org Owner/Admin and workspace
//                         Owner/Admin/Member, custom roles, emergency denies)
//                         decides who sees which records, and a refusal is a
//                         `denied("steering.read")` value. The capability does
//                         not carry the active version's body, provenance or
//                         publication date, so those columns are read after it,
//                         through withTenantDb, restricted to the record ids the
//                         capability returned (PROMOTE: carry them in the
//                         contract, and drop the supplement read). The joined
//                         rows are mapped by ./mappers/steering.ts through the
//                         SteeringRecord schema.
//   proposals             not backed (M3). agent.context_promotions is the
//                         applied lifecycle ledger (promote / retire / supersede,
//                         each already decided): it has no candidate state, no
//                         support, no source and no Context PR, so a ledger
//                         entry shown as a proposal would claim a review that
//                         never happened. Proposals arrive with the promoter (M3).
//   effect, retirement    not backed (M3 effect metrics, src/data/backing.ts).
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import {
  type ContextRecordListOutput,
  contextRecordList,
} from "@oxagen/oxagen/contracts/context.record.list";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, inArray, isNull, max } from "drizzle-orm";
import { notBackedFor } from "@/data/backing";
import { NO_GAP, denied, notBacked, readError } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { SteeringReadPort } from "@/data/ports";
import { ORG_ONLY_WORKSPACE_ID, type Scope } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { type ContextRecordRow, readSteeringRecords } from "./mappers/steering";

const STEERING = PAGE_FAILURES.steering;

/** Steering is a workspace page: the organization-only sentinel names no workspace. */
export const WORKSPACE_SCOPE_REQUIRED = "workspace_scope_required";

/** The contract's largest page; the adapter pages until `total` is reached. */
export const RECORD_PAGE_SIZE = 200;

/** Ids per supplement query, well under Postgres' bind-parameter limit. */
export const SUPPLEMENT_CHUNK = 500;

/** Kernel codes that mean "this person may not read this", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

// PROMOTE: the same predicate lives in the ontology adapter (lane A5).
export function isCapabilityDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

type ListedRecord = ContextRecordListOutput["records"][number];

/** The columns the capability does not return, for one record's active version. */
export type RecordSupplement = Pick<
  ContextRecordRow,
  "publicId" | "body" | "provenance" | "versionPublishedAt" | "promotedAt"
>;

/** The I/O the adapter needs, injected so every branch is unit-tested without stores. */
export type SteeringLiveDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  /** Invoke a read capability as `userId` in `scope`; the result is parsed by the contract's output schema. */
  invoke: <I, O>(call: {
    scope: Scope;
    userId: string;
    contract: ToolContract<I, O>;
    input: NoInfer<I>;
  }) => Promise<O>;
  /** Active-version columns for exactly these record public ids in the scope. */
  recordSupplements: (
    scope: Scope,
    publicIds: readonly string[],
  ) => Promise<RecordSupplement[]>;
};

/**
 * Every record the capability lets this person see, page by page. Returns null
 * when the pages do not add up to the total the capability reported: a
 * truncated list would read as the whole steering set.
 */
async function listAllRecords(
  deps: SteeringLiveDeps,
  scope: Scope,
  userId: string,
): Promise<ListedRecord[] | null> {
  const byId = new Map<string, ListedRecord>();
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  while (offset < total) {
    const page = await deps.invoke({
      scope,
      userId,
      contract: contextRecordList,
      input: { limit: RECORD_PAGE_SIZE, offset },
    });
    total = page.total;
    for (const record of page.records) byId.set(record.id, record);
    if (page.records.length === 0) break;
    offset += page.records.length;
  }
  return byId.size < total ? null : [...byId.values()];
}

export function createLiveSteering(deps: SteeringLiveDeps): SteeringReadPort {
  return {
    async records(scope) {
      if (scope.workspaceId === ORG_ONLY_WORKSPACE_ID)
        return readError(WORKSPACE_SCOPE_REQUIRED, 400);
      const userId = await deps.principal();
      if (userId === null) return denied(STEERING.permission);

      let listed: ListedRecord[] | null;
      try {
        listed = await listAllRecords(deps, scope, userId);
      } catch (error) {
        if (isCapabilityDenial(error)) return denied(STEERING.permission);
        throw error;
      }
      if (listed === null)
        return readError(STEERING.error.code, STEERING.error.status);

      // A record with no pinned active version has published nothing yet.
      const published = listed.filter((record) => record.version !== null);
      const ids = published.map((record) => record.id);
      const supplements =
        ids.length === 0 ? [] : await deps.recordSupplements(scope, ids);
      const byId = new Map(supplements.map((s) => [s.publicId, s]));

      const rows: ContextRecordRow[] = [];
      for (const record of published) {
        const supplement = byId.get(record.id);
        // The capability authorized a record the store no longer pins (deleted
        // or unpinned between the two reads): the set is not whole, so it is
        // not shown, and nothing is filled in.
        if (!supplement)
          return readError(STEERING.error.code, STEERING.error.status);
        rows.push({
          ...supplement,
          publicId: record.id,
          slug: record.recordId,
          status: record.status,
        });
      }
      return readSteeringRecords(rows);
    },
    proposals: () => Promise.resolve(notBacked("M3", NO_GAP)),
    effect: () => Promise.resolve(notBackedFor("steering", "effect")),
    retirementCandidates: () =>
      Promise.resolve(notBackedFor("steering", "retirementCandidates")),
  };
}

/** The active version's body, provenance and promotion date for these records. */
export async function selectRecordSupplements(
  scope: Scope,
  publicIds: readonly string[],
): Promise<RecordSupplement[]> {
  const records = schema.contextRecords;
  const versions = schema.contextRecordVersions;
  const promotions = schema.contextPromotions;
  const rows: RecordSupplement[] = [];
  for (let start = 0; start < publicIds.length; start += SUPPLEMENT_CHUNK) {
    const chunk = publicIds.slice(start, start + SUPPLEMENT_CHUNK);
    const page = await runInTenantScope(scope, () =>
      withTenantDb(async (tx) => {
        const promoted = tx
          .select({
            recordId: promotions.recordId,
            versionId: promotions.versionId,
            promotedAt: max(promotions.createdAt).as("promoted_at"),
          })
          .from(promotions)
          .where(eq(promotions.action, "promote"))
          .groupBy(promotions.recordId, promotions.versionId)
          .as("promoted");
        return tx
          .select({
            publicId: records.publicId,
            body: versions.body,
            provenance: versions.provenance,
            versionPublishedAt: versions.publishedAt,
            promotedAt: promoted.promotedAt,
          })
          .from(records)
          .innerJoin(versions, eq(versions.id, records.activeVersionId))
          .leftJoin(
            promoted,
            and(
              eq(promoted.recordId, records.id),
              eq(promoted.versionId, records.activeVersionId),
            ),
          )
          .where(
            and(
              eq(records.orgId, scope.orgId),
              eq(records.workspaceId, scope.workspaceId),
              isNull(records.deletedAt),
              inArray(records.publicId, chunk),
            ),
          );
      }),
    );
    rows.push(...page);
  }
  return rows;
}

let handlersRegistered: Promise<unknown> | null = null;

/** The production I/O: the request's session, the kernel, and tenant-scoped Postgres. */
export const liveSteeringDeps: SteeringLiveDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },

  // PROMOTE: the same seam lives in the ontology adapter (lane A5); a shared
  // read-invoke beside src/server/invoke.ts should replace both.
  async invoke({ scope, userId, contract, input }) {
    // The handler registry must be loaded before the first invoke(), or the
    // kernel finds no handler (the same rule src/server/invoke.ts follows).
    handlersRegistered ??= import("@oxagen/handlers/register");
    await handlersRegistered;
    if (!getCapability(contract.name))
      throw new ToolNotRegistered(contract.name);
    const ctx: CapabilityContext = {
      orgId: scope.orgId,
      workspaceId: scope.workspaceId,
      userId,
      apiKeyId: null,
      requestId: crypto.randomUUID(),
      surface: "app",
      messageId: null,
    };
    const raw = await runInTenantScope(scope, () =>
      invoke(contract.name, input, ctx),
    );
    const parsed = contract.output.safeParse(raw);
    if (!parsed.success)
      throw new ContractOutputMismatch(contract.name, parsed.error.issues);
    return parsed.data;
  },

  recordSupplements: selectRecordSupplements,
};

export const liveSteering: SteeringReadPort =
  createLiveSteering(liveSteeringDeps);
