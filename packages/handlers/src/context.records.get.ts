// audit-exempt: read-only — answers one published or appended record; mutates nothing. The kernel capability.invoke_* audit covers access.
//
// get_record (ADR-061): a `cta_` id reads the append; anything else reads the
// record, from its file on the production branch first and from the registry
// mirror only when there is no file to read (see context.record.source.ts).
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  contextRecordsGet,
  type ContextRecordsGetOutput,
} from "@oxagen/oxagen/contracts/context.records.get";
import type {
  AppendKind,
  PublishedRecordView,
  PublishedSharingScope,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import {
  readRecordFromRepo,
  type RecordFileRead,
} from "./context.record.source";
import { steeringDeps, type SteeringDeps } from "./context.steering.deps";
import type { PublishedRecordRow } from "./context.steering.store";
import { publishedRecordView } from "./context.steering.view";

type PublishedDetail = Extract<
  ContextRecordsGetOutput,
  { source: "published" }
>;
type DetailRecord = PublishedDetail["record"];

export function createGetRecordHandler(
  deps: Pick<SteeringDeps, "store" | "github">,
): CapabilityHandler<typeof contextRecordsGet> {
  return async (input, ctx): Promise<ContextRecordsGetOutput> => {
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    if (input.recordId.startsWith("cta_")) {
      const row = await deps.store.findAppend(scope, input.recordId);
      if (!row) throw notFound(input.recordId);
      const proposal = row.proposalId
        ? await deps.store.findProposalById(row.proposalId)
        : null;
      return {
        source: "appended",
        record: {
          id: row.publicId,
          kind: row.kind as AppendKind,
          lineageId: row.lineageId,
          statement: row.statement,
          sharingScope: row.sharingScope as PublishedSharingScope,
          recordHash: row.recordHash,
          sourceRefs: row.sourceRefs,
          evidenceLinks: row.evidenceLinks,
          proposalId: proposal?.publicId ?? null,
          createdAt: row.createdAt.toISOString(),
        },
      };
    }

    const found = await deps.store.findRecord(scope, input.recordId);
    // The lineage is the file's name, so a `ctr_` id can only reach a file
    // through the mirror that knows which lineage it is. Anything else IS a
    // lineage and reaches the file directly — which is what lets a record
    // whose mirror row is gone still be read back.
    const lineageId =
      found?.record.slug ??
      (input.recordId.startsWith("ctr_") ? null : input.recordId);
    const fileRead = lineageId
      ? await readRecordFromRepo(deps.github, scope, lineageId)
      : null;
    if (!found && !fileRead) throw notFound(input.recordId);

    const effect = lineageId
      ? await deps.store.recordEffect(scope, lineageId)
      : null;

    return {
      source: "published",
      record: detailRecord(found?.record ?? null, fileRead),
      backing: fileRead ? "file" : "registry",
      provenance:
        fileRead?.commit && fileRead.commit.committedAt
          ? {
              commit: fileRead.commit.sha,
              authorName: fileRead.commit.authorName,
              authorLogin: fileRead.commit.authorLogin,
              committedAt: new Date(fileRead.commit.committedAt).toISOString(),
              summary: fileRead.commit.summary,
            }
          : null,
      effect,
      versions: (found?.versions ?? []).map((v) => ({
        id: v.publicId,
        version: v.version,
        checksum: v.checksum,
        isLatest: v.isLatest,
        publishedAt: v.publishedAt?.toISOString() ?? null,
      })),
      proposalId: found?.publishedBy?.proposalPublicId ?? null,
      prUrl: found?.publishedBy?.prUrl ?? null,
    };
  };
}

/**
 * The record, with the file winning every field the file carries.
 *
 * The file is what steers a run, so where the two disagree the file is right
 * and the mirror has drifted. The mirror is still read for the fields the file
 * does not carry: a constraint's `require`/`forbid` effect, the version number
 * and its checksum, and the `ctr_` id the rest of the product addresses the
 * record by. Those come back null on a record the mirror has no row for, which
 * is the honest answer — the page renders them as not recorded rather than
 * inventing a default that would read as a fact.
 */
function detailRecord(
  row: PublishedRecordRow | null,
  fileRead: RecordFileRead | null,
): DetailRecord {
  const mirrored: PublishedRecordView | null = row
    ? publishedRecordView(row)
    : null;
  if (!fileRead) {
    if (!mirrored) throw notFound("record");
    return mirrored;
  }
  const { file } = fileRead;
  return {
    id: mirrored?.id ?? null,
    lineageId: file.lineageId,
    title: mirrored?.title ?? file.lineageId,
    kind: file.kind,
    force: file.force,
    constraintEffect: mirrored?.constraintEffect ?? null,
    sharingScope: file.sharingScope,
    statement: file.statement,
    // The file's `status` is Stella's vocabulary (`active`); the registry's is
    // the same three words, so an unknown value falls back to the mirror
    // rather than being coerced into one of them.
    status:
      file.status === "active" ||
      file.status === "retired" ||
      file.status === "superseded"
        ? file.status
        : (mirrored?.status ?? "active"),
    version: mirrored?.version ?? null,
    checksum: mirrored?.checksum ?? null,
    commit: fileRead.commit?.sha ?? mirrored?.commit ?? null,
    path: fileRead.path,
    publishedAt: fileRead.commit?.committedAt
      ? new Date(fileRead.commit.committedAt).toISOString()
      : (mirrored?.publishedAt ?? null),
    updatedAt: mirrored?.updatedAt ?? null,
  };
}

function notFound(id: string): HandlerError {
  return new HandlerError({
    code: "not_found",
    reason: "record_not_found",
    message: `No record ${id} in this workspace`,
  });
}

export const getRecordHandler = createGetRecordHandler(steeringDeps());
