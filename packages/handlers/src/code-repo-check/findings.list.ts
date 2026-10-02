// code-repo-check/findings.list.ts: list_code_repository_findings (S7, #4518;
// ADR-254).
//
// The check stored each statement it flagged on a linked repository's pull
// requests (store.ts). This read compares those statements with the
// workspace's active steering records again, with the check's own test
// (findings.ts), so the answer follows today's records: a statement whose
// record was revised to agree with it, or retired, drops out, and one that a
// newer record repeats is listed against that record. It reads no host and
// runs no model.
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  CodeRepositoryFinding,
  CodeRepositoryFindingsListOutput,
  codeRepositoryFindingsList,
} from "@oxagen/oxagen/contracts/repository.findings.list";
import { compareStatements, type PublishedStatement } from "./findings";
import { fileLineUrl } from "./run";
import type { AddedStatement } from "./statements";
import type { CodeRepoFindingStore, FindingScope, LinkedFinding } from "./store";

export interface FindingsReadDeps {
  store: Pick<CodeRepoFindingStore, "listLinked">;
  /** The workspace's active steering records. */
  publishedRecords(scope: FindingScope): Promise<PublishedStatement[]>;
  /** The handler-side role check (lib/capability-role-guard.ts). */
  assertRole(ctx: Parameters<CapabilityHandler<typeof codeRepositoryFindingsList>>[1]): Promise<void>;
}

/** A stored statement compared with today's records. */
export interface ComparedFinding {
  row: LinkedFinding;
  kind: CodeRepositoryFinding["kind"];
  record: CodeRepositoryFinding["record"];
}

/**
 * Compare stored statements with the records. Each distinct text is
 * compared once, so a line that several pull requests added costs one
 * comparison. A statement that matches no record is left out.
 */
export function compareStored(
  rows: readonly LinkedFinding[],
  records: readonly PublishedStatement[],
): ComparedFinding[] {
  if (rows.length === 0 || records.length === 0) return [];
  const byText = new Map<string, AddedStatement>();
  for (const row of rows)
    if (!byText.has(row.statement))
      byText.set(row.statement, { path: row.path, line: row.line, text: row.statement });
  const { findings } = compareStatements([...byText.values()], records);
  const matched = new Map(findings.map((finding) => [finding.statement.text, finding]));
  return rows.flatMap((row) => {
    const finding = matched.get(row.statement);
    return finding === undefined ? [] : [{ row, kind: finding.kind, record: finding.record }];
  });
}

/** One compared finding as the contract answers it. */
export function findingView({ row, kind, record }: ComparedFinding): CodeRepositoryFinding {
  return {
    id: row.publicId,
    path: row.path,
    line: row.line,
    statement: row.statement,
    kind,
    record,
    pull_request: {
      number: row.pullRequestNumber,
      url: row.pullRequestUrl,
      state: row.pullRequestState,
      head_sha: row.headSha,
    },
    file_url: fileLineUrl(
      { provider: row.provider, fullName: row.repository, headSha: row.headSha },
      row,
    ),
    checked_at: row.checkedAt.toISOString(),
    proposal:
      row.proposalPublicId === null
        ? null
        : {
            id: row.proposalPublicId,
            // A proposal deleted since reads as dismissed, so the finding can
            // be promoted again.
            status: (row.proposalStatus ?? "rejected") as NonNullable<
              CodeRepositoryFinding["proposal"]
            >["status"],
          },
  };
}

export function createListCodeRepositoryFindingsHandler(
  deps: FindingsReadDeps,
): CapabilityHandler<typeof codeRepositoryFindingsList> {
  return async (_input, ctx) => {
    await deps.assertRole(ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const rows = await deps.store.listLinked(scope);
    if (rows.length === 0) return { repositories: [] };
    const compared = compareStored(rows, await deps.publishedRecords(scope));
    const repositories: CodeRepositoryFindingsListOutput["repositories"] = [];
    const byRepository = new Map<string, (typeof repositories)[number]>();
    for (const finding of compared) {
      const { row } = finding;
      let repository = byRepository.get(row.repositoryId);
      if (repository === undefined) {
        repository = {
          repository_id: row.repositoryId,
          provider: row.provider,
          full_name: row.repository,
          findings: [],
        };
        byRepository.set(row.repositoryId, repository);
        repositories.push(repository);
      }
      repository.findings.push(findingView(finding));
    }
    return { repositories };
  };
}
