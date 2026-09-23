// Proposals (#2961; spec §9.2): candidates that steer nothing, each with the
// support it cites for a person to weigh (ADR-061 decision 2: no promotion
// thresholds), its place in the Context PR state machine, and the writes a
// person makes on it: open or re-run its Context PR, or dismiss it.
import { useLocale, useTranslations } from "next-intl";
import type { Proposal, ProposalPage } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { RecordCard } from "@/ui/record-card";
import { SteeringReadFailure } from "./read-failure";
import { Pager, Section } from "./section";
import { ProposalStatusBadge } from "./status";
import { type SteeringAt, steeringLink } from "./view";
import { ProposalWrites } from "./write-controls";

function SupportList({ term, items }: { term: string; items: string[] }) {
  const t = useTranslations("steering.proposals");
  return (
    <div className="flex flex-col gap-1">
      <p className="text-xs font-medium text-muted-foreground">{term}</p>
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t("none")}</p>
      ) : (
        <ul className={`${mono} flex flex-col gap-0.5 text-xs break-all`}>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProposalItem({
  at,
  proposal,
}: {
  at: SteeringAt;
  proposal: Proposal;
}) {
  const t = useTranslations("steering.proposals");
  const locale = useLocale();
  const { support, pr, checks } = proposal;
  return (
    <RecordCard
      kind={proposal.kind}
      force={proposal.force}
      constraintEffect={proposal.constraintEffect}
      sharingScope={proposal.sharingScope}
      lineage={proposal.lineage}
      statement={proposal.statement}
      badge={
        <>
          <ProposalStatusBadge status={proposal.status} />
          {checks === null ? null : (
            <span data-checks="" className="text-xs text-muted-foreground">
              {t("checks", {
                passed: formatCount(checks.passed, locale),
                total: formatCount(checks.total, locale),
              })}
            </span>
          )}
        </>
      }
    >
      <p className="text-xs text-muted-foreground">
        {t("source", { source: proposal.source })}
      </p>
      <p className="max-w-prose text-sm text-foreground">
        {proposal.rationale}
      </p>
      <details className="text-sm">
        <summary className="cursor-pointer text-muted-foreground">
          {t("support", {
            runs: formatCount(support.runs.length, locale),
            agents: formatCount(support.agents.length, locale),
            records: formatCount(support.recordIds.length, locale),
            evidence: formatCount(support.evidenceLinks.length, locale),
          })}
        </summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-2">
          <SupportList term={t("runs")} items={support.runs} />
          <SupportList term={t("agents")} items={support.agents} />
          <SupportList term={t("records")} items={support.recordIds} />
          <SupportList term={t("evidence")} items={support.evidenceLinks} />
        </div>
      </details>
      <div className="flex flex-wrap items-center gap-3">
        {pr === null ? null : (
          <SafeLink
            to={steeringLink(at, { tab: "prs", proposal: proposal.id })}
            className={linkText}
          >
            {t("viewPr", { number: String(pr.number) })}
          </SafeLink>
        )}
        <ProposalWrites
          org={at.org}
          ws={at.ws}
          proposalId={proposal.id}
          status={proposal.status}
        />
      </div>
    </RecordCard>
  );
}

export function Proposals({
  at,
  offset,
  read,
}: {
  at: SteeringAt;
  offset: number;
  read: Read<ProposalPage>;
}) {
  const t = useTranslations("steering.proposals");
  const title = t("title");
  if (!read.ok) {
    return (
      <Section id="steering-proposals" title={title}>
        <SteeringReadFailure read={read} section={title} />
      </Section>
    );
  }
  const { proposals, total } = read.value;
  if (total === 0 && offset === 0) {
    return (
      <Section id="steering-proposals" title={t("emptyTitle")}>
        <p data-state="empty" className="max-w-prose text-sm text-foreground">
          {t("empty")}
        </p>
      </Section>
    );
  }
  return (
    <Section id="steering-proposals" title={title} lead={t("lead")}>
      <ul className="flex flex-col gap-3">
        {proposals.map((proposal) => (
          <li key={proposal.id}>
            <ProposalItem at={at} proposal={proposal} />
          </li>
        ))}
      </ul>
      <Pager
        offset={offset}
        shown={proposals.length}
        total={total}
        link={(to) => steeringLink(at, { tab: "proposals", offset: to })}
      />
    </Section>
  );
}
