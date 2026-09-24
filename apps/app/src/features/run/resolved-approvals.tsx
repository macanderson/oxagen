// What has already been decided for this run, from `list_resolved_approvals`
// (#3153), on the Policy tab below the run's policy decisions. The pending
// half lives in the shell's approvals drawer, which an Outputs gate row opens
// with Review. This is the receipt `autoApprovePath` writes for a call a
// decision rule released with no person, read back.
import { useTranslations } from "next-intl";
import type { ResolvedApprovalItem } from "@/data/contracts/approvals";
import type { Read } from "@/data/read";
import { mono, panel } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { ReadFailure } from "@/ui/read-failure";

function approverLabel({
  resolvedBy,
  resolution,
}: ResolvedApprovalItem): string {
  if (resolvedBy === null && resolution === "expired") return "system";
  if (resolvedBy === null) return "unknown";
  if (resolvedBy.startsWith("policy:")) {
    return `rule ${resolvedBy.slice("policy:".length)} (no person looked)`;
  }
  return resolvedBy;
}

function ResolvedApprovalRow({ item }: { item: ResolvedApprovalItem }) {
  const t = useTranslations("run.resolvedApprovals");
  const format = useFormatter();
  return (
    <li
      data-testid="resolved-approval"
      className="flex min-w-0 flex-col gap-1 rounded-lg border border-border p-3"
    >
      <p className={`${mono} break-all font-semibold`}>{item.tool}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("resolution")}</dt>
        <dd>{item.resolution}</dd>
        <dt className="text-muted-foreground">{t("resolvedBy")}</dt>
        <dd data-testid="resolved-approver" className={`${mono} break-all`}>
          {approverLabel(item)}
        </dd>
        <dt className="text-muted-foreground">{t("resolvedAt")}</dt>
        <dd>
          <time dateTime={item.resolvedAt}>
            {format.dateTime(new Date(item.resolvedAt), {
              dateStyle: "medium",
              timeStyle: "short",
            })}
          </time>
        </dd>
        {item.execution && (
          <>
            <dt className="text-muted-foreground">{t("execution")}</dt>
            <dd data-testid="approval-execution">{item.execution.status}</dd>
            {item.execution.reason && (
              <>
                <dt>{t("reason")}</dt>
                <dd>{item.execution.reason}</dd>
              </>
            )}
            {item.execution.runId && (
              <>
                <dt>{t("resumedRun")}</dt>
                <dd className={`${mono} break-all`}>{item.execution.runId}</dd>
              </>
            )}
          </>
        )}
      </dl>
    </li>
  );
}

export function ResolvedApprovalsPanel({
  approvals,
}: {
  approvals: Read<ResolvedApprovalItem[]>;
}) {
  const t = useTranslations("run.resolvedApprovals");
  return (
    <section
      aria-labelledby="run-resolved-approvals"
      className={`${panel} p-4`}
    >
      <div className="pb-3">
        <h2 id="run-resolved-approvals" className="text-base font-semibold">
          {t("title")}
        </h2>
      </div>
      {!approvals.ok ? (
        <ReadFailure read={approvals} section={t("title")} />
      ) : approvals.value.length === 0 ? (
        <p className="text-sm">{t("empty")}</p>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {approvals.value.map((item) => (
            <ResolvedApprovalRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
