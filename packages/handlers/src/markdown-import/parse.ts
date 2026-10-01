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
//   4. Every record row is compared with the published records and the other
//      rows (matches.ts). A duplicate defaults to skip. A conflict waits for
//      a person's choice. A policy whose statements match a published policy
//      file is a duplicate and defaults to skip.
//
// Nothing is written.
import type { CapabilityHandler } from "@oxagen/oxagen";
import type {
  MarkdownImportDocument,
  MarkdownImportFile,
  MarkdownImportPolicy,
  MarkdownImportRecord,
  MarkdownImportTarget,
} from "@oxagen/oxagen/contracts/steering.markdown_import.shared";
import { steeringMarkdownImportParse } from "@oxagen/oxagen/contracts/steering.markdown_import.parse";
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
import { splitDocument } from "./split";

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
};

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
          error: null,
        };
        if (target === "skip") return { file, records: [], policy: null };
        if (target === "policies") {
          return { file, records: [], policy: null };
        }
        const base = [org, ...fileParts(document.filename)];
        const read = readFrontmatterRecord(document.content);
        if (read.kind === "invalid") {
          return { file: { ...file, error: read.message }, records: [], policy: null };
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
            policy: null,
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
              records: [],
              policy: null,
            };
          }
          return {
            file,
            policy: null,
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
            records: [],
            policy: null,
          };
        }
      },
    );

    // Policies run in file order, so the ids each one takes are stable. A
    // file replaces the published policy file at its path, so that file's ids
    // are free to it.
    const written = new Map<string, string>();
    for (const [index, result] of results.entries()) {
      const document = input.documents[index] as MarkdownImportDocument;
      if (result.file.target !== "policies") continue;
      const slug = policySlug(document.filename);
      const path = policyFilePath(slug);
      const taken = new Map(
        [...takenIds].filter(([, holder]) => holder !== path),
      );
      const built = policyFile({ content: document.content, slug, taken });
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

    return {
      files: results.map((result) => result.file),
      records: rows,
      policies: results.flatMap((result) => (result.policy ? [result.policy] : [])),
    };
  };
}
