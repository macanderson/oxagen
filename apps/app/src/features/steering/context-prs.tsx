// Context PRs (#2961; spec §10.3): the proposals on this page that have a pull
// request, as a table, and the one the URL selects as the Context PR panel.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { ContextPr, ProposalPage } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { linkText, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { cell, Table } from "@/ui/table";
import { ContextPrPanel } from "./context-pr-panel";
import { SteeringReadFailure } from "./read-failure";
import { Pager, Section } from "./section";
import { ProposalStatusBadge } from "./status";
import { type SteeringAt, steeringLink } from "./view";

export function ContextPrs({
  at,
  offset,
  read,
  selected,
  pr,
}: {
  at: SteeringAt;
  offset: number;
  read: Read<ProposalPage>;
  /** The proposal the URL selects; null shows the table alone. */
  selected: string | null;
  /** get_context_pr for `selected`; null when nothing is selected. */
  pr: Read<ContextPr> | null;
}) {
  const t = useTranslations("steering.prs");
  const record = useTranslations("ui.record");
  const title = t("title");
  let body: ReactNode;
  if (!read.ok) {
    body = <SteeringReadFailure read={read} section={title} />;
  } else {
    const rows = read.value.proposals.flatMap((proposal) =>
      proposal.pr === null ? [] : [{ proposal, pr: proposal.pr }],
    );
    body = (
      <>
        {rows.length === 0 ? (
          <p data-state="empty" className="text-sm text-muted-foreground">
            {t("empty")}
          </p>
        ) : (
          <Table
            label={title}
            columns={[
              { label: t("columns.pr") },
              { label: t("columns.branch") },
              { label: t("columns.kind") },
              { label: t("columns.state") },
            ]}
          >
            {rows.map(({ proposal, pr: row }) => (
              <tr key={proposal.id} data-proposal={proposal.id}>
                <td className={cell}>
                  <SafeLink
                    to={steeringLink(at, {
                      tab: "prs",
                      offset,
                      proposal: proposal.id,
                    })}
                    aria-current={proposal.id === selected ? "true" : undefined}
                    className={linkText}
                  >
                    {t("number", {
                      number: String(row.number),
                      repository: row.repository,
                    })}
                  </SafeLink>
                  <div className={`${mono} text-xs text-muted-foreground`}>
                    {proposal.lineage}
                  </div>
                </td>
                <td className={`${cell} ${mono} text-xs break-all`}>
                  {row.branch}
                </td>
                <td className={cell}>{record(`kinds.${proposal.kind}`)}</td>
                <td className={cell}>
                  <ProposalStatusBadge status={proposal.status} />
                </td>
              </tr>
            ))}
          </Table>
        )}
        <Pager
          offset={offset}
          shown={read.value.proposals.length}
          total={read.value.total}
          link={(to) => steeringLink(at, { tab: "prs", offset: to })}
        />
      </>
    );
  }
  return (
    <>
      <Section id="steering-prs" title={title} lead={t("lead")}>
        {body}
      </Section>
      {pr === null ? null : <ContextPrPanel at={at} read={pr} />}
    </>
  );
}
