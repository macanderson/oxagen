// The audit port on the kernel (ARCHITECTURE.md §3.3): one page of the
// organization's security audit events (query_audit_log), the signed export
// over the same filters (export_audit_events), the evidence retention posture
// (get_evidence_retention) and one queued organization export
// (get_export_status), all noBillingGate reads. The
// page's filters become the contracts' input here: the actor is a public id,
// and the day range arrives already resolved as an inclusive start instant and
// an exclusive end one (`since` and `until` of AuditWindow). Which instants a
// civil day spans depends on the viewer's zone, and this layer has no viewer:
// the feature that resolved one resolves the window too (ARCHITECTURE.md §2,
// §3.3). A refusal passes through as the kernel classified it; an answer the
// view model refuses is reported once as record_unmappable.
import "server-only";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { billingEvidenceRetention } from "@oxagen/oxagen/contracts/billing.evidence_retention";
import { privacyDataExportStatus } from "@oxagen/oxagen/contracts/privacy.data.export.status";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  AuditBundle,
  AuditExport,
  AuditPage,
  type AuditWindow,
  AuditRetention,
} from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import {
  toAuditBundle,
  toAuditExport,
  toAuditPage,
  toAuditRetention,
} from "./mappers/audit";

function toView<O, V extends z.ZodType>(
  read: Read<O>,
  view: V,
  map: (out: O) => z.input<V>,
  at: { orgId: string; method: string },
): Read<z.output<V>> {
  if (!read.ok) return read;
  const parsed = view.safeParse(map(read.value));
  if (parsed.success) return readOk(parsed.data);
  captureError({
    error: parsed.error,
    source: "app",
    orgId: at.orgId,
    context: `audit.${at.method} record_unmappable`,
  });
  return readError("record_unmappable", 502);
}

/** The window as both contracts take it, an unset filter left out. */
function contractFilters(f: AuditWindow) {
  return {
    ...(f.eventType === null ? {} : { eventType: f.eventType }),
    ...(f.outcome === null ? {} : { outcome: f.outcome }),
    ...(f.actor === null ? {} : { actorPublicId: f.actor }),
    ...(f.capability === null ? {} : { capability: f.capability }),
    ...(f.since === null ? {} : { from: f.since }),
    ...(f.until === null ? {} : { to: f.until }),
  };
}

export const audit: DataSource["audit"] = {
  async events(ctx, q) {
    const { offset, limit, ...filters } = q;
    const read = await kernelRead(ctx, {
      contract: auditLogQuery,
      input: {
        source: "security",
        ...contractFilters(filters),
        limit,
        offset,
      },
      page: "audit",
    });
    return toView(read, AuditPage, toAuditPage, {
      orgId: ctx.orgId,
      method: "events",
    });
  },
  async exportEvents(ctx, q) {
    const { format, ...filters } = q;
    const read = await kernelRead(ctx, {
      contract: auditEventsExport,
      input: { format, ...contractFilters(filters) },
      page: "audit",
    });
    return toView(read, AuditExport, toAuditExport, {
      orgId: ctx.orgId,
      method: "exportEvents",
    });
  },
  async retention(ctx) {
    const read = await kernelRead(ctx, {
      contract: billingEvidenceRetention,
      input: {},
      page: "audit",
    });
    return toView(read, AuditRetention, toAuditRetention, {
      orgId: ctx.orgId,
      method: "retention",
    });
  },
  async bundle(ctx, exportId) {
    const read = await kernelRead(ctx, {
      contract: privacyDataExportStatus,
      input: { exportId },
      page: "audit",
    });
    return toView(read, AuditBundle, toAuditBundle, {
      orgId: ctx.orgId,
      method: "bundle",
    });
  },
};
