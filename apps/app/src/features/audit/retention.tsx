// The header's mono line (rev1 audit.md, Header): "control-plane events
// retained 7 years · run ledger forever · bodies 7 years by default · <org>".
//
// Each segment prints what backs it and nothing stronger. Control-plane events
// are held seven years by the audit partition maintenance (ADR-125). The body
// retention is the longest window a pinned retention policy declares
// (get_evidence_retention), and "not recorded" when none is pinned or the read
// does not answer. The run ledger's retention has no record at all (#3878), so
// its segment says so instead of "forever".
import "server-only";
import { useTranslations } from "next-intl";
import type { EvidenceRetention } from "@/data/contracts/audit";
import type { DataSource } from "@/data/ports";
import type { Read } from "@/data/read";
import type { OrgCtx } from "@/server/viewer";

const DAYS_PER_YEAR = 365;

/**
 * A retention window in the words a person reads it in: whole years when the
 * policy declares whole years, days otherwise. Null when no policy is pinned.
 */
export function useRetentionWindow(): (days: number | null) => string | null {
  const t = useTranslations("audit");
  return (days) => {
    if (days === null) return null;
    return days % DAYS_PER_YEAR === 0
      ? t("retentionYears", { count: days / DAYS_PER_YEAR })
      : t("retentionDays", { count: days });
  };
}

function RetentionLine({
  org,
  read,
}: {
  org: string;
  read: Read<EvidenceRetention>;
}) {
  const t = useTranslations("audit");
  const windowOf = useRetentionWindow();
  const bodies = read.ok ? windowOf(read.value.bodyRetentionDays) : null;
  return (
    <p
      data-testid="audit-retention-line"
      className="font-mono text-[11.5px] text-dim"
    >
      {t("retentionLine", { bodies: bodies ?? t("notRecorded"), org })}
    </p>
  );
}

export async function AuditRetentionLine({
  ctx,
  source,
}: {
  ctx: OrgCtx;
  source: DataSource;
}) {
  const read = await source.audit.retention(ctx);
  return <RetentionLine org={ctx.orgSlug} read={read} />;
}
