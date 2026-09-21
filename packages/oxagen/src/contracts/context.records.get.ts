// get_record — one record by id: a published record (`ctr_…` or its lineage
// id) with its versions and the Context PR that published it, or a record an
// agent appended (`cta_…`) with its provenance (ADR-061; MC spec §9, App. E).
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  appendKindSchema,
  publishedRecordSchema,
  publishedSharingScopeSchema,
} from "./context.steering.shared";

const instant = z.string().datetime({ offset: true });

/**
 * Where the bytes on screen came from.
 *
 * `file` — read back out of `.oxagen/rules/<lineage>.toml` on the production
 * branch, which is what is actually in force. `registry` — the Postgres
 * mirror answered because the repository could not: no main repository is
 * bound, or GitHub refused. The two are told apart rather than blended
 * because a reader deciding whether to trust a rule needs to know which one
 * they are looking at, and because a mirror that has drifted from the file
 * looks exactly like a file when the difference is hidden.
 */
export const recordBackingSchema = z.enum(["file", "registry"]);

/**
 * The commit that published the record: its provenance, per MC spec §10.2.
 *
 * Read from the history of the record's file on the production branch every
 * time, never from a column. A record is in force because its commit merged,
 * so the commit is the fact; a column is a copy of the fact that a later
 * revision leaves stale. Null when the file has no history to read — an
 * unbound repository, or a record that only the registry holds.
 */
export const recordProvenanceSchema = z
  .object({
    commit: z.string(),
    authorName: z.string(),
    /** The author's GitHub login, when GitHub matched the commit to an account. */
    authorLogin: z.string().nullable(),
    committedAt: instant,
    summary: z.string(),
  })
  .strict();

/**
 * What the record has done, over the runs that recorded using it.
 *
 * Both counts are distinct runs. Null when this workspace has no context-use
 * rollup at all, which is not the same fact as a record nothing used: a page
 * renders the null as "not recorded" and never as a zero, because a zero here
 * reads as "every run ignored this rule".
 */
export const recordEffectSchema = z
  .object({
    rendered: z.number().int().nonnegative(),
    cited: z.number().int().nonnegative(),
  })
  .strict();

export const publishedRecordDetailSchema = z
  .object({
    source: z.literal("published"),
    /**
     * `id` and `updatedAt` are nullable here and nowhere else the published
     * record appears. Everywhere else the record IS a registry row, so both
     * are facts about that row. Here the record can come from its file, and a
     * file that the registry has no row for — a record published by a commit
     * this workspace has not mirrored, or whose row was removed — still has a
     * lineage, a kind, a statement and a commit that put it in force. Refusing
     * to answer for it would make the mirror, not the repository, the thing
     * that decides whether a governed rule can be read back.
     */
    record: publishedRecordSchema.extend({
      id: publishedRecordSchema.shape.id.nullable(),
      updatedAt: publishedRecordSchema.shape.updatedAt.nullable(),
    }),
    backing: recordBackingSchema,
    provenance: recordProvenanceSchema.nullable(),
    effect: recordEffectSchema.nullable(),
    versions: z.array(
      z
        .object({
          id: z.string().regex(/^crv_[0-9A-Za-z]+$/),
          version: z.number().int().positive(),
          checksum: z.string(),
          isLatest: z.boolean(),
          publishedAt: instant.nullable(),
        })
        .strict(),
    ),
    /** The proposal whose merge published the active version; null otherwise. */
    proposalId: z
      .string()
      .regex(/^prp_[0-9A-Za-z]+$/)
      .nullable(),
    prUrl: z.string().nullable(),
  })
  .strict();

export const appendedRecordDetailSchema = z
  .object({
    source: z.literal("appended"),
    record: z
      .object({
        id: z.string().regex(/^cta_[0-9A-Za-z]+$/),
        kind: appendKindSchema,
        lineageId: z.string(),
        statement: z.string(),
        sharingScope: publishedSharingScopeSchema,
        recordHash: z.string(),
        sourceRefs: z.array(z.string()),
        evidenceLinks: z.array(z.string()),
        /** The proposal a `record_proposal` append opened. */
        proposalId: z
          .string()
          .regex(/^prp_[0-9A-Za-z]+$/)
          .nullable(),
        createdAt: instant,
      })
      .strict(),
  })
  .strict();

export const contextRecordsGet = registerCapability({
  name: "get_record",
  domain: "context",
  description:
    "Get one context record: a published record by ctr_ id or lineage id with its versions and publishing PR, or an appended record by cta_ id with its provenance",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs", "app"],
  scoped: true,
  noBillingGate: true,
  mutates: false,
  agent: {
    requiresApproval: false,
    riskLevel: "low",
    category: "introspection",
  },
  sensitivity: "low",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow", Viewer: "allow" },
  },
  input: z
    .object({
      recordId: z
        .string()
        .min(1)
        .max(200)
        .describe("A ctr_ public id, a lineage id, or a cta_ public id"),
    })
    .strict(),
  output: z.discriminatedUnion("source", [
    publishedRecordDetailSchema,
    appendedRecordDetailSchema,
  ]),
});

export type ContextRecordsGetInput = z.output<typeof contextRecordsGet.input>;
export type ContextRecordsGetOutput = z.output<typeof contextRecordsGet.output>;
