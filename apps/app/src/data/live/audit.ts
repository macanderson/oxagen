// The audit port on the kernel (ARCHITECTURE.md §3.3): one page of the
// organization's security audit events (query_audit_log) and the signed export
// over the same filters (export_audit_events), both noBillingGate reads. The
// page's filters become the contracts' input here: the actor is a public id,
// and the calendar days `from` and `to` become an inclusive start instant and
// an exclusive end instant the day after `to`, both in the viewer's zone so a
// day that prints as Sep 18 stays the Sep 18 query and export. A refusal
// passes through as the kernel classified it; an answer the view model refuses
// is reported once as record_unmappable.
import "server-only";
import { auditEventsExport } from "@oxagen/oxagen/contracts/audit.events.export";
import { auditLogQuery } from "@oxagen/oxagen/contracts/audit.log.query";
import { DEFAULT_TIME_ZONE } from "@oxagen/oxagen/contracts/user.preferences.read";
import { captureError } from "@oxagen/telemetry";
import type { z } from "zod";
import {
  AUDIT_PAGE_SIZE,
  AuditExport,
  type AuditFilters,
  AuditPage,
} from "@/data/contracts/audit";
import {
  startOfNextZonedDay,
  startOfZonedDay,
} from "@/data/contracts/calendar-day";
import type { DataSource } from "@/data/ports";
import { type Read, readError, readOk } from "@/data/read";
import { kernelRead } from "@/server/kernel";
import { toAuditExport, toAuditPage } from "./mappers/audit";
import { shell } from "./shell";

type AuditCtx = Parameters<DataSource["audit"]["events"]>[0];

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

async function viewerZone(ctx: AuditCtx): Promise<string> {
  const preferences = await shell.preferences(ctx);
  return preferences.ok ? preferences.value.timeZone : DEFAULT_TIME_ZONE;
}

/** The filters as both contracts take them, an unset filter left out. */
function contractFilters(f: AuditFilters, timeZone: string) {
  const from =
    f.from === null ? undefined : (startOfZonedDay(f.from, timeZone) ?? undefined);
  const to =
    f.to === null
      ? undefined
      : (startOfNextZonedDay(f.to, timeZone) ?? undefined);
  return {
    ...(f.eventType === null ? {} : { eventType: f.eventType }),
    ...(f.outcome === null ? {} : { outcome: f.outcome }),
    ...(f.actor === null ? {} : { actorPublicId: f.actor }),
    ...(f.capability === null ? {} : { capability: f.capability }),
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

export const audit: DataSource["audit"] = {
  async events(ctx, q) {
    const { offset, ...filters } = q;
    const timeZone = await viewerZone(ctx);
    const read = await kernelRead(ctx, {
      contract: auditLogQuery,
      input: {
        source: "security",
        ...contractFilters(filters, timeZone),
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
    const timeZone = await viewerZone(ctx);
    const read = await kernelRead(ctx, {
      contract: auditEventsExport,
      input: { format, ...contractFilters(filters, timeZone) },
      page: "audit",
    });
    return toView(read, AuditExport, toAuditExport, {
      orgId: ctx.orgId,
      method: "exportEvents",
    });
  },
};
