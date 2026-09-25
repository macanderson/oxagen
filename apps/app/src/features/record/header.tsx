"use client";
// The record's header (#3395; ADR-178).
//
// The label is the headline. A record is named first and its slug is derived
// from that name, so the label is what a reader calls the record, and the
// slug under it is the address that never changes. The statement is what the
// record says, and it opens the editor directly below, where it can be read
// whole and changed. A sentence-long statement as the h1 buried every other
// fact on the page, which is what ADR-178 replaced.
//
// The properties are named, not bare chips: "must" alone does not say it is
// the force a run applies the record at.
//
// The actions sit on the header because they act on the whole record: Clone
// opens a new record from this one's file, Discard returns the draft to what
// is in force, Archive opens the pull request that takes it out of force, and
// Propose a change, the one gold action, opens the pull request that changes
// its words.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RecordDetail } from "@/data/contracts/steering";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { CloneButton } from "@/ui/clone-button";
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

/** One named property: the name above, the value below. */
function Property({ name, children }: { name: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="text-[11.5px] text-muted-foreground">{name}</dt>
      <dd className="flex min-h-6 items-center">{children}</dd>
    </div>
  );
}

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
  const label = record.label ?? record.title;
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
          <div className="min-w-0">
            <h1 className="min-w-0 max-w-[62ch] text-lg font-semibold leading-[1.35] text-foreground md:text-[21px]">
              {label}
            </h1>
            <p
              data-testid="record-slug"
              title={t("slugTitle")}
              className={`${mono} mt-0.5 break-all text-[12.5px] text-muted-foreground`}
            >
              {record.lineage}
            </p>
          </div>
        </div>
        <dl
          data-testid="record-chips"
          className="mt-3 flex flex-wrap items-start gap-x-5 gap-y-2.5"
        >
          <Property name={t("props.kind")}>
            {record.kind === null ? (
              <Badge tone="quiet" dot={false} data-term="kind">
                {term("unclassified")}
              </Badge>
            ) : (
              <KindBadge kind={record.kind} />
            )}
          </Property>
          <Property name={t("props.force")}>
            {record.force === null ? (
              <span
                data-state="not-recorded"
                className="text-[13px] text-muted-foreground"
              >
                {t("notRecorded")}
              </span>
            ) : (
              <span title={t("forceTitle")}>
                <Badge tone="quiet" dot={false} data-term="force">
                  {record.force}
                </Badge>
              </span>
            )}
          </Property>
          {record.constraintEffect === null ? null : (
            <Property name={t("props.effect")}>
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
            </Property>
          )}
          <Property name={t("props.scope")}>
            <Badge tone="quiet" dot={false} data-term="scope">
              {term(`scopes.${record.sharingScope}`)}
            </Badge>
          </Property>
          <Property name={t("props.status")}>
            {archived ? (
              <Badge tone="quiet" dot={false} data-term="status">
                {t("archived")}
              </Badge>
            ) : (
              <Badge tone="allowed" data-term="status">
                {t("published")}
              </Badge>
            )}
          </Property>
          {record.version === null ? null : (
            <Property name={t("props.version")}>
              <span data-term="version" className={`${mono} text-[13px]`}>
                {t("versionValue", { version: record.version })}
              </span>
            </Property>
          )}
          {pendingBranch === null ? null : (
            <Property name={t("props.pending")}>
              <Badge tone="approval" data-term="pending">
                <span className={mono}>{pendingBranch}</span>
              </Badge>
            </Property>
          )}
        </dl>
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
        <CloneButton kind="record" sourceRef={record.lineage} />
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
