// The audit port on the kernel (ARCHITECTURE.md §3.3): one page of the
// organization's security audit events (query_audit_log) and the signed export
// over the same filters (export_audit_events), both noBillingGate reads. The
// page's filters become the contracts' input here: the actor is a public id,
// and the UTC days `from` and `to` become an inclusive start instant and an
// exclusive end instant the day after `to`. A refusal passes through as the
// kernel classified it; an answer the view model refuses is reported once as
// record_unmappable.
import "server-only";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  AUDIT_PAGE_SIZE,
  AuditExport,
  type AuditFilters,
  AuditPage,
} from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toAuditExport, toAuditPage } from "./mappers/audit";

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

/** The instant a UTC day ends: midnight at the start of the next day. */
function dayAfter(day: string): string {
  const end = new Date(`${day}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  return end.toISOString();
}

/** The filters as both contracts take them, an unset filter left out. */
function contractFilters(f: AuditFilters) {
  return {
    ...(f.eventType === null ? {} : { eventType: f.eventType }),
    ...(f.outcome === null ? {} : { outcome: f.outcome }),
    ...(f.actor === null ? {} : { actorPublicId: f.actor }),
    ...(f.capability === null ? {} : { capability: f.capability }),
    ...(f.from === null ? {} : { from: `${f.from}T00:00:00.000Z` }),
    ...(f.to === null ? {} : { to: dayAfter(f.to) }),
  };
}

export const audit: DataSource["audit"] = {
  async events(ctx, q) {
    const { offset, ...filters } = q;
    const read = await kernelRead(ctx, {
      contract: auditLogQuery,
      input: {
        source: "security",
        ...contractFilters(filters),
        limit: AUDIT_PAGE_SIZE,
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
};
