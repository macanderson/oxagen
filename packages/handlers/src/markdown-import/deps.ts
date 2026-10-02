// markdown-import/deps.ts: what the Markdown import reads and writes outside
// itself, as one seam, so the tests run both handlers against fakes.
//
// - names: the organization's slug, which every lineage the import mints
//   starts with.
// - publishedRecords: the registry's active records, which the duplicate and
//   conflict test compares against and whose paths a revision is written to.
// - publishedPolicies: the policy files on the steering repo's production
//   branch, whose @ids an imported statement may not take again.
// - split: the model call (split.ts).
// - branchTaken and opener: the steering repo's branches, and the steering PR
//   opener the tools PRs use (tools.pr.open.ts), with the Markdown import's
//   branch rule.
// - memories: the memory store (memory/store.ts). The waiting memories and
//   the rejected statements a memory row is checked against, and the insert
//   that stores the rows marked add.
import { HandlerError, isHandlerError } from "@oxagen/oxagen";
import { POLICY_DIR } from "@oxagen/oxagen/steering-repo/paths";
import type { MemoryDraft } from "../memory/types";
import type { PublishedPolicy } from "./cedar";
import type { PublishedRecord } from "./matches";
import type { HeldMemories } from "./memories";
import { splitWithModel, type SplitModel } from "./split";
import type {
  ToolsPullRequestOpener,
  ToolsPullRequestScope,
} from "../tools.pr.open";

export type ImportScope = ToolsPullRequestScope;

export interface MarkdownImportDeps {
  names(scope: ImportScope): Promise<{ organization: string; workspace: string }>;
  publishedRecords(scope: ImportScope): Promise<PublishedRecord[]>;
  publishedPolicies(scope: ImportScope): Promise<PublishedPolicy[]>;
  split: SplitModel;
  /** True when the steering repo already has `branch`. */
  branchTaken(scope: ImportScope, branch: string): Promise<boolean>;
  opener: ToolsPullRequestOpener;
  memories: {
    /** The workspace's waiting memories and rejected statements. */
    held(scope: ImportScope): Promise<HeldMemories>;
    /** Store the drafts, skipping any whose dedupe key exists. Returns the dedupe key of each one written. */
    store(scope: ImportScope, drafts: MemoryDraft[]): Promise<string[]>;
  };
  now(): Date;
}

/** True for the refusal a workspace with no steering repo answers. */
function noRepository(err: unknown): boolean {
  return isHandlerError(err) && err.reason === "workspace_repository_missing";
}

/** The production deps: Postgres, the workspace's steering host, and the gateway. */
export function markdownImportDeps(): MarkdownImportDeps {
  return {
    async names(scope) {
      const [{ schema, withTenantDb }, { and, eq }] = await Promise.all([
        import("@oxagen/database"),
        import("drizzle-orm"),
      ]);
      const [row] = await withTenantDb((tx) =>
        tx
          .select({
            organization: schema.organizations.slug,
            workspace: schema.workspaces.slug,
          })
          .from(schema.workspaces)
          .innerJoin(
            schema.organizations,
            eq(schema.organizations.id, schema.workspaces.orgId),
          )
          .where(
            and(
              eq(schema.workspaces.id, scope.workspaceId),
              eq(schema.workspaces.orgId, scope.orgId),
            ),
          )
          .limit(1),
      );
      if (!row) {
        throw new HandlerError({
          code: "not_found",
          reason: "workspace_not_found",
          message: `Workspace ${scope.workspaceId} is not in this organization.`,
        });
      }
      return row;
    },
    async publishedRecords(scope) {
      const { postgresSteeringStore } = await import("../context.steering.store");
      const rows = await postgresSteeringStore.listActiveRecords(scope);
      return rows.flatMap((row) =>
        row.statement
          ? [
              {
                lineage: row.slug,
                kind: row.kind ?? "",
                effect: row.constraintEffect ?? null,
                statement: row.statement,
                path: row.path ?? null,
              },
            ]
          : [],
      );
    },
    async publishedPolicies(scope) {
      const { toolsSteeringHost } = await import("../tools.pr.open");
      const host = toolsSteeringHost();
      // A workspace with no steering repo has no published policy.
      const repo = await host.resolveRepository(scope).catch((err: unknown) => {
        if (noRepository(err)) return null;
        throw err;
      });
      if (repo === null) return [];
      const paths = (await host.listFiles(repo, repo.defaultBranch, POLICY_DIR))
        .filter((path) => path.endsWith(".cedar"))
        .sort();
      const texts = await Promise.all(
        paths.map((path) => host.readFile(repo, path, repo.defaultBranch)),
      );
      return paths.flatMap((path, index) => {
        const text = texts[index];
        return text == null ? [] : [{ path, text }];
      });
    },
    split: splitWithModel,
    async branchTaken(scope, branch) {
      const { toolsSteeringHost } = await import("../tools.pr.open");
      const host = toolsSteeringHost();
      const repo = await host.resolveRepository(scope);
      return (await host.branchHead(repo, branch)) !== null;
    },
    opener: {
      async open(scope, args) {
        const { markdownImportPullRequestOpener } = await import("./opener");
        return markdownImportPullRequestOpener.open(scope, args);
      },
    },
    memories: {
      async held(scope) {
        const { postgresMemoryStore } = await import("../memory/store");
        const [waiting, rejected] = await Promise.all([
          postgresMemoryStore.listWaiting(scope),
          postgresMemoryStore.listRejections(scope),
        ]);
        return {
          waiting: waiting.map((memory) => ({
            publicId: memory.publicId,
            statementHash: memory.statementHash,
          })),
          rejected: rejected.map((rejection) => rejection.statementHash),
        };
      },
      async store(scope, drafts) {
        const { postgresMemoryStore } = await import("../memory/store");
        return postgresMemoryStore.insertMemoriesKeyed(scope, drafts);
      },
    },
    now: () => new Date(),
  };
}
