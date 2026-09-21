// query_audit_log and export_audit_events output to the Audit view model
// (ARCHITECTURE.md §3.4). Typed from each contract's `_output`: the actor is
// the user's public id and the workspace its slug, so no raw row id reaches
// the page (INV-11).
import type { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import type { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import type { z } from "zod";
import type { AuditExport, AuditPage } from "@/data/contracts/audit";
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
