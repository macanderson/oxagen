// Signed audit-log export (OXA-1558).
//
// GET /{orgSlug}/security/audit/export?format=ndjson|csv&<same filters as the viewer>
//
// Gates (all re-checked here — the disabled UI button is not the security
// boundary):
//   1. Authenticated session                      → 401
//   2. Org membership                              → 404 (no existence leak)
//   3. owner/admin role                            → 403
//   4. Enterprise plan (SOC 2 export is gated)     → 402
//
// The body is signed with HMAC-SHA256 and the signature + algorithm are returned
// in headers so an auditor can verify integrity of the downloaded file.

import { resolveOrg, getOrgRole, SECURITY_MANAGER_ROLES } from "@/lib/resolve-org";
import { getSession } from "@/lib/session";
import { assertEnterprise } from "@/lib/enterprise";
import { isTierDenied } from "@oxagen/billing";
import { requireEnv } from "@oxagen/config/env";
import { parseAuditFilter, type RawSearchParams } from "@/lib/audit-filters";
import { queryAuditForExport } from "@/lib/audit-query";
import {
  serializeAuditExport,
  signAuditExport,
  exportContentType,
  exportFilename,
  AUDIT_EXPORT_HMAC_ALGO,
  type AuditExportFormat,
} from "@/lib/audit-export";

// Node runtime: node:crypto HMAC + DB access. Never cache (access-controlled).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function signingSecret(): string {
  // A dedicated key is preferred; fall back to the always-present auth secret so
  // the feature works out-of-the-box. Both are >= 32 bytes.
  const dedicated = process.env["AUDIT_EXPORT_SIGNING_SECRET"];
  if (dedicated && dedicated.length >= 16) return dedicated;
  return requireEnv(["BETTER_AUTH_SECRET"] as const).BETTER_AUTH_SECRET;
}

export async function GET(
  req: Request,
  ctx: { params: Promise<{ orgSlug: string }> },
): Promise<Response> {
  const { orgSlug } = await ctx.params;
  const url = new URL(req.url);

  // 1. Auth.
  const session = await getSession();
  if (!session?.user) return new Response("Unauthorized", { status: 401 });

  // Resolve org (404s unknown slug via notFound()).
  const tenant = await resolveOrg(orgSlug);

  // 2. Membership (null role = not a member → 404, no existence leak).
  const role = await getOrgRole(tenant.id, session.user.id);
  if (!role) return new Response("Not found", { status: 404 });

  // 3. Role.
  if (!SECURITY_MANAGER_ROLES.has(role)) {
    return new Response("Forbidden: owner or admin role required", { status: 403 });
  }

  // 4. Enterprise plan.
  try {
    await assertEnterprise(tenant.id, "audit-export");
  } catch (err) {
    if (isTierDenied(err)) {
      return new Response("Payment required: SOC 2 audit export is an Enterprise feature", {
        status: 402,
      });
    }
    throw err;
  }

  // Parse filters (multi-value aware) + format.
  const raw: RawSearchParams = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    raw[key] = all.length > 1 ? all : all[0];
  }
  const filter = parseAuditFilter(raw);
  // Export the full filtered set, not a single page → ignore any cursor.
  filter.cursor = null;

  const formatParam = url.searchParams.get("format");
  const format: AuditExportFormat = formatParam === "csv" ? "csv" : "ndjson";

  const rows = await queryAuditForExport(tenant.id, filter);
  const body = serializeAuditExport(rows, format);
  const signature = signAuditExport(body, signingSecret());
  const stamp = new Date().toISOString();

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": exportContentType(format),
      "Content-Disposition": `attachment; filename="${exportFilename(format, stamp)}"`,
      "X-Audit-Export-Signature": signature,
      "X-Audit-Export-Signature-Algorithm": AUDIT_EXPORT_HMAC_ALGO,
      "X-Audit-Export-Row-Count": String(rows.length),
      "Cache-Control": "no-store",
    },
  });
}
