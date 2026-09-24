// Who decided a governed call, and when, inside the detail of the approval
// frame that records it (`list_resolved_approvals`, #3153). The receipt
// `autoPath` writes for a call a decision rule released with no person is read
// back here too, and it names the rule rather than a person.
//
// The approval row carries no seq, so the frame it belongs to is the one
// `matchApprovals` pairs it with. An approval frame the record ties to no
// decision says so, and lists the run's decisions no frame on the page
// records, so a decision is never out of reach of the frames it concerns.
import { useTranslations } from "next-intl";
import type { ResolvedApprovalItem } from "@/data/contracts/approvals";
import type { Read } from "@/data/read";
import { Badge, type BadgeTone } from "@/ui/badge";
import {
  eyebrowQuiet,
  kvList,
  kvTerm,
  kvValue,
  mono,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { ReadFailure } from "@/ui/read-failure";

const TONE: Record<ResolvedApprovalItem["resolution"], BadgeTone> = {
  approved: "allowed",
  denied: "denied",
  expired: "quiet",
};

/** `user:<usr_…>` or `policy:<rule id>`, as the reader reads it. */
function DecidedBy({ item }: { item: ResolvedApprovalItem }) {
  const t = useTranslations("run.resolvedApprovals.by");
  const { resolvedBy, resolution } = item;
  let text: string;
  if (resolvedBy === null)
    text = resolution === "expired" ? t("system") : t("notRecorded");
  else if (resolvedBy.startsWith("policy:"))
    text = t("rule", { rule: resolvedBy.slice("policy:".length) });
  else if (resolvedBy.startsWith("user:"))
    text = resolvedBy.slice("user:".length);
  else text = resolvedBy;
  return (
    <dd data-testid="resolved-approver" className={`${kvValue} ${mono}`}>
      {text}
    </dd>
  );
}

function DecidedRow({ item }: { item: ResolvedApprovalItem }) {
  const t = useTranslations("run.resolvedApprovals");
  const format = useFormatter();
  return (
    <li
      data-testid="resolved-approval"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className="flex flex-wrap items-center gap-2">
        <span className={`${mono} break-all font-semibold`}>{item.tool}</span>
        <Badge tone={TONE[item.resolution]}>
          {t(`resolution.${item.resolution}`)}
        </Badge>
      </p>
      <dl className={kvList}>
        <dt className={kvTerm}>{t("resolvedBy")}</dt>
        <DecidedBy item={item} />
        <dt className={kvTerm}>{t("resolvedAt")}</dt>
        <dd className={kvValue}>
          <time dateTime={item.resolvedAt}>
            {format.dateTime(new Date(item.resolvedAt), {
              dateStyle: "medium",
              timeStyle: "medium",
            })}
          </time>
        </dd>
        {item.execution === undefined ? null : (
          <>
            <dt className={kvTerm}>{t("execution")}</dt>
            <dd data-testid="approval-execution" className={kvValue}>
              {item.execution.status}
            </dd>
            {item.execution.reason === null ? null : (
              <>
                <dt className={kvTerm}>{t("reason")}</dt>
                <dd className={kvValue}>{item.execution.reason}</dd>
              </>
            )}
            {item.execution.runId === null ? null : (
              <>
                <dt className={kvTerm}>{t("resumedRun")}</dt>
                <dd className={`${kvValue} ${mono}`}>{item.execution.runId}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </li>
  );
}

/**
 * The decision an approval frame records, or, when the record ties none to
 * it, the run's decisions that no frame on the page records.
 */
export function DecidedApprovals({
  read,
  here,
  others,
}: {
  /** `list_resolved_approvals` for the run, for its failure. */
  read: Read<ResolvedApprovalItem[]>;
  here: ResolvedApprovalItem | null;
  others: readonly ResolvedApprovalItem[];
}) {
  const t = useTranslations("run.resolvedApprovals");
  if (!read.ok) return <ReadFailure read={read} section={t("title")} />;
  if (here !== null)
    return (
      <ul className="m-0 grid list-none gap-3 p-0">
        <DecidedRow item={here} />
      </ul>
    );
  return (
    <div className="flex flex-col gap-2">
      <p
        data-testid="approval-unmatched"
        className="text-[12.5px] text-muted-foreground"
      >
        {t("noMatch")}
      </p>
      {others.length === 0 ? null : (
        <>
          <p className={eyebrowQuiet}>{t("others")}</p>
          <ul className="m-0 grid list-none gap-3 p-0">
            {others.map((item) => (
              <DecidedRow key={item.id} item={item} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
