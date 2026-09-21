// audit-exempt: read-only — serializes and signs the org's security_events and mutates nothing; the kernel capability.invoke_* audit records who exported.
//
// `export_audit_events`: the deprecated app's signed audit export
// (apps/app_deprecated/src/lib/audit-query.ts `queryAuditForExport` and
// security/audit/export/audit-export.ts) moved behind a contract. The export
// walks keyset pages of the same read `query_audit_log` pages through, then
// serializes and signs the whole file.
//
// A store failure propagates: the kernel answers an error and nothing is
// signed, because a page that failed and a page that ended look the same to a
// loop that swallows the error, and a short file signed as complete is an
// undetectable gap in the evidence. A filter matching more than
// AUDIT_EXPORT_MAX_ROWS events is refused as invalid_input; the deprecated
// route signed the first 50,000 and said nothing.
//
// Flow:
//   1. Role gate — assertOrgRole: org Owner or Admin, for the signed-in user or
//      the creator of the API key (INV-29).
//   2. Walk pages of EXPORT_PAGE_SIZE until one comes back short.
//   3. Serialize (CSV RFC 4180, or NDJSON) and sign with HMAC-SHA256 under
//      AUDIT_EXPORT_SIGNING_SECRET, or BETTER_AUTH_SECRET when no dedicated key
//      of at least 16 characters is set (#1197).
import { createHmac } from "node:crypto";
import type { CapabilityHandler } from "@oxagen/oxagen";
import { CapabilityError } from "@oxagen/oxagen/kernel";
import type { AuditEvent } from "@oxagen/oxagen/contracts/audit.log.query";
import {
  AUDIT_EXPORT_COLUMNS,
  AUDIT_EXPORT_MAX_ROWS,
  auditEventsExport,
  type AuditEventsExportOutput,
} from "@oxagen/oxagen/contracts/audit.events.export";
import { requireEnv } from "@oxagen/config/env";
import { withSystemDb } from "@oxagen/database";
import { assertOrgRole, resolveActingUserId } from "@oxagen/iam/org-role";
import {
  afterCursor,
  auditConditions,
  type AuditCursor,
  type AuditEventFilter,
  type AuditRow,
  readAuditEvents,
} from "./audit.shared";
import { ORG_AUDIT_ROLES } from "./audit.log.query";

/** Events read per page of the walk. */
export const EXPORT_PAGE_SIZE = 1_000;

/** A dedicated signing key shorter than this is ignored rather than trusted. */
const MIN_SIGNING_SECRET_LENGTH = 16;

export type AuditEventsExportDeps = {
  /** One page of the org's events after `cursor`, newest first. */
  readPage: (
    orgId: string,
    filter: AuditEventFilter & { workspaceId?: string },
    cursor: AuditCursor | null,
    limit: number,
  ) => Promise<AuditRow[]>;
  signingSecret: () => string;
};

type Column = (typeof AUDIT_EXPORT_COLUMNS)[number];

function rowValues(
  orgId: string,
  e: AuditEvent,
): Record<Column, string | AuditEvent["detail"]> {
  return {
    id: e.id,
    occurred_at: e.occurredAt,
    event_type: e.eventType,
    outcome: e.outcome ?? "",
    actor_user_id: e.actorUserId ?? "",
    org_id: orgId,
    workspace_id: e.workspaceId ?? "",
    capability: e.capability ?? "",
    ip: e.ip ?? "",
    user_agent: e.userAgent ?? "",
    request_id: e.requestId ?? "",
    detail: e.detail ?? null,
  };
}

/**
 * A field a spreadsheet would evaluate rather than display. The audit record
 * holds attacker-controlled text — `packages/auth/src/auth.ts` writes the
 * session User-Agent onto an organization's events — so a member can plant
 * `=HYPERLINK(...)` and have it run when an Owner opens the exported file.
 */
const CSV_FORMULA_LEAD = /^[=+\-@\t\r]/;

/**
 * RFC 4180: quote a field that holds a comma, a quote or a line break, and
 * prefix a formula-leading field with a tab so Excel, Numbers and Sheets read
 * it as text. The tab is inside the quotes, so the value a verifier parses
 * back is the recorded one with one leading tab; NDJSON carries it unchanged.
 */
function csvField(value: string): string {
  const text = CSV_FORMULA_LEAD.test(value) ? `\t${value}` : value;
  return /[",\r\n\t]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function serializeAuditExport(
  orgId: string,
  events: readonly AuditEvent[],
  format: "csv" | "ndjson",
): string {
  const rows = events.map((e) => rowValues(orgId, e));
  if (format === "ndjson") {
    return rows.map((r) => `${JSON.stringify(r)}\n`).join("");
  }
  const lines = rows.map((r) =>
    AUDIT_EXPORT_COLUMNS.map((c) => {
      const value = r[c];
      return csvField(
        typeof value === "string"
          ? value
          : value == null
            ? ""
            : JSON.stringify(value),
      );
    }).join(","),
  );
  return `${[AUDIT_EXPORT_COLUMNS.join(","), ...lines].join("\r\n")}\r\n`;
}

/** Hex HMAC-SHA256 of the export body under `secret`. */
export function signAuditExport(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("hex");
}

export function exportSigningSecret(): string {
  const dedicated = process.env["AUDIT_EXPORT_SIGNING_SECRET"];
  if (dedicated && dedicated.length >= MIN_SIGNING_SECRET_LENGTH) {
    return dedicated;
  }
  return requireEnv(["BETTER_AUTH_SECRET"] as const).BETTER_AUTH_SECRET;
}

export function createAuditEventsExportHandler(
  deps: AuditEventsExportDeps,
): CapabilityHandler<typeof auditEventsExport> {
  return async (input, ctx): Promise<AuditEventsExportOutput> => {
    const actingUserId = await resolveActingUserId(ctx);
    await assertOrgRole(
      { orgId: ctx.orgId, userId: actingUserId },
      { org: ORG_AUDIT_ROLES },
    );

    const events: AuditEvent[] = [];
    let cursor: AuditCursor | null = null;
    for (;;) {
      const page = await deps.readPage(
        ctx.orgId,
        input,
        cursor,
        EXPORT_PAGE_SIZE,
      );
      events.push(...page.map((r) => r.event));
      if (events.length > AUDIT_EXPORT_MAX_ROWS) {
        throw new CapabilityError(
          auditEventsExport.name,
          "invalid_input",
          `More than ${AUDIT_EXPORT_MAX_ROWS} events match these filters; narrow the time range and export again`,
        );
      }
      const last = page.at(-1);
      if (page.length < EXPORT_PAGE_SIZE || last === undefined) break;
      cursor = last.cursor;
    }

    const body = serializeAuditExport(ctx.orgId, events, input.format);
    return {
      format: input.format,
      body,
      signature: signAuditExport(body, deps.signingSecret()),
      algorithm: "HMAC-SHA256",
      rowCount: events.length,
    };
  };
}

export const auditEventsExportHandler = createAuditEventsExportHandler({
  readPage: (orgId, filter, cursor, limit) =>
    withSystemDb((tx) =>
      readAuditEvents(
        tx,
        [
          ...auditConditions(orgId, filter.workspaceId ?? null, filter),
          ...(cursor === null ? [] : [afterCursor(cursor)]),
        ],
        { limit, offset: 0 },
      ),
    ),
  signingSecret: exportSigningSecret,
});
