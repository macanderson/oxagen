// query_audit_log and export_audit_events output to the Audit view model
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`: the actor is
// the user's public id and the workspace its slug, so no raw row id reaches
// the page (INV-11).
import type { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import type { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import type { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import type { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import type { z } from "zod";
import type {
  AuditBundle,
  AuditExport,
  AuditPage,
  EvidenceRetention,
} from "@/data/contracts/audit";
import { microsFromDecimal } from "@/data/contracts/money";
import type { ContractOutput } from "@/server/kernel";

export function toAuditPage(
  out: ContractOutput<typeof auditLogQuery>,
): z.input<typeof AuditPage> {
  return {
    events: out.events.map((event) => ({
      occurredAt: event.occurredAt,
      eventType: event.eventType,
      actor: event.actorPublicId,
      capability: event.capability,
      outcome: event.outcome,
      workspace: event.workspaceSlug,
      ip: event.ip,
      userAgent: event.userAgent,
      request: event.requestId,
      detail: event.detail ?? null,
    })),
    hasMore: out.hasMore,
    offset: out.offset,
    limit: out.limit,
  };
}

export function toAuditExport(
  out: ContractOutput<typeof auditEventsExport>,
): z.input<typeof AuditExport> {
  return {
    format: out.format,
    body: out.body,
    signature: out.signature,
    algorithm: out.algorithm,
    rowCount: out.rowCount,
  };
}

/**
 * The rate arrives as a float of US dollars; it becomes micros through the
 * one decimal parser (money.ts), so no figure passes through float arithmetic.
 * A rate that parser refuses (an exponent, more than six decimals) is left
 * null rather than rounded, and the page says it is not recorded.
 */
export function toEvidenceRetention(
  out: ContractOutput<typeof billingEvidenceRetention>,
): z.input<typeof EvidenceRetention> {
  const micros = microsFromDecimal(String(out.usdPerGbMonth));
  return {
    includedMonths: out.includedMonths,
    bodyRetentionDays: out.effectiveRetentionDays,
    rate: micros === null ? null : { micros, currency: "USD" },
    storedGbBeyondIncluded: out.storedGbMeasured
      ? out.storedGbBeyondIncluded
      : null,
  };
}

export function toAuditBundle(
  out: ContractOutput<typeof privacyDataExportStatus>,
): z.input<typeof AuditBundle> {
  return {
    exportId: out.exportId,
    status: out.status,
    ready: out.ready,
    completedAt: out.completedAt,
  };
}
