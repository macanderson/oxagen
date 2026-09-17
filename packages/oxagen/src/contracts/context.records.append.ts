// append_record — the protocol's `context/append` for agents (ADR-061; MC
// spec §9): an observation, a memory, a knowledge claim, evidence, a record
// of context being used, or a record proposal. Content-addressed by
// `record_hash` (RFC 8785 with Stella's null-stripping; packages/run-evidence
// record-hash.ts) and idempotent per workspace.
//
// An agent may only propose a directive. A `directive` kind is not in the
// enum, and a caller that asks for one by name is refused with
// `directive_requires_context_pr` by the handler, so the reason reaches the
// agent as a code rather than as an enum error.
import { z } from "zod";
import { registerCapability } from "../registry";
import {
  appendKindSchema,
  constraintEffectSchema,
  publishedSharingScopeSchema,
  recordForceSchema,
  recordKindSchema,
} from "./context.steering.shared";

const lineageId = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/);

export const contextRecordsAppend = registerCapability({
  name: "append_record",
  domain: "context",
  description:
    "Append one context record to the workspace — an observation, memory, knowledge claim, evidence, context-use record or record proposal — content-addressed by record_hash. A directive is refused: it reaches the workspace only through a Context PR.",
  mode: "sync",
  surfaces: ["api", "mcp", "agent"],
  layers: ["schema", "api", "mcp", "unit", "docs"],
  scoped: true,
  noBillingGate: true,
  mutates: true,
  agent: { requiresApproval: false, riskLevel: "low", category: "memory" },
  sensitivity: "medium",
  defaultEffect: "deny",
  defaultRoles: {
    org: { Owner: "allow", Admin: "allow" },
    workspace: { Owner: "allow", Member: "allow" },
  },
  input: z
    .object({
      /**
       * The §9 kinds an agent may append. `directive` is accepted by the
       * schema as a string so the handler can refuse it with its own code.
       */
      kind: z.union([appendKindSchema, z.literal("directive")]),
      lineageId: lineageId.describe("The idea this record belongs to"),
      statement: z.string().min(1).max(4000),
      /** The scopes a workspace read enforces; the ones a Context PR can publish. */
      sharingScope: publishedSharingScopeSchema.default("workspace"),
      /** Frames (`frame:<run>/<seq>`) and records this one derives from. */
      sourceRefs: z.array(z.string().min(1).max(512)).max(100).default([]),
      /** Frames or tool outputs by digest that prove it. */
      evidenceLinks: z.array(z.string().min(1).max(512)).max(100).default([]),
      /**
       * Required when `kind` is `record_proposal`: what the lineage should
       * become and why. Refused on every other kind.
       */
      proposal: z
        .object({
          kind: recordKindSchema,
          force: recordForceSchema,
          constraintEffect: constraintEffectSchema.optional(),
          rationale: z.string().min(1).max(4000),
        })
        .strict()
        .optional(),
    })
    .strict(),
  output: z
    .object({
      /** The appended record's public id (`cta_…`). */
      recordId: z.string(),
      recordHash: z.string(),
      kind: appendKindSchema,
      /** False when a record with this hash already existed in the workspace. */
      appended: z.boolean(),
      /** The proposal a `record_proposal` opened (`prp_…`); null otherwise. */
      proposalId: z.string().nullable(),
    })
    .strict(),
});

export type ContextRecordsAppendInput = z.output<
  typeof contextRecordsAppend.input
>;
export type ContextRecordsAppendOutput = z.output<
  typeof contextRecordsAppend.output
>;
