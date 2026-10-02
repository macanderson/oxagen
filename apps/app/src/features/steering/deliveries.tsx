import { useLocale, useTranslations } from "next-intl";
import type { SteeringDeliveries } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { AgentAvatar } from "@/ui/agent-avatar";
import { formatCount } from "@/ui/money-format";
import { Table, cell, numericCell } from "@/ui/table";
import { SteeringReadFailure } from "./read-failure";
import { Section, useDate } from "./section";

export function Deliveries({ read }: { read: Read<SteeringDeliveries> }) {
  const t = useTranslations("steering.deliveries");
  const locale = useLocale();
  const date = useDate();
  if (!read.ok) return <SteeringReadFailure read={read} section={t("title")} />;
  const report = read.value;
  const count = (n: number) => formatCount(n, locale);
  const reason = (value: string) =>
    t(
      `reasons.${value === "budget" || value === "tier" || value === "superseded" ? value : "unknown"}`,
    );
  return (
    <Section
      id="steering-delivery"
      title={t("title")}
      lead={t("lead")}
      data-state={report.runs.length === 0 ? "empty" : "ready"}
    >
      {report.runs.length === 0 ? (
        <p>{t("empty")}</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {t("sample", { count: report.scanned, shown: report.runs.length })}
          </p>
          {report.truncated ? <p role="status">{t("truncated")}</p> : null}
          <Table
            label={t("title")}
            columns={[
              { label: t("run") },
              { label: t("included"), numeric: true },
              { label: t("cut"), numeric: true },
              { label: t("budgetCuts"), numeric: true },
              { label: t("tokens"), numeric: true },
            ]}
          >
            {report.runs.map((run) => (
              <tr key={run.sessionUuid}>
                <td className={cell}>
                  <div className="flex min-w-0 items-center gap-2.5">
                    <AgentAvatar
                      value={null}
                      initials={(run.agentKey.split(".").at(-1) ?? "")
                        .slice(0, 2)
                        .toUpperCase()}
                      harness={run.harness}
                    />
                    <div className="min-w-0">
                      <div className="md:truncate">{run.agentKey}</div>
                      <div className="text-xs text-muted-foreground md:truncate">
                        {run.harness} · {date(run.ts.replace(" ", "T") + "Z")}
                      </div>
                    </div>
                  </div>
                  <details>
                    <summary className="cursor-pointer">{t("run")}</summary>
                    <code className="block select-all md:truncate">
                      {run.sessionUuid}
                    </code>
                  </details>
                </td>
                <td className={numericCell}>{count(run.recordsIncluded)}</td>
                <td className={numericCell}>{count(run.recordsCut)}</td>
                <td className={numericCell}>
                  {count(run.recordsCutForBudget)}
                </td>
                <td className={numericCell}>
                  {count(run.spentTokens)} / {count(run.budgetTokens)}
                </td>
              </tr>
            ))}
          </Table>
          <h3 className="text-sm font-semibold">{t("unreached")}</h3>
          <p className="text-sm text-muted-foreground">{t("unreachedLead")}</p>
          {report.undelivered.length === 0 ? (
            <p>{t("noUnreached")}</p>
          ) : (
            <Table
              label={t("unreached")}
              columns={[
                { label: t("record") },
                { label: t("runs"), numeric: true },
                { label: t("reason") },
              ]}
            >
              {report.undelivered.map((record) => (
                <tr key={record.recordRef}>
                  <td className={cell}>{record.recordRef}</td>
                  <td className={numericCell}>{count(record.runs)}</td>
                  <td className={cell}>{reason(record.lastReason)}</td>
                </tr>
              ))}
            </Table>
          )}
        </>
      )}
    </Section>
  );
}
