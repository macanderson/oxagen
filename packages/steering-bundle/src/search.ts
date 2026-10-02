// search.ts: search_steering (steering-repo-spec, Agent use).
//
// It returns index lines for the records and skills that match a query, a
// kind, or a repository, from the workspace's and the organization's
// published versions. It finds no tools: tools come from the tool list or a
// server's own search tool. An agent reads a body it finds with read_steering.
//
// The input and output shapes live in @oxagen/oxagen, where the contract
// registers them, and this module re-exports them.
import type { BundleRecord } from "@oxagen/oxagen/steering-repo/bundle";
import {
  STEERING_SEARCH_DEFAULT_LIMIT,
  type SteeringSearchInput,
  type SteeringSearchOutput,
} from "@oxagen/oxagen/steering-repo/steering-tools";
import { indexLine, type BundleSource, type Delivery } from "./render";
import { compareText } from "./tree";

export {
  STEERING_SEARCH_DEFAULT_LIMIT,
  STEERING_SEARCH_MAX_LIMIT,
  steeringSearchHitSchema,
  steeringSearchInputSchema,
  steeringSearchOutputSchema,
  type SteeringSearchHit,
  type SteeringSearchInput,
  type SteeringSearchOutput,
} from "@oxagen/oxagen/steering-repo/steering-tools";

/** The lowercase words of a query. */
export function queryWords(query: string | undefined): string[] {
  if (query === undefined) return [];
  return [...new Set(query.toLowerCase().split(/[^a-z0-9$]+/).filter((word) => word !== ""))];
}

/** How well a record matches the words: a label match weighs 3, a description match 2, a lineage match 1. */
export function scoreRecord(record: BundleRecord, words: readonly string[]): number {
  const label = record.label.toLowerCase();
  const description = (record.description ?? "").toLowerCase();
  const lineage = record.lineage.toLowerCase();
  let score = 0;
  for (const word of words) {
    if (label.includes(word)) score += 3;
    if (description.includes(word)) score += 2;
    if (lineage.includes(word)) score += 1;
  }
  return score;
}

function reachesRepository(record: BundleRecord, repository: string | undefined): boolean {
  return repository === undefined || record.repos === undefined || record.repos.includes(repository);
}

function isAlwaysOn(record: BundleRecord): boolean {
  return (
    (record.force === "must" || record.force === "should") &&
    record.load === "always" &&
    record.skills === undefined
  );
}

/** Search the published versions. With no query, every record that fits the filters matches, in lineage order. */
export function searchSteering(delivery: Delivery, input: SteeringSearchInput): SteeringSearchOutput {
  const words = queryWords(input.query);
  const limit = input.limit ?? STEERING_SEARCH_DEFAULT_LIMIT;
  const scored: Array<{ record: BundleRecord; source: BundleSource; score: number }> = [];
  const sources: Array<[BundleSource, Delivery[BundleSource]]> = [
    ["organization", delivery.organization],
    ["workspace", delivery.workspace],
  ];
  for (const [source, bundle] of sources) {
    for (const record of bundle?.records ?? []) {
      if (input.kind !== undefined && record.kind !== input.kind) continue;
      if (!reachesRepository(record, input.repository)) continue;
      const score = words.length === 0 ? 0 : scoreRecord(record, words);
      if (words.length > 0 && score === 0) continue;
      scored.push({ record, source, score });
    }
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      compareText(a.record.lineage, b.record.lineage) ||
      compareText(a.source, b.source),
  );
  return {
    workspace_version: delivery.workspace?.version ?? null,
    organization_version: delivery.organization?.version ?? null,
    total: scored.length,
    hits: scored.slice(0, limit).map(({ record, source }) => ({
      lineage: record.lineage,
      label: record.label,
      ...(record.description === undefined ? {} : { description: record.description }),
      kind: record.kind,
      force: record.force,
      always_on: isAlwaysOn(record),
      source,
      line: indexLine(record),
    })),
  };
}
