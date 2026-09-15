// The approvals panel: one card per pending approval, soonest expiry first as
// list_approvals orders them. The decisions (approve, deny) arrive with the
// approval dialog; this panel reads.
import { useLocale, useTranslations } from "next-intl";
import type { ApprovalItem } from "@/data/contracts/approvals";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { linkText, mono, panel } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { Clock } from "./clock";
import { ReadFailure } from "./read-failure";

type Place = { org: string; ws: string };

function ApprovalCard({
  item,
  now,
  org,
  ws,
}: { item: ApprovalItem; now: number } & Place) {
  const t = useTranslations("fleet.approvals");
  const recorded = (value: string | null) =>
    value === null ? (
      <dd className="text-muted-foreground">{t("notRecorded")}</dd>
    ) : (
      <dd className={`${mono} break-all`}>{value}</dd>
    );
  return (
    <li
      data-testid="approval"
      className="flex min-w-0 flex-col gap-2 rounded-lg border border-border p-3"
    >
      <p className={`${mono} break-all font-semibold`}>{item.tool}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t("agent")}</dt>
        {recorded(item.agentKey)}
        <dt className="text-muted-foreground">{t("requester")}</dt>
        {recorded(item.requester)}
      </dl>
      <p className="text-xs">
        {t.rich("timesOut", {
          clock: () => (
            <Clock
              at={Date.parse(item.expiresAt)}
              now={now}
              direction="until"
            />
          ),
        })}
      </p>
      {item.runId === null ? null : (
        <SafeLink
          to={routes.run(org, ws, item.runId)}
          className={`${linkText} self-start text-xs`}
        >
          {t("openRun")}
        </SafeLink>
      )}
    </li>
  );
}

export function ApprovalsPanel({
  approvals,
  now,
  org,
  ws,
}: { approvals: Read<ApprovalItem[]>; now: number } & Place) {
  const t = useTranslations("fleet.approvals");
  const locale = useLocale();
  return (
    <section aria-labelledby="fleet-approvals" className={`${panel} p-4`}>
      <div className="flex items-center justify-between gap-3 pb-3">
        <h2 id="fleet-approvals" className="text-base font-semibold">
          {t("title")}
        </h2>
        {approvals.ok ? (
          <span className="text-xs text-muted-foreground">
            {t("parked", {
              count: formatCount(approvals.value.length, locale),
            })}
          </span>
        ) : null}
      </div>
      {!approvals.ok ? (
        <ReadFailure read={approvals} section={t("title")} />
      ) : approvals.value.length === 0 ? (
        <div className="flex flex-col gap-1 text-sm">
          <p>{t("empty")}</p>
          <p className="text-xs text-muted-foreground">{t("emptyDetail")}</p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {approvals.value.map((item) => (
            <ApprovalCard
              key={item.id}
              item={item}
              now={now}
              org={org}
              ws={ws}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
