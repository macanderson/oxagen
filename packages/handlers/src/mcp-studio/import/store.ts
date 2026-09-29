// store.ts: Studio's drafts in Postgres (lane M11, ADR-224).
//
// One live mcp.studio_drafts row holds the edits a person has staged on one
// server folder: the ops, server.toml, and the source the ops import from.
// Review reads the row, opens the steering PR, and records the PR on it.
//
// A save names the revision it builds on:
//   - 0 creates a draft. It is refused with `conflict` (draft_revision_stale)
//     while a live draft for the server exists, and never overwrites it.
//   - N is refused unless the live draft is at revision N.
//   - No revision saves over whatever is stored.
// A soft-deleted draft does not count as live. Each save raises the revision
// by one. Recording the PR does not.
//
// The row holds no credential. The save handler refuses a test that carries
// one before it reaches this store.
import { HandlerError } from "@oxagen/oxagen";
import {
  studioDraftOpSchema,
  studioSourceBytes,
  studioSourceSchema,
  type StudioDraft,
  type StudioDraftOp,
  type StudioSource,
} from "@oxagen/oxagen/contracts/tool.studio.draft.save";
import {
  isUniqueViolation,
  schema,
  type Tx,
  withTenantDb,
} from "@oxagen/database";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";

const drafts = schema.mcpStudioDrafts;
const servers = schema.mcpServers;

export interface StudioDraftScope {
  orgId: string;
  workspaceId: string;
}

/** The steering PR a Review opened from the draft. */
export interface StudioDraftPr {
  number: number;
  url: string;
  branch: string;
}

/** A draft as the store holds it, with its source in full. */
export interface StoredStudioDraft {
  server: string;
  /** `mcs_…` of the registered server, or null. */
  serverId: string | null;
  ops: StudioDraftOp[];
  serverToml: string | null;
  source: StudioSource | null;
  revision: number;
  pr: StudioDraftPr | null;
  updatedAt: Date;
}

export interface SaveStudioDraftInput {
  server: string;
  serverId?: string;
  ops: StudioDraftOp[];
  serverToml?: string;
  source?: StudioSource;
  revision?: number;
  /** The person who saved, recorded on the row. */
  actorUserId: string | null;
}

export interface StudioDraftStore {
  get(scope: StudioDraftScope, server: string): Promise<StoredStudioDraft | null>;
  save(scope: StudioDraftScope, input: SaveStudioDraftInput): Promise<StoredStudioDraft>;
  /** Record the PR a Review opened. The revision stays as it is. */
  recordPr(scope: StudioDraftScope, server: string, pr: StudioDraftPr): Promise<void>;
}

/** The draft as the capabilities return it: the source summarized, never echoed. */
export function draftView(draft: StoredStudioDraft): StudioDraft {
  return {
    server: draft.server,
    serverId: draft.serverId,
    ops: draft.ops,
    serverToml: draft.serverToml,
    source:
      draft.source === null
        ? null
        : { type: draft.source.type, bytes: studioSourceBytes(draft.source) },
    revision: draft.revision,
    pr: draft.pr,
    updatedAt: draft.updatedAt.toISOString(),
  };
}

export function staleRevision(message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason: "draft_revision_stale", message });
}

const opsSchema = z.array(studioDraftOpSchema);

type Row = {
  server: string;
  serverId: string | null;
  ops: unknown;
  serverToml: string | null;
  source: unknown;
  revision: number;
  prNumber: number | null;
  prUrl: string | null;
  prBranch: string | null;
  updatedAt: Date;
};

/** A stored row as a draft. A row that no longer parses is refused, not guessed at. */
function fromRow(row: Row): StoredStudioDraft {
  const ops = opsSchema.safeParse(row.ops);
  const source = row.source === null ? null : studioSourceSchema.safeParse(row.source);
  if (!ops.success || (source !== null && !source.success)) {
    throw new HandlerError({
      code: "conflict",
      reason: "draft_unreadable",
      message: `The draft for ${row.server} no longer matches the draft format. Save it again from Studio.`,
    });
  }
  return {
    server: row.server,
    serverId: row.serverId,
    ops: ops.data,
    serverToml: row.serverToml,
    source: source === null ? null : source.data!,
    revision: row.revision,
    pr:
      row.prNumber !== null && row.prUrl !== null && row.prBranch !== null
        ? { number: row.prNumber, url: row.prUrl, branch: row.prBranch }
        : null,
    updatedAt: row.updatedAt,
  };
}

const columns = {
  id: drafts.id,
  server: drafts.serverName,
  serverId: servers.publicId,
  ops: drafts.ops,
  serverToml: drafts.serverToml,
  source: drafts.source,
  revision: drafts.revision,
  prNumber: drafts.prNumber,
  prUrl: drafts.prUrl,
  prBranch: drafts.prBranch,
  updatedAt: drafts.updatedAt,
};

function liveDraft(scope: StudioDraftScope, server: string) {
  return and(
    eq(drafts.orgId, scope.orgId),
    eq(drafts.workspaceId, scope.workspaceId),
    eq(drafts.serverName, server),
    isNull(drafts.deletedAt),
  );
}

async function readLive(
  tx: Tx,
  scope: StudioDraftScope,
  server: string,
  lock: boolean,
): Promise<(Row & { id: string }) | null> {
  if (lock) {
    // Lock the draft row in its own query. Postgres cannot lock the nullable
    // side of the left join below, and it refuses the schema-qualified name
    // Drizzle writes for `FOR UPDATE OF`. The joined read that follows starts
    // after the lock is held, so it sees what any earlier save committed.
    await tx
      .select({ id: drafts.id })
      .from(drafts)
      .where(liveDraft(scope, server))
      .limit(1)
      .for("update");
  }
  const [row] = await tx
    .select(columns)
    .from(drafts)
    .leftJoin(servers, eq(servers.id, drafts.mcpServerId))
    .where(liveDraft(scope, server))
    .limit(1);
  return (row as (Row & { id: string }) | undefined) ?? null;
}

/** The internal id of the registered server `publicId` names in this workspace. */
async function serverRowId(
  tx: Tx,
  scope: StudioDraftScope,
  publicId: string,
): Promise<string> {
  const [row] = await tx
    .select({ id: servers.id })
    .from(servers)
    .where(
      and(
        eq(servers.orgId, scope.orgId),
        eq(servers.workspaceId, scope.workspaceId),
        eq(servers.publicId, publicId),
        isNull(servers.deletedAt),
      ),
    )
    .limit(1);
  if (!row) {
    throw new HandlerError({
      code: "not_found",
      reason: "server_not_found",
      message: `No MCP server ${publicId} in this workspace.`,
    });
  }
  return row.id;
}

/** The store over one tenant transaction per call. */
export function postgresStudioDraftStore(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> = withTenantDb,
  now: () => Date = () => new Date(),
): StudioDraftStore {
  return {
    async get(scope, server) {
      return run(async (tx) => {
        const row = await readLive(tx, scope, server, false);
        return row === null ? null : fromRow(row);
      });
    },

    async save(scope, input) {
      try {
        return await run(async (tx) => {
          const row = await readLive(tx, scope, input.server, true);
          if (input.revision === 0 && row !== null) {
            throw staleRevision(
              `A draft for ${input.server} already exists at revision ${row.revision}. Read it, apply your edits to it, and save at that revision.`,
            );
          }
          if (input.revision !== undefined && input.revision > 0 && row?.revision !== input.revision) {
            throw staleRevision(
              row === null
                ? `No draft for ${input.server} exists. Save at revision 0 to start one.`
                : `The draft for ${input.server} is at revision ${row.revision}, not ${input.revision}. Read it, apply your edits to it, and save again.`,
            );
          }
          const mcpServerId =
            input.serverId === undefined
              ? undefined
              : await serverRowId(tx, scope, input.serverId);
          const at = now();

          let id: string;
          if (row === null) {
            const [inserted] = await tx
              .insert(drafts)
              .values({
                orgId: scope.orgId,
                workspaceId: scope.workspaceId,
                serverName: input.server,
                mcpServerId: mcpServerId ?? null,
                ops: input.ops,
                serverToml: input.serverToml ?? null,
                source: input.source ?? null,
                revision: 1,
                createdAt: at,
                updatedAt: at,
                createdById: input.actorUserId,
                updatedById: input.actorUserId,
              })
              .returning({ id: drafts.id });
            id = inserted!.id;
          } else {
            id = row.id;
            await tx
              .update(drafts)
              .set({
                ops: input.ops,
                revision: row.revision + 1,
                updatedAt: at,
                updatedById: input.actorUserId,
                ...(mcpServerId === undefined ? {} : { mcpServerId }),
                ...(input.serverToml === undefined ? {} : { serverToml: input.serverToml }),
                ...(input.source === undefined ? {} : { source: input.source }),
              })
              .where(eq(drafts.id, id));
          }
          const [saved] = await tx
            .select(columns)
            .from(drafts)
            .leftJoin(servers, eq(servers.id, drafts.mcpServerId))
            .where(eq(drafts.id, id))
            .limit(1);
          return fromRow(saved as Row);
        });
      } catch (err) {
        // Two first saves raced: the other one holds the name now.
        if (isUniqueViolation(err, "mcp_studio_drafts_server_uq")) {
          throw staleRevision(
            `Another save created the draft for ${input.server} first. Read it, apply your edits to it, and save at its revision.`,
          );
        }
        throw err;
      }
    },

    async recordPr(scope, server, pr) {
      await run((tx) =>
        tx
          .update(drafts)
          .set({ prNumber: pr.number, prUrl: pr.url, prBranch: pr.branch })
          .where(liveDraft(scope, server)),
      );
    },
  };
}
