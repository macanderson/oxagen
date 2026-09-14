// Mandates: bounded, expiring authority for a consequence (spec §6.9,
// App. A.5 `tools.mandates`, `tools.mandate_ledger`).
import { z } from "zod";
import {
  AgentKey,
  ConsequenceTag,
  Count,
  Day,
  Instant,
  Money,
  PublicId,
  ToolPattern,
  ToolVersionRef,
} from "./common";

export const MandateStatus = z.enum([
  "active",
  "suspended",
  "expired",
  "revoked",
]);
export type MandateStatus = z.infer<typeof MandateStatus>;

export const Mandate = z.object({
  id: PublicId,
  agentKey: AgentKey,
  grantedById: PublicId,
  roleAtGrant: z.string(),
  secondApproverId: PublicId.nullable(),
  twoPerson: z.boolean(),
  consequenceTags: z.array(ConsequenceTag).min(1),
  limits: z.object({
    perCall: Money,
    perPeriod: Money,
    period: z.enum(["daily", "weekly", "monthly"]),
    callsPerDay: Count.nullable(),
  }),
  /** Ledger position this period. Remaining is after reservations. */
  usage: z.object({ settled: Money, reserved: Money, remaining: Money }),
  counterparties: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  tools: z.array(ToolPattern).min(1),
  approval: z.object({
    humanAbove: Money,
    alwaysHumanFor: z.array(ConsequenceTag),
    approvers: z.array(z.string()),
  }),
  purpose: z.string(),
  validFrom: Day,
  validTo: Day,
  status: MandateStatus,
});
export type Mandate = z.infer<typeof Mandate>;

export const MandateLedgerEntry = z.object({
  mandateId: PublicId,
  at: Instant,
  tool: ToolVersionRef,
  kind: z.enum(["reserve", "settle", "release"]),
  amount: Money,
  /** The transaction, migration, message or deployment id. */
  externalEffectId: z.string().nullable(),
  /** Why a release happened, or what a reservation waits on. */
  note: z.string().nullable(),
  receiptId: PublicId.nullable(),
  periodKey: z.string(),
});
export type MandateLedgerEntry = z.infer<typeof MandateLedgerEntry>;

export const MandateDetail = z.object({
  mandate: Mandate,
  ledger: z.array(MandateLedgerEntry),
});
export type MandateDetail = z.infer<typeof MandateDetail>;
