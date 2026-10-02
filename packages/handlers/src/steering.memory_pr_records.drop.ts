// audit-exempt: the commit lands on an open memory PR's branch and publishes nothing; the PR's settlement records the rejection when it merges, and the kernel's capability.invoke_* audit records the call.
//
// steering.memory_pr_records.drop.ts: drop_memory_record, take one proposed
// steering record out of an open memory PR (#4518; ADR-206 decision 7, as
// ADR-248 amends it).
//
// The drop is one commit on the memory PR's branch that deletes the record's
// file. It writes nothing else. When the PR merges, the curator settles it
// (memory/settle.ts): a proposed record whose file is not at the merge commit
// did not merge, so its statements are rejected and its memories wait again.
// A PR closed unmerged rejects every record. So the memory PR row keeps the
// dropped record: settlement reads its statement hashes from there.
//
// Flow:
//   1. Check the contract's roles.
//   2. Find the memory PR by its number. Refuse a number that names no
//      memory PR, one the row says settled, a path the PR does not hold, and
//      a record the PR archives rather than proposes.
//   3. Read the PR on the steering host. Refuse a PR on another repository
//      than the workspace's steering repo, and one the host merged or closed
//      before the curator settled it.
//   4. Read the branch. A file already gone is answered with the commit that
//      removed it, so a second click and a drop by someone else end the same
//      way. The PR's last record is refused: closing the PR rejects it.
//   5. Commit the delete on the head that was read. The host refuses
//      `head_moved` when someone pushed in between.
//   6. Move the memory PR's proposal row to that commit (ADR-265), as
//      promote_memories does after its commit, so merge_steering_pr lands
//      the head the drop made. A row write that fails is logged: the commit
//      stands, and the repository sync moves the row to the new head.
import { HandlerError, type CapabilityHandler } from "@oxagen/oxagen";
import {
  steeringMemoryPrRecordDrop,
  type SteeringMemoryPrRecordDropOutput,
} from "@oxagen/oxagen/contracts/steering.memory_pr_records.drop";
import { STEERING_DIR } from "@oxagen/oxagen/steering-repo/paths";
import type { SteeringHost } from "./context.steering.github";
import { assertContractRole } from "./lib/capability-role-guard";
import type { WorkspaceMemoryStore } from "./memory/workspace-store";
import {
  actingAuthor,
  recordSteeringPrQuietly,
  type SteeringPrAuthor,
  type SteeringPrProposalStore,
} from "./steering-repo/pr-proposal";

export interface SteeringMemoryPrRecordDropDeps {
  workspace: Pick<WorkspaceMemoryStore, "findMemoryPr">;
  /** The steering host, made on the first call that reaches it. */
  host(): Promise<SteeringHost>;
  /** The proposal rows merge_steering_pr lands a steering PR from (ADR-265). */
  proposals(): Promise<SteeringPrProposalStore>;
  /** The person the row records as the commit's author. */
  author(
    ctx: Parameters<CapabilityHandler<typeof steeringMemoryPrRecordDrop>>[1],
  ): Promise<SteeringPrAuthor>;
  /** The handler-side role check (lib/capability-role-guard.ts). */
  assertRole(
    ctx: Parameters<CapabilityHandler<typeof steeringMemoryPrRecordDrop>>[1],
  ): Promise<void>;
}

/** The Postgres store and the steering host, loaded on the first call. */
export const defaultSteeringMemoryPrRecordDropDeps: SteeringMemoryPrRecordDropDeps =
  {
    workspace: {
      async findMemoryPr(scope, by) {
        const { postgresWorkspaceMemoryStore } = await import(
          "./memory/workspace-store"
        );
        return postgresWorkspaceMemoryStore.findMemoryPr(scope, by);
      },
    },
    async host() {
      const { createSteeringHost } = await import("./context.steering.host");
      return createSteeringHost();
    },
    async proposals() {
      const { postgresSteeringStore } = await import("./context.steering.store");
      return postgresSteeringStore;
    },
    author: (ctx) => actingAuthor(ctx),
    // The guard answers the role it found. The handler needs only the refusal.
    assertRole: async (ctx) => {
      await assertContractRole(steeringMemoryPrRecordDrop, ctx);
    },
  };

function refuse(reason: string, message: string): HandlerError {
  return new HandlerError({ code: "conflict", reason, message });
}

function hostName(provider: string): string {
  return provider === "gitlab" ? "GitLab" : "GitHub";
}

export function createSteeringMemoryPrRecordDropHandler(
  deps: SteeringMemoryPrRecordDropDeps,
): CapabilityHandler<typeof steeringMemoryPrRecordDrop> {
  return async (input, ctx): Promise<SteeringMemoryPrRecordDropOutput> => {
    await deps.assertRole(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const pr = await deps.workspace.findMemoryPr(scope, {
      number: input.number,
    });
    if (pr === null) {
      throw new HandlerError({
        code: "not_found",
        reason: "memory_pr_not_found",
        message: `This workspace has no memory PR #${input.number}.`,
      });
    }
    if (pr.status !== "open") {
      throw refuse(
        "memory_pr_settled",
        `Memory PR #${pr.number} is ${pr.status}, so its records can no longer change.`,
      );
    }
    const record = pr.records.find((entry) => entry.path === input.path);
    if (record === undefined) {
      throw new HandlerError({
        code: "not_found",
        reason: "record_not_in_pr",
        message: `Memory PR #${pr.number} holds no record at ${input.path}. Read its records with list_memory_pr_records.`,
      });
    }
    if (record.action !== "propose") {
      throw refuse(
        "record_not_proposed",
        `Memory PR #${pr.number} archives ${input.path}. Only a record the PR proposes can be dropped.`,
      );
    }

    const host = await deps.host();
    const repo = await host.resolveRepository(scope);
    if (repo.provider !== pr.provider || repo.fullName !== pr.repository) {
      throw refuse(
        "memory_pr_elsewhere",
        `Memory PR #${pr.number} is on ${pr.repository}, and this workspace's steering repository is now ${repo.fullName}. Oxagen no longer writes to it.`,
      );
    }
    const state = await host.getPullRequest(repo, pr.number);
    if (!state.open) {
      throw refuse(
        "memory_pr_settled",
        `Memory PR #${pr.number} is ${state.merged ? "merged" : "closed"} on ${hostName(repo.provider)}, so its records can no longer change.`,
      );
    }
    const head = await host.branchHead(repo, pr.branch);
    if (head === null) {
      throw refuse(
        "branch_missing",
        `${pr.branch} is gone from ${repo.fullName}, so there is no branch to drop ${input.path} from.`,
      );
    }
    const present = new Set(await host.listFiles(repo, head, STEERING_DIR));
    const pullRequest = { number: pr.number, url: pr.url, branch: pr.branch };

    if (!present.has(input.path)) {
      // Dropped already: answer the commit that removed it.
      const last = await host.lastCommitForPath(repo, input.path, pr.branch);
      if (last === null) {
        throw refuse(
          "record_file_missing",
          `${pr.branch} never held ${input.path}, so there is nothing to drop.`,
        );
      }
      return {
        pull_request: pullRequest,
        path: input.path,
        lineage: record.lineage,
        commit_sha: last.sha,
        already_dropped: true,
      };
    }

    // A memory PR with nothing left to merge is closed, not emptied: closing
    // it rejects every record it proposes.
    const remaining = pr.records.filter(
      (entry) =>
        entry.path !== input.path &&
        (entry.action !== "propose" || present.has(entry.path)),
    );
    if (remaining.length === 0) {
      throw refuse(
        "last_record",
        `${input.path} is the last record memory PR #${pr.number} changes. Close the PR on ${hostName(repo.provider)} instead: closing it rejects every record it proposes.`,
      );
    }

    const { sha } = await host.commitFiles(repo, {
      branch: pr.branch,
      parent: head,
      message: `Drop ${record.lineage} from memory PR #${pr.number}`,
      files: [{ path: input.path, content: null }],
    });
    // The row follows the PR to the commit the drop made (#5122).
    await recordSteeringPrQuietly(await deps.proposals(), {
      scope,
      repo,
      kind: "memory_pr",
      pullRequest: {
        number: pr.number,
        url: pr.url,
        branch: pr.branch,
        headSha: sha,
      },
      title: `Memory PR ${pr.branch.slice("memory/".length)}`,
      paths: pr.records.map((entry) => entry.path),
      check: null,
      author: await deps.author(ctx),
    });
    return {
      pull_request: pullRequest,
      path: input.path,
      lineage: record.lineage,
      commit_sha: sha,
      already_dropped: false,
    };
  };
}

export const steeringMemoryPrRecordDropHandler =
  createSteeringMemoryPrRecordDropHandler(defaultSteeringMemoryPrRecordDropDeps);
