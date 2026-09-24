"use client";
// The record's header (#3395; mockups/pages/record.md, mockup `pRecord`).
//
// The statement is the headline. A build that leads with the lineage, the id
// or the status has inverted the record: the lineage is an address, the id is
// bookkeeping, and the status is how the record is doing, while the statement
// is what the record IS. Everything else on this header reads as metadata.
//
// The actions sit on the header because they act on the whole record: Discard
// returns the draft to what is in force, Archive opens the pull request that
// takes it out of force, and Propose a change, the one gold action, opens the
// pull request that changes its words.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RecordDetail } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  buttonSecondary,
  eyebrow,
  linkText,
  mono,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { KindBadge, KindTile } from "./kind";
import type { RecordAt } from "./view";

/** `.btn.danger`: the red outline a destructive action takes. */
export const buttonDanger =
  "inline-flex min-h-8 max-md:min-h-11 items-center justify-center gap-1.5 rounded-[9px] border border-error/45 bg-card px-[13px] py-1.5 text-[13px] font-medium text-error-ink transition-colors hover:bg-error/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-45";

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;

export function Header({
  at,
  detail,
  pendingBranch,
  dirty,
  onDiscard,
  onArchive,
  onPropose,
}: {
  at: RecordAt;
  detail: RecordDetail;
  /** The branch of a proposal already open on this lineage, if any. */
  pendingBranch: string | null;
  /** The draft differs from the statement in force. */
  dirty: boolean;
  onDiscard: () => void;
  onArchive: () => void;
  onPropose: () => void;
}) {
  const t = useTranslations("record.header");
  const term = useTranslations("ui.record");
  const { record, provenance } = detail;
  const statement = record.statement ?? record.title;
  const archived = record.status !== "active";
  const commit = (provenance?.commit ?? record.commit)?.slice(0, 7) ?? null;
  const kindLine =
    record.kind === null ? t("unclassifiedLine") : t(`kindLine.${record.kind}`);
  return (
    <header
      data-testid="record-header"
      className="flex flex-col gap-4 pb-[18px] md:flex-row md:items-start md:justify-between"
    >
      <div className="flex min-w-0 flex-col">
        <p className={`${eyebrow} mb-1`}>
          <SafeLink
            to={routes.steering(at.org, at.ws, { tab: "records" })}
            className={`${linkText} underline`}
          >
            {t("steering")}
          </SafeLink>
          <span aria-hidden="true"> · </span>
          <span>{t("record")}</span>
        </p>
        <div className="flex items-start gap-3">
          {record.kind === null ? null : <KindTile kind={record.kind} />}
          <h1 className="min-w-0 max-w-[62ch] text-lg font-semibold leading-[1.35] text-foreground md:text-[21px]">
            {statement}
          </h1>
        </div>
        <div
          data-testid="record-chips"
          className="mt-2.5 flex flex-wrap items-center gap-1.5"
        >
          {record.kind === null ? (
            <Badge tone="quiet" dot={false} data-term="kind">
              {term("unclassified")}
            </Badge>
          ) : (
            <KindBadge kind={record.kind} />
          )}
          {record.force === null ? null : (
            <span title={t("forceTitle")}>
              <Badge tone="quiet" dot={false} data-term="force">
                {record.force}
              </Badge>
            </span>
          )}
          {record.constraintEffect === null ? null : (
            <span title={t("effectTitle")}>
              <Badge
                tone={
                  record.constraintEffect === "forbid" ? "denied" : "approval"
                }
                dot={false}
                data-term="constraint-effect"
              >
                {term(`effects.${record.constraintEffect}`)}
              </Badge>
            </span>
          )}
          <Badge tone="quiet" dot={false} data-term="scope">
            {term(`scopes.${record.sharingScope}`)}
          </Badge>
          {archived ? (
            <Badge tone="quiet" dot={false} data-term="status">
              {t("archived")}
            </Badge>
          ) : (
            <Badge tone="allowed" data-term="status">
              {t("published")}
            </Badge>
          )}
          {pendingBranch === null ? null : (
            <Badge tone="approval" data-term="pending">
              <span className={mono}>{pendingBranch}</span>
            </Badge>
          )}
        </div>
        {/* Why the record is in force, and how it stops being in force. Both
            answers are the same answer: a pull request merged, and a pull
            request will merge. */}
        <p
          data-testid="record-in-force"
          className="mt-2.5 max-w-[70ch] text-[13px] text-muted-foreground"
        >
          {commit === null
            ? t("inForceNoCommit", { kindLine })
            : t.rich("inForce", { kindLine, commit, code })}
        </p>
      </div>
      <div className="flex shrink-0 gap-2 max-md:w-full max-md:[&>*]:flex-1">
        <button
          type="button"
          data-testid="record-discard"
          disabled={!dirty}
          onClick={onDiscard}
          className={buttonSecondary}
        >
          {t("discard")}
        </button>
        {archived ? null : (
          <button
            type="button"
            data-testid="record-archive-open"
            aria-haspopup="dialog"
            onClick={onArchive}
            className={buttonDanger}
          >
            {t("archive")}
          </button>
        )}
        {/* The page's one gold action. Gold is identity, so it marks the act
            this page exists for and never a state. */}
        <button
          type="button"
          data-testid="record-propose-open"
          aria-haspopup="dialog"
          onClick={onPropose}
          className={`${buttonPrimary} max-md:flex-[2]`}
        >
          {t("propose")}
        </button>
      </div>
    </header>
  );
}
