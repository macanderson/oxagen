// promotion.ts: `promotion/v1`, one line of the ledger in
// steering/promotions/ (steering-repo-spec, Repository layout, Steering PR
// flow, and Scale).
//
// Oxagen writes one line per merged steering PR, in the stamp commit at the
// head of the merge queue, and never edits a line. Each line carries the hash
// of the line before it, so the ledger is one chain. The first line of a new
// file carries the last hash of the file before, so the chain crosses files.
//
// The line is written before the squash merge, so it cannot hold the merge
// commit or the published version. The publish records those beside the
// line's `seq` and `hash`.
import { z } from "zod";
import { jcsBytes, sha256Digest } from "@oxagen/run-evidence";
import {
  governanceModeSchema,
  repositoryProviderSchema,
} from "../contracts/context.steering.shared";
import {
  actorSchema,
  instantSchema,
  lineageSchema,
  recordIdSchema,
  repoPathSchema,
  sha256Schema,
} from "./common";
import { BRANCH_PREFIXES } from "./names";

/** One file the steering PR changed. A record carries its lineage and its new id and hash. */
export const promotionChangeSchema = z
  .object({
    path: repoPathSchema,
    action: z.enum(["added", "modified", "removed"]),
    lineage: lineageSchema.optional(),
    id: recordIdSchema.optional(),
    hash: sha256Schema.optional(),
    replaces: recordIdSchema
      .optional()
      .describe(
        "The id this record had before a format change, such as the v0.1 conversion.",
      ),
  })
  .strict();
export type PromotionChange = z.output<typeof promotionChangeSchema>;

const branchSchema = z
  .string()
  .regex(new RegExp(`^(?:${BRANCH_PREFIXES.join("|")})/.+$`))
  .describe("Starts with the top-level folder the change touches.");

export const promotionSchema = z
  .object({
    schema: z.literal("promotion/v1"),
    seq: z
      .number()
      .int()
      .min(1)
      .describe("The line's place in the whole chain, across files."),
    at: instantSchema,
    pull_request: z
      .object({
        provider: repositoryProviderSchema,
        number: z.number().int().positive(),
      })
      .strict(),
    branch: branchSchema,
    mode: governanceModeSchema,
    approved_by: z.array(actorSchema),
    merged_by: actorSchema,
    without_review: z
      .boolean()
      .describe(
        "True when the owner, or a role with merge_without_review, merged without an approval.",
      ),
    changes: z.array(promotionChangeSchema).min(1),
    prev: sha256Schema
      .nullable()
      .describe("The hash of the line before, or null on the first line of the chain."),
    hash: sha256Schema.describe(
      "sha256 over the RFC 8785 canonical JSON of this line without hash.",
    ),
  })
  .strict();
export type PromotionLine = z.output<typeof promotionSchema>;

/** The hash a ledger line carries: sha256 over its canonical JSON without `hash`. */
export function promotionLineHash(line: Omit<PromotionLine, "hash">): string {
  const { hash: _hash, ...rest } = line as PromotionLine;
  return sha256Digest(jcsBytes(rest));
}

/** A line in the order its schema lists the keys, with its hash, and a newline. */
export function serializePromotionLine(
  line: Omit<PromotionLine, "hash">,
): string {
  const ordered = promotionSchema.parse({
    ...line,
    hash: promotionLineHash(line),
  });
  return `${JSON.stringify(ordered)}\n`;
}

/**
 * Where a run of ledger lines breaks its chain: the index of each line whose
 * `prev` is not the hash before it, whose `seq` does not follow, or whose
 * `hash` does not match its content. `prev` is the hash before the first line,
 * or null when it opens the chain.
 */
export function ledgerChainBreaks(
  lines: readonly PromotionLine[],
  prev: string | null,
  firstSeq = 1,
): number[] {
  const breaks: number[] = [];
  let expectedPrev = prev;
  lines.forEach((line, index) => {
    if (
      line.prev !== expectedPrev ||
      line.seq !== firstSeq + index ||
      line.hash !== promotionLineHash(line)
    ) {
      breaks.push(index);
    }
    expectedPrev = line.hash;
  });
  return breaks;
}
