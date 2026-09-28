// steering-repo/stamp.ts: what the stamp commit at the head of the merge
// queue writes (steering-repo-spec, Steering PR flow: Stamp and Merge).
//
// Oxagen pushes one commit to the branch at the head of the queue. It writes
// `id` and `hash` into every steering record the PR changes and adds one line
// to the ledger in steering/promotions/. Only the head of the queue is
// stamped, so no two branches append to the ledger at once. Everything here is
// pure: the queue reads the files and pushes the commit.
//
// The ledger starts a new file each period (`[ledger] rotate`) or when the
// current file reaches `[ledger] max_lines`, whichever comes first:
// 2026-09.jsonl, then 2026-09.002.jsonl. The first line of a new file carries
// the last hash of the file before, so the chain crosses files.
import type {
  GovernanceMode,
  RepositoryProvider,
} from "@oxagen/oxagen/contracts/context.steering.shared";
import { recordIdSchema } from "@oxagen/oxagen/steering-repo/common";
import { readJsonLines } from "@oxagen/oxagen/steering-repo/files";
import {
  BRANCH_PREFIXES,
  branchPrefixOf,
  type BranchPrefix,
} from "@oxagen/oxagen/steering-repo/names";
import {
  classifySteeringRepoPath,
  ledgerFilePath,
  ledgerPeriod,
  LEDGER_FILES_PER_PERIOD_MAX,
  MEMORY_DIR,
  parseLedgerFileName,
  POLICY_DIR,
  PROMOTIONS_DIR,
  SKILLS_DIR,
  STEERING_DIR,
  AGENTS_DIR,
  TOOLS_DIR,
  type LedgerRotation,
} from "@oxagen/oxagen/steering-repo/paths";
import {
  ledgerChainBreaks,
  promotionSchema,
  serializePromotionLine,
  type PromotionChange,
  type PromotionLine,
} from "@oxagen/oxagen/steering-repo/promotion";
import {
  parseFrontmatter,
  splitRecordFile,
  stampRecord,
} from "@oxagen/oxagen/steering-repo/record";

// ── Records ──────────────────────────────────────────────────────────────────

export type StampedRecordText =
  | { ok: true; text: string; id: string; hash: string; lineage: string }
  | { ok: false; message: string };

/**
 * A steering record with its `id` and `hash` written as the last two
 * frontmatter keys. Any `id` or `hash` the file already carried is removed
 * first, so stamping a stamped record gives back the same text.
 */
export function stampRecordText(text: string): StampedRecordText {
  const split = splitRecordFile(text);
  if (!split.ok) return { ok: false, message: split.issue.message };
  const { frontmatter, body } = split.parts;
  // Line 1 is the first frontmatter line, so a key's line indexes `lines`.
  const parsed = parseFrontmatter(frontmatter, 1);
  if (!parsed.ok) {
    return {
      ok: false,
      message: parsed.issues.map((issue) => issue.message).join("; "),
    };
  }
  const { value, key_lines } = parsed.frontmatter;
  if (typeof value.lineage !== "string" || value.lineage === "") {
    return { ok: false, message: "the record names no lineage" };
  }
  const { id, hash } = stampRecord(value, body);
  const lines = frontmatter.split("\n");
  const starts = [...key_lines.values()].sort((a, b) => a - b);
  const drop = new Set<number>();
  for (const key of ["id", "hash"]) {
    const start = key_lines.get(key);
    if (start === undefined) continue;
    drop.add(start);
    // A value that runs onto indented lines ends at the next key.
    const next = starts.find((line) => line > start) ?? lines.length + 1;
    for (let line = start + 1; line < next; line += 1) {
      if (/^[ \t]/.test(lines[line - 1] ?? "")) drop.add(line);
      else break;
    }
  }
  const kept = lines.filter((_, index) => !drop.has(index + 1));
  while (kept.length > 0 && (kept[kept.length - 1] ?? "").trim() === "") {
    kept.pop();
  }
  kept.push(`id: ${id}`, `hash: ${hash}`);
  return {
    ok: true,
    text: `---\n${kept.join("\n")}\n---\n${body}`,
    id,
    hash,
    lineage: value.lineage,
  };
}

/** True for a path that holds a steering record the stamp writes into. */
export function isStampedRecordPath(path: string): boolean {
  const kind = classifySteeringRepoPath(path);
  return kind === "record" || kind === "skill-record";
}

// ── The ledger ───────────────────────────────────────────────────────────────

const DAY_MS = 86_400_000;

/** The instant a ledger period starts and the instant the next one starts, in UTC. */
export function ledgerPeriodBounds(
  period: string,
): { start: number; end: number } | null {
  let match = /^(\d{4})-W(\d{2})$/.exec(period);
  if (match) {
    const year = Number(match[1]);
    const week = Number(match[2]);
    // ISO 8601: week 1 is the week that holds 4 January, and weeks start on Monday.
    const jan4 = Date.UTC(year, 0, 4);
    const weekday = new Date(jan4).getUTCDay() || 7;
    const start = jan4 - (weekday - 1) * DAY_MS + (week - 1) * 7 * DAY_MS;
    return { start, end: start + 7 * DAY_MS };
  }
  match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  if (match[2] === undefined) {
    return { start: Date.UTC(year, 0, 1), end: Date.UTC(year + 1, 0, 1) };
  }
  const month = Number(match[2]) - 1;
  if (match[3] === undefined) {
    return {
      start: Date.UTC(year, month, 1),
      end: Date.UTC(year, month + 1, 1),
    };
  }
  const start = Date.UTC(year, month, Number(match[3]));
  return { start, end: start + DAY_MS };
}

interface LedgerFile {
  path: string;
  period: string;
  n: number;
}

export interface LedgerTargetInput {
  /** Every path under steering/promotions/ on the branch the line lands on. */
  paths: readonly string[];
  read: (path: string) => Promise<string | null>;
  at: Date;
  rotate: LedgerRotation;
  maxLines: number;
}

/**
 * Where the next ledger line goes. `existing` is the text of the file the
 * line is appended to, empty when the line opens a new file. `prev` and `seq`
 * continue the chain from the last line in the ledger, whatever file holds it.
 */
export type LedgerTarget =
  | {
      ok: true;
      path: string;
      existing: string;
      prev: string | null;
      seq: number;
    }
  | { ok: false; message: string };

interface LedgerTail {
  file: LedgerFile;
  text: string;
  lines: PromotionLine[];
  last: PromotionLine;
}

/** A ledger file read and checked: its lines, and a chain unbroken inside it. */
function readLedgerFile(
  file: LedgerFile,
  text: string | null,
): { ok: true; tail: LedgerTail } | { ok: false; message: string } {
  if (text === null) {
    return { ok: false, message: `${file.path} is listed but cannot be read` };
  }
  const read = readJsonLines(text, promotionSchema);
  if (!read.ok) {
    const first = read.issues[0];
    return {
      ok: false,
      message: `${file.path}${first?.line ? ` line ${first.line}` : ""}: ${first?.message ?? "is not a ledger file"}`,
    };
  }
  const lines = read.value as PromotionLine[];
  const first = lines[0];
  const last = lines[lines.length - 1];
  if (!first || !last) {
    return { ok: false, message: `${file.path} holds no ledger line` };
  }
  const breaks = ledgerChainBreaks(lines, first.prev, first.seq);
  if (breaks.length > 0) {
    return {
      ok: false,
      message: `${file.path} breaks the ledger chain at line ${(breaks[0] ?? 0) + 1}`,
    };
  }
  return { ok: true, tail: { file, text, lines, last } };
}

/**
 * The file the next ledger line goes in, and the `prev` and `seq` it carries.
 *
 * The last line of the ledger is in the newest period's highest-numbered
 * file. When `[ledger] rotate` changed, periods overlap (a month and a day in
 * it), so every period that ends after the newest period starts is read and
 * the file whose last line has the highest `seq` wins. The line is appended
 * to that file when it belongs to the period `at` falls in and holds fewer
 * than `maxLines` lines. Otherwise it opens the period's next file.
 */
export async function chooseLedgerTarget(
  input: LedgerTargetInput,
): Promise<LedgerTarget> {
  const files: LedgerFile[] = [];
  for (const path of input.paths) {
    if (!path.startsWith(`${PROMOTIONS_DIR}/`)) continue;
    const name = path.slice(PROMOTIONS_DIR.length + 1);
    const parsed = name.includes("/") ? null : parseLedgerFileName(name);
    if (!parsed || !ledgerPeriodBounds(parsed.period)) continue;
    files.push({ path, ...parsed });
  }

  // The highest-numbered file of each period holds that period's last line.
  const newestOf = new Map<string, LedgerFile>();
  for (const file of files) {
    const held = newestOf.get(file.period);
    if (!held || file.n > held.n) newestOf.set(file.period, file);
  }
  let tail: LedgerTail | null = null;
  if (newestOf.size > 0) {
    const bounds = [...newestOf.keys()].map((period) => ({
      period,
      ...ledgerPeriodBounds(period)!,
    }));
    const latestStart = Math.max(...bounds.map((b) => b.start));
    const candidates = bounds
      .filter((b) => b.end > latestStart)
      .map((b) => newestOf.get(b.period)!);
    for (const file of candidates) {
      const read = readLedgerFile(file, await input.read(file.path));
      if (!read.ok) return read;
      if (!tail || read.tail.last.seq > tail.last.seq) tail = read.tail;
    }
  }

  const period = ledgerPeriod(input.at, input.rotate);
  const prev = tail?.last.hash ?? null;
  const seq = (tail?.last.seq ?? 0) + 1;
  const current = newestOf.get(period);
  if (
    current &&
    tail &&
    tail.file.path === current.path &&
    tail.lines.length < input.maxLines
  ) {
    return { ok: true, path: current.path, existing: tail.text, prev, seq };
  }
  const n = current ? current.n + 1 : 1;
  if (n > LEDGER_FILES_PER_PERIOD_MAX) {
    return {
      ok: false,
      message: `the ledger period ${period} already holds ${LEDGER_FILES_PER_PERIOD_MAX} files; raise [ledger] max_lines or rotate more often`,
    };
  }
  return { ok: true, path: ledgerFilePath(period, n), existing: "", prev, seq };
}

/** The UTC instant as the ledger writes it, to the second. */
export function ledgerInstant(at: Date): string {
  return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export interface LedgerLineInput {
  seq: number;
  prev: string | null;
  at: Date;
  provider: RepositoryProvider;
  number: number;
  branch: string;
  mode: GovernanceMode;
  approvedBy: readonly string[];
  mergedBy: string;
  withoutReview: boolean;
  changes: readonly PromotionChange[];
}

/**
 * One ledger line with its hash and a newline, or the field the schema
 * refused. Changes are written in path order.
 */
export function buildLedgerLine(
  input: LedgerLineInput,
): { ok: true; line: string; hash: string } | { ok: false; message: string } {
  const changes = [...input.changes].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  try {
    const line = serializePromotionLine({
      schema: "promotion/v1",
      seq: input.seq,
      at: ledgerInstant(input.at),
      pull_request: { provider: input.provider, number: input.number },
      branch: input.branch,
      mode: input.mode,
      approved_by: [...input.approvedBy],
      merged_by: input.mergedBy,
      without_review: input.withoutReview,
      changes,
      prev: input.prev,
    });
    const parsed = promotionSchema.parse(JSON.parse(line));
    return { ok: true, line, hash: parsed.hash };
  } catch (error) {
    return {
      ok: false,
      message: `the ledger line does not match promotion/v1: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

// ── The merge commit ─────────────────────────────────────────────────────────

export interface MergeTrailerInput {
  /** Who approved, in approval order. Empty when the merge went without review. */
  approvedBy: readonly string[];
  /** The person who merged without an approval, or null when someone approved. */
  withoutReviewBy: string | null;
  /** The checks that passed, by name. */
  checks: readonly string[];
  /** The published version the merge becomes. */
  version: number;
}

/**
 * The trailers the squash merge's message ends with:
 *
 *   Oxagen-Approved-By: dana, priya
 *   Oxagen-Checks: schema,lineage,hash
 *   Oxagen-Version: 413
 *
 * A merge without an approval names who merged instead:
 * `Oxagen-Approved-By: none; merged without review by <actor>`.
 */
export function mergeTrailers(input: MergeTrailerInput): string {
  const approved =
    input.withoutReviewBy !== null
      ? `none; merged without review by ${input.withoutReviewBy}`
      : input.approvedBy.join(", ");
  return [
    `Oxagen-Approved-By: ${approved}`,
    `Oxagen-Checks: ${input.checks.join(",")}`,
    `Oxagen-Version: ${input.version}`,
  ].join("\n");
}

// ── Branches ─────────────────────────────────────────────────────────────────

/** The branch a steering PR for one record uses: `steering/<lineage>`. */
export function steeringBranch(lineage: string): string {
  return `steering/${lineage}`;
}

/**
 * The branch prefix a path belongs under: steering/memory/ uses `memory`, a
 * file at the repository root uses `workspace`, and every other path uses its
 * top-level folder. Null for a top-level folder no prefix names.
 */
export function branchPrefixForPath(path: string): BranchPrefix | null {
  if (!path.includes("/")) return "workspace";
  if (path.startsWith(`${MEMORY_DIR}/`)) return "memory";
  const top = path.slice(0, path.indexOf("/"));
  if (top === STEERING_DIR) return "steering";
  if (top === TOOLS_DIR) return "tools";
  if (top === AGENTS_DIR) return "agents";
  if (top === POLICY_DIR) return "policy";
  return null;
}

/**
 * The unit a path belongs to for the one-change rule: a skill's folder, a
 * policy group's .cedar and .tests.jsonl files, or the file itself.
 */
function changeUnit(path: string): string {
  if (path.startsWith(`${SKILLS_DIR}/`)) {
    const lineage = path.slice(SKILLS_DIR.length + 1).split("/", 1)[0];
    return `${SKILLS_DIR}/${lineage}`;
  }
  if (path.startsWith(`${POLICY_DIR}/`)) {
    return path.replace(/\.tests\.jsonl$/, "").replace(/\.cedar$/, "");
  }
  return path;
}

/** Branches whose pull request may change many files. */
const MANY_FILE_PREFIXES: readonly BranchPrefix[] = ["memory", "tools"];

/**
 * The one steering/ branch that may change many files: the steering PR that
 * imports a workspace's old .oxagen/ records, skills, and governance.toml into
 * its steering repo (steering-repo-spec, Migration). Any other steering/
 * branch still changes one thing.
 */
export const IMPORT_BRANCH = "steering/import-oxagen";

export type BranchScopeRefusal = {
  reason: "branch_prefix" | "branch_scope" | "one_change" | "ledger_owned";
  message: string;
};

/**
 * Why a steering PR's branch and the paths it changes do not fit together, or
 * null when they do. The branch starts with the top-level folder it changes
 * (workspace/ for root files, memory/ for steering/memory/). A memory PR, a
 * tools PR, and the import PR on {@link IMPORT_BRANCH} may change many files.
 * Every other steering PR changes one record, one skill, one agent, one
 * policy group, or one root file. No steering PR may change the ledger, which
 * only the stamp writes.
 */
export function branchScopeRefusal(
  branch: string,
  paths: readonly string[],
): BranchScopeRefusal | null {
  const prefix = branchPrefixOf(branch);
  if (!prefix) {
    return {
      reason: "branch_prefix",
      message: `${branch} does not start with one of ${BRANCH_PREFIXES.map((p) => `${p}/`).join(", ")}`,
    };
  }
  const ledger = paths.find((path) => path.startsWith(`${PROMOTIONS_DIR}/`));
  if (ledger) {
    return {
      reason: "ledger_owned",
      message: `${ledger} is in the ledger, which only Oxagen writes when it stamps a steering PR`,
    };
  }
  const outside = paths.find((path) => branchPrefixForPath(path) !== prefix);
  if (outside) {
    const belongs = branchPrefixForPath(outside);
    return {
      reason: "branch_scope",
      message: belongs
        ? `${outside} belongs on a ${belongs}/ branch, not ${branch}`
        : `${outside} is outside every folder a steering PR may change`,
    };
  }
  if (!MANY_FILE_PREFIXES.includes(prefix) && branch !== IMPORT_BRANCH) {
    const units = new Set(paths.map(changeUnit));
    if (units.size > 1) {
      return {
        reason: "one_change",
        message: `a ${prefix}/ steering PR changes one thing, and ${branch} changes ${units.size}: ${[...units].sort().join(", ")}`,
      };
    }
  }
  return null;
}

// ── The import ───────────────────────────────────────────────────────────────

/** The line that opens the replaces block in an import PR's body. */
export const REPLACES_BLOCK_START = "<!-- oxagen:replaces";

/** The line that closes it. */
const REPLACES_BLOCK_END = "-->";

/**
 * The block an import PR's body carries so the stamp can write each converted
 * record's old id as `replaces` on its ledger line. It holds one line per
 * record: the record's path, a space, and the id it had before the
 * conversion. The block is an HTML comment, so the PR page does not show it.
 */
export function renderReplacesBlock(
  replaces: ReadonlyMap<string, string>,
): string {
  const lines = [...replaces]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, id]) => `${path} ${id}`);
  return [REPLACES_BLOCK_START, ...lines, REPLACES_BLOCK_END].join("\n");
}

export type ReplacesBlock =
  | { ok: true; replaces: Map<string, string> }
  | { ok: false; message: string };

/**
 * The old id of each record an import PR's body names, by path. A body with
 * no block names none. The parse refuses a line that is not a record path and
 * a record id, a path named twice, and a block with no closing line.
 */
export function parseReplacesBlock(body: string): ReplacesBlock {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === REPLACES_BLOCK_START);
  const replaces = new Map<string, string>();
  if (start === -1) return { ok: true, replaces };
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    if (line === REPLACES_BLOCK_END) return { ok: true, replaces };
    if (line === "") continue;
    const [path, id, ...rest] = line.split(/\s+/);
    if (
      rest.length > 0 ||
      !path ||
      !id ||
      !isStampedRecordPath(path) ||
      !recordIdSchema.safeParse(id).success
    ) {
      return {
        ok: false,
        message: `the replaces block line "${line}" is not a record path and a record id`,
      };
    }
    if (replaces.has(path)) {
      return {
        ok: false,
        message: `the replaces block names ${path} twice`,
      };
    }
    replaces.set(path, id);
  }
  return {
    ok: false,
    message: `the replaces block has no closing ${REPLACES_BLOCK_END} line`,
  };
}
