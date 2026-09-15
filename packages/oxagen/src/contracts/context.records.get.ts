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

export const publishedRecordDetailSchema = z
  .object({
    source: z.literal("published"),
    record: publishedRecordSchema,
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
  layers: ["schema", "api", "mcp", "unit", "docs"],
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
