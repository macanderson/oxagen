/**
 * promote.ts — Mine recurring lessons from local thinking logs and the fleet
 * memory store, and — only on explicit approval — promote them into enforced
 * `.oxagen/rules/*.md` files that `loader.ts` reads back and `enforce.ts` can
 * turn into a hard guard.
 *
 * This is the CLI-local half of "engram promotion" described in
 * docs/specs/stella-graph-memory-sync/spec.md (§3.2, Phase 4): the platform's
 * `detectPatterns`/`promotePatterns` (packages/engram/src/consolidation) mine
 * recurring *tool-call sequences* out of the graph episodic store; this module
 * mines recurring *textual lessons* — advisor-judge findings/remaining-work from
 * {@link TurnTrace} and lessons already recorded in the fleet memory store — out
 * of the CLI's local, filesystem-only stores, so promotion works fully offline
 * and signed out. Like the platform version, a candidate never becomes a rule
 * silently: mining only ever produces a ranked list; {@link promoteCandidate}
 * writes a file exclusively when the caller passes `approve: true`.
 *
 * Recurrence is scored with the same kind of transparent lexical overlap the
 * fleet store's `recall` uses (see agent/fleet/memory.ts) rather than
 * embeddings — no model call, works offline, good enough to cluster the
 * handful of lessons an agent keeps re-learning.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { TurnTrace } from "../agent/trace.js";
import type { MemoryRecord } from "../agent/fleet/memory.js";
import type { Rule, RuleGuard } from "./types.js";

/** One recurrence of a candidate lesson, with enough context to audit the mining. */
export interface RuleEvidence {
  source: "trace-finding" | "trace-reasoning" | "memory";
  /** Where this occurrence came from: `trace:<turnId>#judge<round>.finding<i>` or `memory:<id>`. */
  ref: string;
  occurredAt: number;
  /** The lesson text as it appeared at this occurrence (truncated). */
  snippet: string;
}

export interface RuleCandidate {
  /** Stable id derived from the representative text — also the rule filename stem. */
  id: string;
  /** The representative lesson text — becomes the promoted rule's body. */
  text: string;
  /** One-line summary written as `description:` frontmatter. */
  description: string;
  /** How many recurrences fed this candidate. */
  occurrences: number;
  /** True when at least one occurrence came from an already-salient (RULE/FACT, or high-enforcement) memory. */
  salient: boolean;
  evidence: RuleEvidence[];
  /** Best-effort guard inferred from consistent file evidence; undefined = prompt-only (Tier 1). */
  guard?: RuleGuard;
  /** Ranking score, highest first — occurrence count, boosted for salience. */
  score: number;
}

export interface MineConfig {
  /** Minimum recurrences before a non-salient cluster becomes a candidate. Default 3. */
  minOccurrences?: number;
  /** Jaccard term-overlap threshold to cluster two lessons as "the same". Default 0.5. */
  minSimilarity?: number;
  /** Max candidates returned, ranked by score. Default 10. */
  limit?: number;
}

const DEFAULT_CONFIG: Required<MineConfig> = {
  minOccurrences: 3,
  minSimilarity: 0.5,
  limit: 10,
};

export interface MineInput {
  /** Turns to mine judge findings/remaining-work from (trace store + verbose log, deduped). */
  traces: TurnTrace[];
  /** Fleet memory records to mine lessons from (the guaranteed local JSONL store). */
  memories: MemoryRecord[];
  /** Already-active rules — a candidate that duplicates one of these is dropped. */
  existingRules?: Rule[];
}

const STOPWORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "to",
  "of",
  "in",
  "on",
  "for",
  "with",
  "is",
  "are",
  "be",
  "this",
  "that",
  "it",
  "as",
  "at",
  "by",
  "from",
  "into",
  "we",
  "you",
  "i",
  "was",
  "were",
  "has",
  "have",
  "had",
  "not",
  "but",
  "if",
  "so",
  "then",
  "than",
  "when",
  "where",
  "which",
  "will",
  "would",
  "should",
  "did",
]);

/** Split text into lowercased, de-stopped terms for lexical clustering. */
function terms(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOPWORDS.has(t),
  );
}

/** Jaccard similarity of two term sets — 0 when either is empty. */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Filesystem/rule-id-safe slug: lowercase, alnum + dashes, capped so ids stay short. */
function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "lesson";
}

/** Short deterministic content hash so re-mining the same data yields the same candidate id. */
function hash8(text: string): string {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

interface RawObservation {
  text: string;
  source: RuleEvidence["source"];
  ref: string;
  occurredAt: number;
  files: string[];
  salient: boolean;
  memoryKind?: MemoryRecord["memoryKind"];
}

/**
 * Pull mineable observations out of one turn's judge rounds. Only `findings`
 * and `remainingWork` are mined — short, atomic gap statements that plausibly
 * repeat across turns — not the free-form `reasoning` prose, which is too
 * verbose to cluster reliably on term overlap.
 */
function observationsFromTrace(trace: TurnTrace): RawObservation[] {
  const out: RawObservation[] = [];
  trace.judgeRounds.forEach((verdict, round) => {
    verdict.findings.forEach((finding, i) => {
      const text = finding.trim();
      if (!text) return;
      out.push({
        text,
        source: "trace-finding",
        ref: `trace:${trace.id}#judge${round}.finding${i}`,
        occurredAt: trace.createdAt,
        files: [],
        salient: false,
      });
    });
    verdict.remainingWork.forEach((item, i) => {
      const text = item.trim();
      if (!text) return;
      out.push({
        text,
        source: "trace-finding",
        ref: `trace:${trace.id}#judge${round}.remaining${i}`,
        occurredAt: trace.createdAt,
        files: [],
        salient: false,
      });
    });
  });
  return out;
}

/** Salient = already elevated past a raw OBSERVATION, or explicitly high-enforcement. */
function isSalientMemory(r: MemoryRecord): boolean {
  return r.memoryClass !== "OBSERVATION" || (r.enforcementScore ?? 0) >= 90;
}

function observationsFromMemory(records: MemoryRecord[]): RawObservation[] {
  return records
    .filter((r) => r.lesson.trim().length > 0)
    .map((r) => ({
      text: r.lesson.trim(),
      source: "memory" as const,
      ref: `memory:${r.id}`,
      occurredAt: r.createdAt,
      files: r.files,
      salient: isSalientMemory(r),
      memoryKind: r.memoryKind,
    }));
}

/**
 * The longest common leading directory across every path, or null if they share
 * none.
 *
 * Comparison is per path SEGMENT, not per character: `src/foo` and `src/foobar`
 * share `src`, not `src/foo`. A raw `startsWith` would answer `src/foo` (or
 * `src`, depending on which path happened to come first), producing a
 * `src/foo/**` guard that silently fails to cover `src/foobar` — and a different
 * guard for the same evidence in a different order.
 */
function commonDirPrefix(paths: string[]): string | null {
  const dirs = paths.map((p) =>
    p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "",
  );
  if (dirs.length === 0 || dirs.some((d) => !d)) return null; // a bare filename can't anchor a safe glob
  let prefix = dirs[0]!.split("/");
  for (const d of dirs.slice(1)) {
    const segments = d.split("/");
    let shared = 0;
    while (
      shared < prefix.length &&
      shared < segments.length &&
      prefix[shared] === segments[shared]
    ) {
      shared++;
    }
    if (shared === 0) return null;
    prefix = prefix.slice(0, shared);
  }
  return prefix.join("/") || null;
}

/**
 * Best-effort guard inference: when a cluster's memory-sourced evidence is all
 * `gotcha`-kind (the one FleetMemory kind already treated as enforceable
 * elsewhere, see adapters/memory-provider.ts) and shares a common directory,
 * propose blocking that directory. Anything looser is left prompt-only (Tier 1)
 * rather than guessing a guard that could wrongly hard-block unrelated work.
 */
function inferGuard(cluster: RawObservation[]): RuleGuard | undefined {
  const gotchas = cluster.filter(
    (o) => o.memoryKind === "gotcha" && o.files.length > 0,
  );
  if (gotchas.length === 0) return undefined;
  const prefix = commonDirPrefix(gotchas.flatMap((o) => o.files));
  return prefix ? { denyPathGlob: `${prefix}/**` } : undefined;
}

/** The cluster's most representative wording: the most-repeated exact text, longest wins ties. */
function representativeText(cluster: RawObservation[]): string {
  const counts = new Map<string, number>();
  for (const o of cluster) counts.set(o.text, (counts.get(o.text) ?? 0) + 1);
  let best = cluster[0]!.text;
  let bestCount = 0;
  for (const [text, count] of counts) {
    if (
      count > bestCount ||
      (count === bestCount && text.length > best.length)
    ) {
      best = text;
      bestCount = count;
    }
  }
  return best;
}

/** True when an existing rule already says essentially the same thing. */
function alreadyCaptured(
  text: string,
  existingRules: Rule[],
  minSimilarity: number,
): boolean {
  const t = new Set(terms(text));
  return existingRules.some(
    (r) => jaccard(t, new Set(terms(r.text))) >= minSimilarity,
  );
}

/**
 * Mine {@link MineInput} into ranked rule-promotion candidates. A cluster of
 * similar-enough observations (Jaccard ≥ `minSimilarity`) qualifies when either:
 *   - it recurred at least `minOccurrences` times, or
 *   - any occurrence is already a salient (RULE/FACT, or high-enforcement) memory.
 * Candidates that duplicate an existing rule's text are dropped, so a promoted
 * (or hand-authored) rule naturally stops resurfacing as a candidate.
 */
export function mineCandidates(
  input: MineInput,
  config: MineConfig = {},
): RuleCandidate[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const observations = [
    ...input.traces.flatMap(observationsFromTrace),
    ...observationsFromMemory(input.memories),
  ];

  // Greedy single-pass clustering: each observation joins the first cluster its
  // term set overlaps enough with, else starts a new one. Each cluster caches
  // its head's term set, so tokenizing is O(n) rather than O(n × clusters).
  const clusters: Array<{ members: RawObservation[]; headTerms: Set<string> }> =
    [];
  for (const obs of observations) {
    const obsTerms = new Set(terms(obs.text));
    const home = clusters.find(
      (c) => jaccard(obsTerms, c.headTerms) >= cfg.minSimilarity,
    );
    if (home) home.members.push(obs);
    else clusters.push({ members: [obs], headTerms: obsTerms });
  }

  const existingRules = input.existingRules ?? [];
  const candidates: RuleCandidate[] = [];
  for (const { members: cluster } of clusters) {
    const salient = cluster.some((o) => o.salient);
    if (cluster.length < cfg.minOccurrences && !salient) continue;

    const text = representativeText(cluster);
    if (alreadyCaptured(text, existingRules, cfg.minSimilarity)) continue;

    const guard = inferGuard(cluster);
    const evidence: RuleEvidence[] = cluster
      .slice()
      .sort((a, b) => b.occurredAt - a.occurredAt)
      .map((o) => ({
        source: o.source,
        ref: o.ref,
        occurredAt: o.occurredAt,
        snippet: o.text.slice(0, 160),
      }));

    candidates.push({
      id: `${slugify(text)}-${hash8(text)}`,
      text,
      description: `Promoted from ${cluster.length} recurring observation${cluster.length === 1 ? "" : "s"}${salient ? " (includes an already-salient memory)" : ""}.`,
      occurrences: cluster.length,
      salient,
      evidence,
      guard,
      score: cluster.length * 10 + (salient ? 50 : 0),
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates.slice(0, cfg.limit);
}

export interface PromoteOptions {
  /** Directory rules are written to — normally `<cwd>/.oxagen/rules`. */
  dir: string;
  /** Explicit user approval. Without it nothing is written — the decline path. */
  approve: boolean;
}

export interface PromoteResult {
  /** Where the rule file would be / was written. */
  path: string;
  /** `declined` = approve was false, nothing touched; `already-exists` = left untouched, not overwritten. */
  status: "written" | "declined" | "already-exists";
}

/**
 * Write (or preview) one candidate as `.oxagen/rules/<id>.md`, in exactly the
 * frontmatter shape `rules/loader.ts` parses back — the same `description` /
 * `guard-tool` / `guard-deny-path` / `guard-deny-command` keys `write.ts`'s
 * hand-authored scaffold uses, so a promoted rule is indistinguishable from a
 * hand-written one to the loader, `renderRulesSection`, and `guardsToDeny`.
 *
 * Never writes without `approve: true` (the decline path), and never clobbers
 * a file already at that path (idempotent re-promotion, and it protects any
 * hand-edits a human made to a previously-promoted rule).
 */
export function promoteCandidate(
  candidate: RuleCandidate,
  opts: PromoteOptions,
): PromoteResult {
  const path = join(opts.dir, `${candidate.id}.md`);
  if (!opts.approve) return { path, status: "declined" };
  if (existsSync(path)) return { path, status: "already-exists" };

  const frontmatter = ["---", `description: ${candidate.description}`];
  if (candidate.guard?.tool)
    frontmatter.push(`guard-tool: ${candidate.guard.tool}`);
  if (candidate.guard?.denyPathGlob)
    frontmatter.push(`guard-deny-path: ${candidate.guard.denyPathGlob}`);
  if (candidate.guard?.denyCommandGlob)
    frontmatter.push(`guard-deny-command: ${candidate.guard.denyCommandGlob}`);
  frontmatter.push("---", "", candidate.text, "");

  mkdirSync(opts.dir, { recursive: true });
  writeFileSync(path, frontmatter.join("\n"), "utf8");
  return { path, status: "written" };
}
