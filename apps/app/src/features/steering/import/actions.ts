"use server";
// The Markdown import's two calls (memory-collection spec, Bulk import), each
// through the kernel seam for the workspace viewer the URL names.
//
// parse_markdown_import writes nothing but makes one model call per file it
// splits, billed as in-app agent spend. It goes through `kernelWrite` rather
// than `kernelRead` for that reason: only a write's ActionResult carries
// `exhausted`, so an organization out of credit is told so, and a read's
// failure would fall to a generic error (ARCHITECTURE.md §3.2). The handler
// gates the role with the contract's own defaultRoles (an org Owner or Admin,
// or a workspace Owner or Member).
//
// commit_markdown_import opens one steering PR on steering/import-<date>. It
// refuses a conflict nobody chose for, a policy the early checks failed, and
// two rows with one lineage or one path, each with its reason as the code.
import { steeringMarkdownImportCommit } from "@oxagen/oxagen/contracts/steering.markdown_import.commit";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import type { ActionResult, ContractOutput } from "@/server/kernel";
import { kernelWrite } from "@/server/kernel";
import { requireViewer } from "@/server/viewer";

type ParseInput = (typeof steeringMarkdownImportParse)["input"]["_input"];
type CommitInput = (typeof steeringMarkdownImportCommit)["input"]["_input"];

/** What the dialog shows once the steering PR opened. */
export type ImportCommitted = {
  number: number;
  url: string;
  branch: string;
  records: number;
  policies: number;
  skipped: number;
};

/** Split, classify, and check up to 25 files. Nothing is written. */
export async function parseMarkdownImport(
  org: string,
  ws: string,
  documents: ParseInput["documents"],
): Promise<ActionResult<ContractOutput<typeof steeringMarkdownImportParse>>> {
  const ctx = await requireViewer(org, ws);
  return kernelWrite(ctx, steeringMarkdownImportParse, { documents });
}

/** Open the one steering PR that holds every row marked add. */
export async function commitMarkdownImport(
  org: string,
  ws: string,
  rows: CommitInput,
): Promise<ActionResult<ImportCommitted>> {
  const ctx = await requireViewer(org, ws);
  const result = await kernelWrite(ctx, steeringMarkdownImportCommit, rows);
  if (!result.ok) return result;
  const { pullRequest, records, policies, skipped } = result.value;
  return {
    ok: true,
    value: {
      number: pullRequest.number,
      url: pullRequest.url,
      branch: pullRequest.branch,
      records,
      policies,
      skipped,
    },
  };
}
