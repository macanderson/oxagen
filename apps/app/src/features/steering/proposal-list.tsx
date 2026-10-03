// The Proposals list (#5077): one row per proposal in the state the filter
// names, newest first. The whole row is a link to the proposal's steering PR
// page: the lineage is a real anchor stretched over the row (the Runtimes
// table's pattern), so a click anywhere on the row, a cmd/ctrl-click, a
// middle-click and Enter on the focused link all behave as a link does. The
// link out to the pull request on the host sits above the stretched anchor,
// so following it never opens the steering PR page.
import { useLocale, useTranslations } from "next-intl";
import {
  type Proposal,
  type ProposalPage,
  type ProposalState,
  STEERING_PAGE,
} from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { routes } from "@/shared/safe-path";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { PullRequestLink, SafeLink } from "@/ui/navigation";
import { cell, Table } from "@/ui/table";
import { SteeringReadFailure } from "./read-failure";
import { Pager, Section, useDate } from "./section";
import { ProposalStatusBadge } from "./status";
import { type SteeringAt, steeringLink } from "./view";

/** A cell that sits above the row's stretched link, so its own control takes the click. */
const lifted = `${cell} relative z-[1]`;

function PullRequestCell({ pr }: { pr: Proposal["pr"] }) {
  const t = useTranslations("steering.proposals.list");
  if (pr === null) {
    return <span className="text-muted-foreground">{t("noPr")}</span>;
  }
  const label = t("number", {
    number: String(pr.number),
    repository: pr.repository,
  });
  const url = parsePullRequestUrl(pr.url);
  if (url === null) return <span className={mono}>{label}</span>;
  return (
    <PullRequestLink
      to={url}
      data-testid="proposal-pr-link"
      data-touch-target=""
      aria-label={
        pr.provider === "gitlab"
          ? t("openOnGitLab", { pr: label })
          : t("openOnGitHub", { pr: label })
      }
      className={`${linkText} whitespace-nowrap font-mono text-xs`}
    >
      {label}
    </PullRequestLink>
  );
}

function ProposalRow({
  at,
  state,
  offset,
  rows,
  proposal,
}: {
  at: SteeringAt;
  state: ProposalState;
  offset: number;
  rows: number;
  proposal: Proposal;
}) {
  const t = useTranslations("steering.proposals.list");
  const record = useTranslations("ui.record");
  const locale = useLocale();
  const date = useDate();
  const to = routes.steeringProposal(at.org, at.ws, proposal.id, {
    state: state === "open" ? undefined : state,
    rows: rows === STEERING_PAGE ? undefined : String(rows),
    offset: offset === 0 ? undefined : String(offset),
  });
  return (
    <tr
      data-proposal={proposal.id}
      data-testid="proposal-row"
      className="relative cursor-pointer"
    >
      <td className={cell}>
        <SafeLink
          to={to}
          aria-label={t("open", { lineage: proposal.lineage })}
          data-touch-target=""
          className={`${mono} inline-flex max-w-full items-center rounded-sm text-sm font-medium text-foreground after:absolute after:inset-0 after:content-[''] focus-visible:outline-2 focus-visible:outline-ring`}
        >
          <span className="min-w-0 md:truncate">{proposal.lineage}</span>
        </SafeLink>
        <div className="max-w-prose text-sm text-muted-foreground md:truncate">
          {proposal.statement}
        </div>
      </td>
      <td className={cell}>{record(`kinds.${proposal.kind}`)}</td>
      <td className={lifted}>
        <PullRequestCell pr={proposal.pr} />
      </td>
      <td className={`${cell} whitespace-nowrap text-sm`}>
        {proposal.checks === null
          ? t("checksNotRun")
          : t("checks", {
              passed: formatCount(proposal.checks.passed, locale),
              total: formatCount(proposal.checks.total, locale),
            })}
      </td>
      <td className={cell}>
        <ProposalStatusBadge status={proposal.status} />
      </td>
      <td className={`${cell} whitespace-nowrap text-sm text-muted-foreground`}>
        {date(proposal.updatedAt)}
      </td>
    </tr>
  );
}

export function ProposalList({
  at,
  state,
  offset,
  rows,
  read,
}: {
  at: SteeringAt;
  state: ProposalState;
  offset: number;
  /** How many proposals a page holds, one of PROPOSAL_ROWS. */
  rows: number;
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
      <Section id="steering-proposals" title={t(`empty.${state}.title`)}>
        <p data-state="empty" className="max-w-prose text-base text-foreground">
          {t(`empty.${state}.body`)}
        </p>
      </Section>
    );
  }
  return (
    <Section id="steering-proposals" title={title} lead={t("lead")}>
      <Table
        label={title}
        columns={[
          { label: t("list.columns.proposal") },
          { label: t("list.columns.kind") },
          { label: t("list.columns.pr") },
          { label: t("list.columns.checks") },
          { label: t("list.columns.state") },
          { label: t("list.columns.updated") },
        ]}
      >
        {proposals.map((proposal) => (
          <ProposalRow
            key={proposal.id}
            at={at}
            state={state}
            offset={offset}
            rows={rows}
            proposal={proposal}
          />
        ))}
      </Table>
      <Pager
        offset={offset}
        rows={rows}
        shown={proposals.length}
        total={total}
        link={(to) => steeringLink(at, { tab: "proposals", state, ...to })}
      />
    </Section>
  );
}
