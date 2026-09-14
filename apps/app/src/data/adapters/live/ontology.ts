// The live ontology adapter (Batch 3 lane A5).
//
// What is wired, and what is not, after checking plan §3.1 at column level
// against packages/database (the PR body carries the full mapping):
//
//   sources           wired. `list_connections` and `get_connection_mappings`
//                     through the kernel, plus `ingestion.source_connections.cursor`
//                     through withTenantDb (no capability returns the cursor).
//   classes           not backed (M0). `get_schema_registry` + `get_graph_stats`
//                     carry names, relations, sources and entity counts, but the
//                     view model requires `rulesReferencing` and a per-class
//                     `freshAt`, and nothing records either. Waits on those two
//                     fields becoming nullable (PROMOTE), not on a store.
//   versions          not backed (M4). `schema_registry.schema_versions` has no
//                     commit, pull request or author in its read contract; the
//                     view model's versions are git-backed (spec §11.8).
//   repositories      not backed (M4). `ingestion.repository_bindings` carries the
//                     name and production branch only: main/linked role, indexed
//                     commit, issue import, event health, symbols and data-layer
//                     drift are M4 GitHub-link work with no column today.
//   embeddingIndexes  not backed (M4): no Voyage index store.
//
// Every wired read runs in the caller's tenant scope, reads capabilities through
// the kernel as the signed-in person (so IAM decides, and a denial is a
// `denied` value, not an exception), and parses its result through the view
// model before returning it.
import "server-only";
import { schema, withTenantDb } from "@oxagen/database";
import {
  type CapabilityContext,
  CapabilityError,
  getCapability,
  invoke,
} from "@oxagen/oxagen";
import { connectionList } from "@oxagen/oxagen/contracts/connection.list";
import { connectionMappingsGet } from "@oxagen/oxagen/contracts/connection.mappings.get";
import { runInTenantScope } from "@oxagen/tenancy";
import { and, eq, isNull } from "drizzle-orm";
import { notBackedFor } from "@/data/backing";
import { Source } from "@/data/contracts";
import { denied, readError, readOk } from "@/data/not-backed";
import { PAGE_FAILURES } from "@/data/page-states";
import type { OntologyReadPort } from "@/data/ports";
import type { Scope } from "@/data/scope";
import { ContractOutputMismatch, ToolNotRegistered } from "@/server/errors";
import type { ToolContract } from "@/server/invoke";
import { getSession } from "@/server/session";
import { isOrgOnlyScope } from "@/server/tenant-scope";
import {
  type CursorRow,
  isOntologySource,
  type SourceMapping,
  toSource,
} from "./mappers/ontology";

const ONTOLOGY = PAGE_FAILURES.ontology;

/** Kernel codes that mean "this person may not read this", not "the store failed". */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "authz_denied",
  "pending_approval",
  "surface_denied",
  "capability_not_installed",
]);

export function isCapabilityDenial(error: unknown): boolean {
  return error instanceof CapabilityError && DENIAL_CODES.has(error.code);
}

/** The I/O the adapter needs, injected so every branch is unit-tested without stores. */
export type OntologyLiveDeps = {
  /** The signed-in person's user id; null without a session. */
  principal: () => Promise<string | null>;
  /** Invoke a read capability as `userId` in `scope`; the result is parsed by the contract's output schema. */
  invoke: <I, O>(call: {
    scope: Scope;
    userId: string;
    contract: ToolContract<I, O>;
    input: NoInfer<I>;
  }) => Promise<O>;
  /** `ingestion.source_connections.cursor` for the scope's live connections. */
  connectionCursors: (scope: Scope) => Promise<CursorRow[]>;
};

export function createLiveOntology(deps: OntologyLiveDeps): OntologyReadPort {
  return {
    classes: () => Promise.resolve(notBackedFor("ontology", "classes")),

    async sources(scope) {
      // Sources belong to a workspace; an organization-level scope has none.
      if (isOrgOnlyScope(scope))
        return readError("workspace_scope_required", 400);
      const userId = await deps.principal();
      if (userId === null) return denied(ONTOLOGY.permission);
      try {
        const [listed, cursors] = await Promise.all([
          deps.invoke({ scope, userId, contract: connectionList, input: {} }),
          deps.connectionCursors(scope),
        ]);
        const cursorById = new Map(cursors.map((row) => [row.id, row.cursor]));
        const mapped: SourceMapping[] = await Promise.all(
          listed.connections
            .filter(isOntologySource)
            .map(async (connection) => {
              const { mappings } = await deps.invoke({
                scope,
                userId,
                contract: connectionMappingsGet,
                // The public id: get_connection_mappings matches
                // source_connections.public_id only, whatever its contract says.
                input: { connectionId: connection.publicId },
              });
              return toSource({
                connection,
                mappings,
                cursor: cursorById.get(connection.id) ?? null,
              });
            }),
        );
        const sources: Source[] = [];
        for (const row of mapped) {
          // A source that has never synced cannot be shown without inventing a
          // sync time: the whole tab says "not recorded yet" rather than drop
          // it silently or show a fake instant (PROMOTE: nullable lastSyncAt).
          if (!row.ok) return notBackedFor("ontology", "sources");
          sources.push(row.source);
        }
        return readOk(Source.array().parse(sources));
      } catch (error) {
        if (isCapabilityDenial(error)) return denied(ONTOLOGY.permission);
        throw error;
      }
    },

    repositories: () =>
      Promise.resolve(notBackedFor("ontology", "repositories")),
    versions: () => Promise.resolve(notBackedFor("ontology", "versions")),
    embeddingIndexes: () =>
      Promise.resolve(notBackedFor("ontology", "embeddingIndexes")),
  };
}

let handlersRegistered: Promise<unknown> | null = null;

/** The production I/O: the request's session, the kernel, and tenant-scoped Postgres. */
export const liveOntologyDeps: OntologyLiveDeps = {
  async principal() {
    return (await getSession())?.user.id ?? null;
  },

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

  connectionCursors(scope) {
    return runInTenantScope(scope, () =>
      withTenantDb((tx) =>
        tx
          .select({
            id: schema.sourceConnections.id,
            cursor: schema.sourceConnections.cursor,
          })
          .from(schema.sourceConnections)
          .where(
            and(
              eq(schema.sourceConnections.orgId, scope.orgId),
              eq(schema.sourceConnections.workspaceId, scope.workspaceId),
              isNull(schema.sourceConnections.deletedAt),
            ),
          ),
      ),
    );
  },
};

export const liveOntology: OntologyReadPort =
  createLiveOntology(liveOntologyDeps);
