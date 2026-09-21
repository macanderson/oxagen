// The record's header (#3395; mockups/pages/record.md).
//
// The statement is the headline. A build that leads with the lineage, the id
// or the status has inverted the record: the lineage is an address, the id is
// bookkeeping, and the status is how the record is doing, while the statement
// is what the record IS. Everything else on this header reads as metadata,
// which is what it is.
import { useTranslations } from "next-intl";
import type { RecordDetail } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { eyebrow, linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { KindGlyph } from "./kind-panel";
import type { RecordAt } from "./view";

const chip = "rounded-sm border border-border px-1.5 py-0.5";

export function Header({
  at,
  detail,
  pendingBranch,
}: {
  at: RecordAt;
  detail: RecordDetail;
  /** The branch of a proposal already open on this lineage, if any. */
  pendingBranch: string | null;
}) {
  const t = useTranslations("record.header");
  const term = useTranslations("ui.record");
  const { record } = detail;
  const statement = record.statement ?? record.title;
  const archived = record.status !== "active";
  return (
    <header className="flex flex-col gap-4">
      <nav aria-label={t("breadcrumbs")} className={eyebrow}>
        <SafeLink
          to={routes.steering(at.org, at.ws, { tab: "records" })}
          className={linkText}
        >
          {t("steering")}
        </SafeLink>
        <span aria-hidden="true"> · </span>
        <span>{t("record")}</span>
      </nav>
      <div className="flex items-start gap-4">
        {record.kind === null ? null : <KindGlyph kind={record.kind} />}
        <h1 className="min-w-0 max-w-[62ch] text-2xl font-semibold leading-snug text-foreground sm:text-[28px]">
          {statement}
        </h1>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span data-term="kind" className={`${chip} font-medium`}>
          {record.kind === null
            ? term("unclassified")
            : term(`kinds.${record.kind}`)}
        </span>
        {record.force === null ? null : (
          <span data-term="force" className={chip}>
            {term("force", { force: record.force })}
          </span>
        )}
        {record.constraintEffect === null ? null : (
          <span data-term="constraint-effect" className={chip}>
            {term(`effects.${record.constraintEffect}`)}
          </span>
        )}
        <span data-term="scope" className={chip}>
          {term(`scopes.${record.sharingScope}`)}
        </span>
        <span
          data-term="status"
          data-status={record.status}
          className={`${chip} ${archived ? "text-muted-foreground" : "text-foreground"}`}
        >
          {archived ? t("archived") : t("published")}
        </span>
        {pendingBranch === null ? null : (
          <span
            data-term="pending"
            className={`${chip} ${mono} text-muted-foreground`}
          >
            {t("pendingBranch", { branch: pendingBranch })}
          </span>
        )}
      </div>
      {/* Why the record is in force, and how it stops being in force. Both
          answers are the same answer: a pull request merged, and a pull
          request will merge. Nothing on this page changes that by itself. */}
      <p className="max-w-prose text-sm text-muted-foreground">
        {record.kind === null
          ? t("inForceUnclassified")
          : t("inForce", { kind: term(`kinds.${record.kind}`) })}
      </p>
    </header>
  );
}
