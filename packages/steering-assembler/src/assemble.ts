/**
 * The one place where everything that could steer an agent competes for
 * Oxagen's slice of its context (ADR-093).
 *
 * `assembleSteering` takes every candidate a run could be told, ranks them by
 * tier and then by recency, fits the ranked list to a token budget, and
 * returns the text the agent reads together with a manifest that names every
 * candidate, whether it was included or cut, and why. The manifest is what
 * makes "did this record reach any agent" a read rather than a guess: it is
 * sealed into the run record as its own frame kind, `steering.manifest`.
 *
 * ## Ranking
 *
 * Tier first: `must`, then `should`, then `may`, then `info`. Within a tier the
 * newest item ranks first, and two items recorded at the same instant are
 * ordered by id, so the same candidate set always assembles the same text
 * whatever order the store returned it in. The text is part of the policy
 * bundle etag, and an etag that moved with row order would make every host
 * refetch an unchanged bundle.
 *
 * ## Budget: skip, do not stop
 *
 * Items are walked best-first and one that does not fit is skipped while the
 * walk continues, so a single long item near the top cannot discard every
 * short one beneath it. The cost is that the included set is not a prefix of
 * the ranking, which is why every cut is named rather than left for the reader
 * to infer from a count. This is the rule `packWithinBudget` in the former
 * `@oxagen/context-provider` applied to Context Graph Protocol frames, and the
 * token unit is that protocol's: `ceil(utf8_bytes / 4)` (`budgetTokens`).
 *
 * ## Why an item is cut
 *
 * - `tier`: the injection point does not deliver this force. The session
 *   prefix carries `must` and `should`; `may` and `info` wait for a channel
 *   that can rank against the prompt (ADR-093 §4).
 * - `superseded`: a newer item shares its lineage. Only the newest version of
 *   a record, or the newest steer in a thread, is a candidate.
 * - `budget`: it ranked, and the text had no room left for it.
 */
import { createHash } from "node:crypto";
import { budgetTokens } from "@contextgraphprotocol/typescript-sdk";

/** The forces an item can carry, in the order they rank. */
export const STEERING_FORCES = ["must", "should", "may", "info"] as const;
export type SteeringForce = (typeof STEERING_FORCES)[number];

/** The source families an item can come from (ADR-093 §2, plus `steer`). */
export const STEERING_ITEM_KINDS = [
  "record",
  "steer",
  "skill",
  "memory",
  "ontology",
  "policy",
  "instruction",
] as const;
export type SteeringItemKind = (typeof STEERING_ITEM_KINDS)[number];

/** The forces the session-start prefix delivers. */
export const PREFIX_FORCES: readonly SteeringForce[] = ["must", "should"];

/**
 * The most text each wrapped harness puts into the model's context from one
 * hook answer, in characters, where the harness documents a limit. Past it,
 * the agent reads a file path and a short preview, not the text.
 *
 * - Claude Code caps `additionalContext` and hook stdout at 10,000
 *   characters, with no setting to raise it
 *   (https://code.claude.com/docs/en/hooks).
 * - Codex caps `additionalContext` at about 2,500 tokens by default
 *   (`additionalContextLimit`, https://learn.chatgpt.com/docs/hooks). Its
 *   count is an estimate, so 2,500 tokens is taken as 10,000 characters.
 * - Cursor documents no limit on `additional_context`.
 * - Stella reads `SessionStart` stdout whole.
 */
export const HARNESS_CONTEXT_MAX_CHARS: Readonly<
  Record<"claude-code" | "codex" | "cursor" | "stella", number | null>
> = {
  "claude-code": 10_000,
  codex: 10_000,
  cursor: null,
  stella: null,
};

/** The smallest documented limit in `HARNESS_CONTEXT_MAX_CHARS`. */
export const SMALLEST_HARNESS_CONTEXT_MAX_CHARS = Math.min(
  ...Object.values(HARNESS_CONTEXT_MAX_CHARS).filter(
    (max): max is number => max !== null,
  ),
);

/**
 * The budget for the session-start prefix, in budget tokens
 * (`ceil(utf8_bytes / 4)`). One bundle serves every harness on a host, so
 * the prefix has to fit the smallest limit above. 2,000 tokens is at most
 * 8,000 bytes, and so at most 8,000 characters: under Claude Code's hard
 * 10,000, with a fifth to spare for Codex, whose own token estimate can
 * count more tokens than bytes divided by four.
 */
export const PREFIX_BUDGET_TOKENS = 2_000;

/** One thing a run could be told. Adapters produce these and own nothing else. */
export interface SteeringCandidate {
  /** Stable identity: a record's slug, a steer command's public id, a skill's name. */
  id: string;
  kind: SteeringItemKind;
  force: SteeringForce;
  /** The line the agent reads, without its leading bullet. */
  body: string;
  /**
   * When this version took effect, ISO 8601. Newer ranks first within a tier.
   * An unparseable value ranks as the oldest.
   */
  recordedAt: string;
  /**
   * Items sharing a lineage are versions of one thing, and only the newest is
   * a candidate. Defaults to `id`, so two candidates with one id are one
   * thing too.
   */
  lineage?: string;
}

/** What one assembly is for. */
export interface RunContext {
  orgId: string;
  workspaceId: string;
  /** The run the text is assembled for, when there is one. */
  runId?: string;
  /** The forces this injection point delivers. Defaults to the prefix's. */
  delivers?: readonly SteeringForce[];
  candidates: readonly SteeringCandidate[];
}

export type SteeringCutReason = "tier" | "budget" | "superseded";

export interface SteeringManifestItem {
  id: string;
  kind: SteeringItemKind;
  force: SteeringForce;
  recorded_at: string;
  /** The budget cost of this item's line on its own. */
  tokens: number;
  outcome: "included" | "cut";
  reason?: SteeringCutReason;
  /** For `superseded`: the id of the newer item that won. */
  superseded_by?: string;
}

export const STEERING_MANIFEST_SCHEMA = "oxagen.steering.manifest/1" as const;

/** Every candidate, in rank order, with what happened to it. */
export interface SteeringManifest {
  schema: typeof STEERING_MANIFEST_SCHEMA;
  delivers: SteeringForce[];
  budget_tokens: number;
  /** The budget cost of the assembled text, 0 when there is none. */
  spent_tokens: number;
  included: number;
  cut: number;
  /** `sha256:<hex>` of the assembled text, or null when there is none. */
  text_digest: string | null;
  items: SteeringManifestItem[];
}

export interface AssembledSteering {
  /** The text the agent reads, or null when nothing was included. */
  text: string | null;
  manifest: SteeringManifest;
}

/**
 * ADR-091's header, unchanged: the prefix a host receives for a workspace
 * that has only records keeps the wording it had before the assembler, and
 * the wording makes no claim about steers, which the host delivers beside
 * this text rather than inside it.
 */
export const STEERING_HEADER =
  "This workspace's published steering records, merged by its reviewers through Oxagen. " +
  "Follow every MUST record. Follow every SHOULD record unless the task gives you a stated reason not to.";

const HEADINGS: Record<SteeringForce, string> = {
  must: "MUST",
  should: "SHOULD",
  may: "MAY",
  info: "INFO",
};

function omittedLine(count: number): string {
  return count === 1
    ? "1 more record was left out because the steering text reached its size limit."
    : `${count} more records were left out because the steering text reached its size limit.`;
}

function instantOf(iso: string): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/** Tier, then newest first, then id: a total order over any candidate set. */
export function compareCandidates(
  a: SteeringCandidate,
  b: SteeringCandidate,
): number {
  const byForce =
    STEERING_FORCES.indexOf(a.force) - STEERING_FORCES.indexOf(b.force);
  if (byForce !== 0) return byForce;
  const at = instantOf(a.recordedAt);
  const bt = instantOf(b.recordedAt);
  if (at !== bt) return at > bt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
}

/** Pick the newest version before applying delivery tiers. */
function supersede(
  ranked: readonly SteeringCandidate[],
): Map<SteeringCandidate, string> {
  const winners = new Map<string, SteeringCandidate>();
  for (const candidate of ranked) {
    const lineage = `${candidate.kind}:${candidate.lineage ?? candidate.id}`;
    const winner = winners.get(lineage);
    if (
      winner === undefined ||
      instantOf(candidate.recordedAt) > instantOf(winner.recordedAt)
    ) {
      winners.set(lineage, candidate);
    }
  }
  const losers = new Map<SteeringCandidate, string>();
  for (const candidate of ranked) {
    const winner = winners.get(
      `${candidate.kind}:${candidate.lineage ?? candidate.id}`,
    )!;
    if (candidate !== winner) losers.set(candidate, winner.id);
  }
  return losers;
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex")}`;
}

/**
 * Assemble the steering text for a run under a token budget, and say what
 * happened to every candidate.
 *
 * `budget` is in budget tokens, `ceil(utf8_bytes / 4)`. A host that caps the
 * text in characters is safe at `chars / 4`, since a string never has more
 * characters than bytes.
 */
export function assembleSteering(
  run: RunContext,
  budget: number,
): AssembledSteering {
  const delivers = [...(run.delivers ?? PREFIX_FORCES)];
  const maxTokens = Math.max(0, Math.floor(budget));
  const ranked = [...run.candidates].sort(compareCandidates);
  const superseded = supersede(ranked);
  const outcomes = new Map<SteeringCandidate, SteeringManifestItem>();
  const deliverable: SteeringCandidate[] = [];

  for (const candidate of ranked) {
    const base: SteeringManifestItem = {
      id: candidate.id,
      kind: candidate.kind,
      force: candidate.force,
      recorded_at: candidate.recordedAt,
      tokens: budgetTokens(`- ${candidate.body}`),
      outcome: "cut",
    };
    const winner = superseded.get(candidate);
    if (winner !== undefined) {
      outcomes.set(candidate, {
        ...base,
        reason: "superseded",
        superseded_by: winner,
      });
    } else if (!delivers.includes(candidate.force)) {
      outcomes.set(candidate, { ...base, reason: "tier" });
    } else {
      outcomes.set(candidate, base);
      deliverable.push(candidate);
    }
  }

  const lines: string[] = [STEERING_HEADER];
  let current: SteeringForce | null = null;
  let included = 0;
  let cutForBudget = 0;
  for (let i = 0; i < deliverable.length; i++) {
    const candidate = deliverable[i]!;
    const next: string[] = [];
    if (candidate.force !== current) next.push("", HEADINGS[candidate.force]);
    next.push(`- ${candidate.body}`);
    // Room for this item, and for the note naming what was left out if
    // anything already was or anything after it fails to fit. The count in
    // that note can only be smaller than this bound, so the reserve holds.
    const mayBeOmitted = cutForBudget + (deliverable.length - i - 1);
    const reserve =
      mayBeOmitted > 0 ? budgetTokens(`\n\n${omittedLine(mayBeOmitted)}`) : 0;
    const text = [...lines, ...next].join("\n");
    if (budgetTokens(text) + reserve > maxTokens) {
      cutForBudget += 1;
      outcomes.set(candidate, {
        ...outcomes.get(candidate)!,
        reason: "budget",
      });
      continue;
    }
    lines.push(...next);
    current = candidate.force;
    included += 1;
    outcomes.set(candidate, {
      ...outcomes.get(candidate)!,
      outcome: "included",
    });
  }

  let text: string | null = null;
  if (included > 0) {
    if (cutForBudget > 0) lines.push("", omittedLine(cutForBudget));
    text = lines.join("\n");
  }

  const items = ranked.map((candidate) => outcomes.get(candidate)!);
  return {
    text,
    manifest: {
      schema: STEERING_MANIFEST_SCHEMA,
      delivers,
      budget_tokens: maxTokens,
      spent_tokens: text === null ? 0 : budgetTokens(text),
      included,
      cut: items.length - included,
      text_digest: text === null ? null : digest(text),
      items,
    },
  };
}
