// steering.memory_pr_records.list.ts: list_memory_pr_records, the records of
// one memory PR for the memory PR review card (memory-collection spec,
// Capabilities; ADR-206, ADR-248).
//
// The memory PR row lists each record the PR proposes or archives, and the
// memories each one cites. While the PR is open, the handler reads its
// branch on the steering host: a record whose file is there gives its label
// and description, and a proposed record whose file is gone was dropped from
// the PR. A branch that cannot be read is logged, and the records come back
// from the row alone.
import type { CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoryPrRecordsList,
  type SteeringMemoryPrRecordsListOutput,
} from "@oxagen/oxagen/contracts/steering.memory_pr_records.list";
import { HandlerError } from "@oxagen/oxagen/handler-error";
import { STEERING_DIR } from "@oxagen/oxagen/steering-repo/paths";
import { readSteeringRecord } from "@oxagen/oxagen/steering-repo/record";
import type { SteeringHost } from "./context.steering.github";
import { assertContractRole } from "./lib/capability-role-guard";
import { logger } from "./logger";
import { memoryDescription, memoryLabel } from "./memory/naming";
import type { MemoryScope } from "./memory/types";
import type {
  WorkspaceMemoryPr,
  WorkspaceMemoryRow,
  WorkspaceMemoryStore,
} from "./memory/workspace-store";

export interface SteeringMemoryPrRecordsListDeps {
  workspace: Pick<WorkspaceMemoryStore, "findMemoryPr" | "memoriesByIds">;
  /** The steering host, made on the first open PR a call reads. */
  host(): Promise<SteeringHost>;
}

/** The Postgres store and the steering host, loaded on the first call. */
export const defaultSteeringMemoryPrRecordsListDeps: SteeringMemoryPrRecordsListDeps =
  {
    workspace: {
      async findMemoryPr(scope, by) {
        const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
        return postgresWorkspaceMemoryStore.findMemoryPr(scope, by);
      },
      async memoriesByIds(scope, ids) {
        const { postgresWorkspaceMemoryStore } = await import("./memory/workspace-store");
        return postgresWorkspaceMemoryStore.memoriesByIds(scope, ids);
      },
    },
    async host() {
      const { createSteeringHost } = await import("./context.steering.host");
      return createSteeringHost();
    },
  };

/** What the open PR's branch says about each record path. */
interface BranchRead {
  /** The label and description of each record file on the branch. */
  files: Map<string, { title: string; summary: string } | null>;
  /** The newest commit that touched each proposed record's path the branch no longer holds. */
  dropped: Map<string, string>;
}

/**
 * Read the open PR's branch, or null when the PR is on another repository
 * than the workspace's steering repo, the branch is gone, or the host
 * refused a read.
 */
async function readBranch(
  deps: SteeringMemoryPrRecordsListDeps,
  scope: MemoryScope,
  pr: WorkspaceMemoryPr,
): Promise<BranchRead | null> {
  try {
    const host = await deps.host();
    const repo = await host.resolveRepository(scope);
    if (repo.provider !== pr.provider || repo.fullName !== pr.repository)
      return null;
    const head = await host.branchHead(repo, pr.branch);
    if (head === null) return null;
    const present = new Set(await host.listFiles(repo, head, STEERING_DIR));
    const files: BranchRead["files"] = new Map();
    const dropped: BranchRead["dropped"] = new Map();
    for (const record of pr.records) {
      if (present.has(record.path)) {
        const text = await host.readFile(repo, record.path, head);
        const read = text === null ? null : readSteeringRecord(text);
        files.set(
          record.path,
          read?.ok === true
            ? {
                title: read.record.label,
                summary: read.record.description ?? read.record.label,
              }
            : null,
        );
      } else if (record.action === "propose") {
        const last = await host.lastCommitForPath(repo, record.path, pr.branch);
        if (last !== null) dropped.set(record.path, last.sha);
      }
    }
    return { files, dropped };
  } catch (err) {
    logger.warn(
      { ...scope, number: pr.number, branch: pr.branch, err },
      "memory: an open memory PR's branch could not be read; its records come from the memory PR row",
    );
    return null;
  }
}

/** A title and summary from the record's first memory, or its lineage when it cites none. */
function fromMemory(
  lineage: string,
  first: WorkspaceMemoryRow | undefined,
): { title: string; summary: string } {
  if (first === undefined) return { title: lineage, summary: lineage };
  return {
    title: first.label ?? memoryLabel(first.statement),
    summary: first.summary ?? memoryDescription(first.statement),
  };
}

export function createSteeringMemoryPrRecordsListHandler(
  deps: SteeringMemoryPrRecordsListDeps,
): CapabilityHandler<typeof steeringMemoryPrRecordsList> {
  return async (input, ctx): Promise<SteeringMemoryPrRecordsListOutput> => {
    await assertContractRole(steeringMemoryPrRecordsList, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const pr = await deps.workspace.findMemoryPr(scope, { number: input.number });
    if (pr === null)
      throw new HandlerError({
        code: "not_found",
        reason: "memory_pr_not_found",
        message: `This workspace has no memory PR #${input.number}.`,
      });
    const rows = await deps.workspace.memoriesByIds(
      scope,
      pr.records.flatMap((record) => record.memoryIds),
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    const branch = pr.status === "open" ? await readBranch(deps, scope, pr) : null;
    return {
      pull_request: {
        id: pr.publicId,
        number: pr.number,
        url: pr.url,
        repository: pr.repository,
        branch: pr.branch,
        status: pr.status,
        opened_at: pr.openedAt.toISOString(),
        settled_at: pr.settledAt?.toISOString() ?? null,
      },
      branch_read: branch !== null,
      records: pr.records.map((record) => {
        const memories = record.memoryIds.flatMap((id) => {
          const row = byId.get(id);
          return row === undefined ? [] : [row];
        });
        const named =
          branch?.files.get(record.path) ?? fromMemory(record.lineage, memories[0]);
        const dropped = branch?.dropped.get(record.path);
        return {
          action: record.action,
          path: record.path,
          lineage: record.lineage,
          kind: record.kind,
          title: named.title,
          summary: named.summary,
          memories: memories.map((row) => ({
            id: row.publicId,
            statement: row.statement,
            agent: row.agentLineage,
            run: row.runPublicId,
            evidence: row.evidence,
            state: row.state,
          })),
          dropped: dropped === undefined ? null : { commit_sha: dropped },
        };
      }),
    };
  };
}

export const steeringMemoryPrRecordsListHandler =
  createSteeringMemoryPrRecordsListHandler(defaultSteeringMemoryPrRecordsListDeps);
