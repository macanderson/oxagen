// markdown-import/parse.ts: parse_markdown_import (memory-collection spec,
// Bulk import; discussions spec, Markdown import).
//
// Flow, for up to 25 files:
//   1. Each file's target: the one the caller chose, else the one its text
//      implies. A fenced `cedar` block or a top-level permit( or forbid( means
//      policies, a README or index file means skip, and anything else means
//      records.
//   2. records: a file with steering-record/v1 frontmatter stays one record.
//      Any other file goes to one model call (split.ts), at most four at
//      once. A file the model fails on is reported, and the others go on.
//   3. policies: the file's Cedar becomes policy/<file-slug>.cedar with an
//      @id on every statement, checked for shape (cedar.ts).
//   4. memories: the file is split as in step 2, and each statement becomes
//      a memory row with kind memory and force info (memories.ts).
//   5. Every record row is compared with the published records and the other
//      rows (matches.ts). A duplicate defaults to skip. A conflict waits for
//      a person's choice. A policy whose statements match a published policy
//      file is a duplicate and defaults to skip. A memory row whose statement
//      a waiting memory holds, a person rejected, or an earlier row holds is
//      skipped and names the match.
//   6. The record and policy rows marked add are counted against the 299
//      files one steering PR holds, and the result says when the import is
//      over. Memories go to no PR.
//
// Nothing is written.
import type { CapabilityContext, CapabilityHandler } from "@oxagen/oxagen";
import {
  markdownImportFileCount,
  markdownImportTooManyFiles,
  type MarkdownImportDocument,
  type MarkdownImportFile,
  type MarkdownImportMemory,
  type MarkdownImportPolicy,
  type MarkdownImportRecord,
  type MarkdownImportTarget,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
import { STEERING_PR_MAX_FILES } from "@oxagen/oxagen/steering-repo/names";
import { policyFilePath } from "@oxagen/oxagen/steering-repo/paths";
import { clampForce } from "@oxagen/oxagen/steering-repo/record-force";
import { countTokens } from "@oxagen/oxagen/steering-repo/tokens";
import { assertContractRole } from "../lib/capability-role-guard";
import {
  hasCedar,
  normalizedPolicy,
  policyFile,
  policyIds,
} from "./cedar";
import type { MarkdownImportDeps } from "./deps";
import { readFrontmatterRecord } from "./frontmatter";
import { markMatches, type MatchedRow } from "./matches";
import { markMemoryRows, memoryRow } from "./memories";
import {
  fileParts,
  isIndexFile,
  labelOf,
  lineageOf,
  policySlug,
  slugPart,
  uniqueLineage,
} from "./naming";
import { importRecordPath } from "./render";
import { splitDocument, type SplitModel } from "./split";

/** Model calls in flight at once, so 25 files do not open 25 gateway requests. */
const SPLIT_CONCURRENCY = 4;

/** The target a file's text implies, and why. */
export function detectTarget(document: Pick<MarkdownImportDocument, "filename" | "content">): {
  target: MarkdownImportTarget;
  reason: string;
} {
  if (hasCedar(document.content)) {
    return {
      target: "policies",
      reason: "The file holds a cedar block or a top-level permit or forbid statement.",
    };
  }
  if (isIndexFile(document.filename)) {
    return { target: "skip", reason: "A README or index file describes other files." };
  }
  // Headings and links carry no guidance of their own.
  const text = document.content
    .split("\n")
    .filter((line) => !/^\s{0,3}#/.test(line))
    .join("\n")
    .replace(/\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/[*_>\-\s|]+/g, "");
  if (text === "") {
    return { target: "skip", reason: "The file holds only headings and links to other files." };
  }
  return { target: "records", reason: "The file holds prose, so its statements become records." };
}

type FileResult = {
  file: MarkdownImportFile;
  records: MarkdownImportRecord[];
  policy: MarkdownImportPolicy | null;
  memories: MarkdownImportMemory[];
};

/**
 * A file read under the `memories` target: a file with steering-record/v1
 * frontmatter is one memory of its body, and any other file is split by the
 * model as a records file is. Each row is a memory with force info.
 */
async function readMemories(
  document: MarkdownImportDocument,
  ctx: CapabilityContext,
  model: SplitModel,
): Promise<{ rows: MarkdownImportMemory[]; error: string | null }> {
  const read = readFrontmatterRecord(document.content);
  if (read.kind === "invalid") return { rows: [], error: read.message };
  if (read.kind === "record") {
    return {
      rows: [
        memoryRow({
          file: document.filename,
          line: read.bodyLine,
          label: read.record.label,
          statement: read.statement,
        }),
      ],
      error: null,
    };
  }
  try {
    const statements = await splitDocument({
      filename: document.filename,
      content: document.content,
      ctx,
      model,
    });
    if (statements.length === 0) {
      return { rows: [], error: "The model found no durable guidance in the file." };
    }
    return {
      rows: statements.map((s) =>
        memoryRow({ file: document.filename, line: s.line, label: s.label, statement: s.statement }),
      ),
      error: null,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { rows: [], error: `The model could not split the file: ${reason}` };
  }
}

/** `fn` over `items` with at most `limit` calls in flight, answers in input order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      out[index] = await fn(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** The tokens a statement adds to a request it reaches. */
function tokensOf(statement: string): number {
  return countTokens(statement);
}

export function createParseMarkdownImportHandler(
  deps: MarkdownImportDeps,
): CapabilityHandler<typeof steeringMarkdownImportParse> {
  return async (input, ctx) => {
    await assertContractRole(steeringMarkdownImportParse, ctx);
    const scope = { orgId: ctx.orgId, workspaceId: ctx.workspaceId };
    const [names, published, policies] = await Promise.all([
      deps.names(scope),
      deps.publishedRecords(scope),
      deps.publishedPolicies(scope),
    ]);
    const publishedPath = new Map(published.map((r) => [r.lineage, r.path]));
    const takenIds = new Map<string, string>();
    for (const policy of policies) {
      for (const id of policyIds(policy.text)) takenIds.set(id, policy.path);
    }
    const policyText = new Map(policies.map((p) => [p.path, p.text]));
    const org = slugPart(names.organization) || "workspace";

    const results = await mapLimit(
      input.documents,
      SPLIT_CONCURRENCY,
      async (document): Promise<FileResult> => {
        const detected = detectTarget(document);
        const target = document.target ?? detected.target;
        const file: MarkdownImportFile = {
          filename: document.filename,
          target,
          detected: detected.target,
          reason: detected.reason,
          records: 0,
          policies: 0,
          memories: 0,
          error: null,
        };
        // Each result gets its own arrays, so no two files share one.
        const none = (): Omit<FileResult, "file"> => ({ records: [], policy: null, memories: [] });
        if (target === "skip" || target === "policies") return { file, ...none() };
        if (target === "memories") {
          const read = await readMemories(document, ctx, deps.split);
          return {
            file: { ...file, memories: read.rows.length, error: read.error },
            ...none(),
            memories: read.rows,
          };
        }
        const base = [org, ...fileParts(document.filename)];
        const read = readFrontmatterRecord(document.content);
        if (read.kind === "invalid") {
          return { file: { ...file, error: read.message }, ...none() };
        }
        if (read.kind === "record") {
          const record = read.record;
          // The import's rule holds for a file's own frontmatter too: a force
          // the kind cannot carry takes the kind's default, and only a
          // constraint keeps an effect.
          const force = clampForce(record.kind, record.force);
          const kindReason =
            force === record.force
              ? "The file's steering-record/v1 frontmatter names the kind."
              : `The file's steering-record/v1 frontmatter names the kind. A ${record.kind} cannot carry ${record.force}, so its force is ${force}.`;
          return {
            file,
            ...none(),
            records: [
              {
                file: document.filename,
                line: read.bodyLine,
                origin: "frontmatter",
                lineage: record.lineage,
                label: record.label,
                statement: read.statement,
                kind: record.kind,
                kindReason,
                force,
                forceWords: "",
                effect: record.kind === "constraint" ? (record.effect ?? null) : null,
                tokens: tokensOf(read.statement),
                duplicate: null,
                conflict: null,
                action: "add",
                frontmatter: read.frontmatter,
              },
            ],
          };
        }
        try {
          const statements = await splitDocument({
            filename: document.filename,
            content: document.content,
            ctx,
            model: deps.split,
          });
          if (statements.length === 0) {
            return {
              file: { ...file, error: "The model found no durable guidance in the file." },
              ...none(),
            };
          }
          return {
            file,
            ...none(),
            records: statements.map((s) => ({
              file: document.filename,
              line: s.line,
              origin: "split" as const,
              // Lineages are made unique below, in file order.
              lineage: lineageOf([...base, slugPart(s.label)]),
              label: labelOf(s.label, s.statement),
              statement: s.statement,
              kind: s.kind,
              kindReason: s.kindReason,
              force: s.force,
              forceWords: s.forceWords,
              effect: s.effect,
              tokens: tokensOf(s.statement),
              duplicate: null,
              conflict: null,
              action: "add" as const,
              frontmatter: null,
            })),
          };
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          return {
            file: { ...file, error: `The model could not split the file: ${reason}` },
            ...none(),
          };
        }
      },
    );

    // An import file replaces the published policy file at its path, so every
    // id the published file holds is free once the import rebuilds it. They
    // are released before any file is built, so a file earlier in the import
    // can take an id a later file's rebuild drops.
    const rebuilt = new Set(
      results.flatMap((result, index) =>
        result.file.target === "policies"
          ? [policyFilePath(policySlug((input.documents[index] as MarkdownImportDocument).filename))]
          : [],
      ),
    );
    for (const [id, holder] of [...takenIds]) {
      if (rebuilt.has(holder)) takenIds.delete(id);
    }

    // Policies run in file order, so the ids each one takes are stable.
    const written = new Map<string, string>();
    for (const [index, result] of results.entries()) {
      const document = input.documents[index] as MarkdownImportDocument;
      if (result.file.target !== "policies") continue;
      const slug = policySlug(document.filename);
      const built = policyFile({ content: document.content, slug, taken: takenIds });
      for (const statement of built.statements) takenIds.set(statement.id, built.path);
      const issues = [...built.issues];
      const other = written.get(built.path);
      if (other !== undefined) {
        issues.push({
          statement: null,
          id: null,
          line: null,
          message: `${other} in this import also becomes ${built.path}. Rename one of the two files.`,
        });
      }
      written.set(built.path, document.filename);
      const held = policyText.get(built.path) ?? null;
      const same = policies.find(
        (p) => normalizedPolicy(p.text) === normalizedPolicy(built.text),
      );
      result.policy = {
        file: document.filename,
        path: built.path,
        text: built.text,
        statements: built.statements,
        issues,
        duplicate: same ? { path: same.path } : null,
        replaces: held !== null && same?.path !== built.path,
        action: issues.length > 0 || same ? "skip" : "add",
      };
      result.file.policies = 1;
    }

    // Lineages: a frontmatter record keeps its own, and every split statement
    // takes the first free one from its file and label, in file order.
    const lineages = new Set<string>();
    for (const result of results) {
      for (const row of result.records) {
        if (row.origin === "frontmatter") lineages.add(row.lineage);
      }
    }
    const records: MarkdownImportRecord[] = [];
    for (const result of results) {
      for (const row of result.records) {
        const lineage =
          row.origin === "frontmatter" ? row.lineage : uniqueLineage(row.lineage, lineages);
        records.push({ ...row, lineage });
      }
      result.file.records = result.records.length;
    }

    const matched: MatchedRow[] = records.map((row) => ({
      lineage: row.lineage,
      kind: row.kind,
      effect: row.effect,
      statement: row.statement,
      path: importRecordPath(row.kind, row.lineage, publishedPath.get(row.lineage) ?? null),
      duplicate: null,
      conflict: null,
    }));
    markMatches(matched, published);
    const rows = records.map((row, index) => {
      const match = matched[index] as MatchedRow;
      return {
        ...row,
        duplicate: match.duplicate,
        conflict: match.conflict,
        action: match.conflict ? null : match.duplicate ? ("skip" as const) : ("add" as const),
      };
    });

    // Memory rows: each one checked against the waiting memories, the
    // rejected statements, and the rows before it. The store is read only
    // when a file was imported as memories.
    const memoryRows = results.flatMap((result) => result.memories);
    const memories =
      memoryRows.length === 0
        ? []
        : markMemoryRows(memoryRows, await deps.memories.held(scope));

    const policyRows = results.flatMap((result) => (result.policy ? [result.policy] : []));
    const count = markdownImportFileCount({ records: rows, policies: policyRows });
    return {
      files: results.map((result) => result.file),
      records: rows,
      policies: policyRows,
      memories,
      pullRequestFiles: {
        count,
        max: STEERING_PR_MAX_FILES,
        message: markdownImportTooManyFiles(count),
      },
    };
  };
}
