// The Audit page: control-plane events, incidents, receipts, holds, exports,
// keys, erasure and retention (spec §6.10, §13, App. A.9).
import { z } from "zod";
import {
  AgentKey,
  Count,
  Day,
  EnforcementTier,
  Instant,
  Money,
  PublicId,
  Severity,
  Slug,
  ToolVersionRef,
} from "./common";

/** Who did it: a person, an agent, or a system component (the reconciler, the verifier). */
export const Actor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("person"), personId: PublicId }),
  z.object({ kind: z.literal("agent"), agentKey: AgentKey }),
  z.object({ kind: z.literal("system"), name: z.string() }),
]);
export type Actor = z.infer<typeof Actor>;

export const AuditEvent = z.object({
  at: Instant,
  /** A control-plane action kind or an incident kind, dotted snake case. */
  kind: z.string().regex(/^[a-z_]+(\.[a-z_]+)*$/),
  actor: Actor,
  summary: z.string(),
  severity: Severity,
  /** The id the event is about (a run, approval, key, hold, policy version, commit). */
  ref: z.string(),
});
export type AuditEvent = z.infer<typeof AuditEvent>;

export const IncidentKind = z.enum([
  "mandate_exception",
  "assurance_gap",
  "taint_raised",
  "witness_tampered",
  "chain_break",
  "hooks_removed",
  "credential_probe",
  "unobserved_session",
  "token_replay",
  "witness_probe",
  "steering_drift",
]);
export type IncidentKind = z.infer<typeof IncidentKind>;

/** Incident kinds that count as tamper detections against an agent. */
export const TAMPER_INCIDENT_KINDS = [
  "hooks_removed",
  "chain_break",
  "credential_probe",
  "witness_tampered",
  "witness_probe",
] as const satisfies readonly IncidentKind[];

export const Incident = z.object({
  id: PublicId,
  severity: Severity,
  kind: IncidentKind,
  title: z.string(),
  at: Instant,
  detectedBy: z.string(),
  /** The agent the incident is scoped to, when it is scoped to one. */
  agentKey: AgentKey.nullable(),
  runIds: z.array(PublicId),
  scope: z.string(),
  detail: z.string(),
  resolution: z.string(),
  status: z.enum(["open", "resolved"]),
  ownerId: PublicId.nullable(),
  dueOn: Day.nullable(),
  closedAt: Instant.nullable(),
  closedBy: z.string().nullable(),
});
export type Incident = z.infer<typeof Incident>;

/** One labelled fact on a receipt. `key` is stable; the label comes from the catalog. */
export const ReceiptFact = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  value: z.string(),
  mono: z.boolean(),
});
export type ReceiptFact = z.infer<typeof ReceiptFact>;

export const Receipt = z.object({
  id: PublicId,
  at: Instant,
  /** An enrolled agent, or the in-app agent (`oxagen.assistant`). */
  agent: z.string(),
  operatorId: PublicId,
  tool: ToolVersionRef,
  /** `observed` when the gateway did not decide the call (observe tier). */
  decision: z.enum(["allow", "approve", "deny", "observed"]),
  tier: EnforcementTier,
  externalEffect: z.string(),
  amount: Money.nullable(),
  workspaceSlug: Slug,
  runId: PublicId.nullable(),
  who: z.array(ReceiptFact),
  what: z.array(ReceiptFact),
  authority: z.array(ReceiptFact),
  credential: z.array(ReceiptFact),
  effect: z.array(ReceiptFact),
  integrity: z.array(ReceiptFact),
});
export type Receipt = z.infer<typeof Receipt>;

export const LegalHold = z.object({
  id: PublicId,
  matter: z.string(),
  scope: z.string(),
  placedById: PublicId,
  placedAt: Instant,
  releasedAt: Instant.nullable(),
  status: z.enum(["active", "released"]),
  note: z.string(),
});
export type LegalHold = z.infer<typeof LegalHold>;

export const ArchiveExport = z.object({
  id: PublicId,
  description: z.string(),
  from: Day,
  to: Day,
  contents: z.string(),
  size: z.string(),
  createdAt: Instant,
  createdById: PublicId,
  status: z.enum(["ready", "building"]),
  signature: z.string().nullable(),
  keys: z.string(),
});
export type ArchiveExport = z.infer<typeof ArchiveExport>;

export const EncryptionKey = z.object({
  id: z.string(),
  purpose: z.enum(["kek", "attestation", "device"]),
  name: z.string(),
  algorithm: z.string(),
  generation: Count,
  validFrom: z.union([Instant, Day]),
  validTo: z.union([Instant, Day]),
  status: z.enum(["active", "retiring", "retired", "expired"]),
  covers: z.string(),
});
export type EncryptionKey = z.infer<typeof EncryptionKey>;

export const ErasureRequest = z.object({
  id: PublicId,
  subject: z.string(),
  requestedAt: Instant,
  requestedById: PublicId,
  status: z.enum(["pending", "blocked_by_hold", "keys_destroyed"]),
  effectiveAt: Instant.nullable(),
  dueAt: Instant.nullable(),
  scope: z.string(),
  holdId: PublicId.nullable(),
  note: z.string().nullable(),
});
export type ErasureRequest = z.infer<typeof ErasureRequest>;

export const RetentionTier = z.object({
  tier: z.enum(["ledger", "frames", "bodies", "control_plane_audit"]),
  store: z.string(),
  contents: z.string(),
  retention: z.string(),
  volume: z.string(),
});
export type RetentionTier = z.infer<typeof RetentionTier>;

export const AssuranceHistoryRow = z.object({
  suiteVersion: z.string(),
  ranAt: Instant,
  cases: Count,
  passed: Count,
  failed: Count,
  notApplicable: Count,
  against: z.string(),
  note: z.string().nullable(),
});
export type AssuranceHistoryRow = z.infer<typeof AssuranceHistoryRow>;
