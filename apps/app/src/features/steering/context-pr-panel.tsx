// The Context PR panel (#2961; spec §10.3; ADR-061): one proposal's pull
// request as the state machine proposed → pull request open → checks running →
// checks passed or failed → merged, the six checks in the order they run, the
// pull request body, what merge will do, and the merge itself, which stays
// disabled until every check has passed. Merge is the publication.
import { useLocale, useTranslations } from "next-intl";
import type { ContextPr, ProposalStatus } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { parsePullRequestUrl } from "@/shared/pull-request-url";
import { linkText, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { PullRequestLink } from "@/ui/navigation";
import { SteeringReadFailure } from "./read-failure";
import { Fact, Facts, Section, useDate } from "./section";
import { ProposalStatusBadge } from "./status";
import type { SteeringAt } from "./view";
import { MergeContextPr, ProposalWrites } from "./write-controls";

const STEPS = [
  "proposed",
  "pr_open",
  "checks_running",
  "checks_passed",
  "merged",
] as const satisfies readonly ProposalStatus[];

/** Where a status sits on the machine; a failed check run sits where a passed one would, and a dismissal sits nowhere. */
function stepIndex(status: ProposalStatus): number {
  switch (status) {
    case "proposed":
      return 0;
    case "pr_open":
      return 1;
    case "checks_running":
      return 2;
    case "checks_passed":
    case "checks_failed":
      return 3;
    case "merged":
      return 4;
    case "rejected":
      return -1;
  }
}

function StateMachine({ status }: { status: ProposalStatus }) {
  const t = useTranslations("steering");
  const current = stepIndex(status);
  return (
    <ol
      aria-label={t("pr.machine")}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs"
    >
      {STEPS.map((step, index) => {
        const shown =
          index === 3 && status === "checks_failed" ? "checks_failed" : step;
        return (
          <li
            key={step}
            data-step={shown}
            data-reached={index <= current ? "" : undefined}
            aria-current={index === current ? "step" : undefined}
            className="rounded-sm border border-dashed border-border px-1.5 py-0.5 text-muted-foreground data-[reached]:border-solid data-[reached]:text-foreground aria-[current=step]:border-double aria-[current=step]:border-foreground aria-[current=step]:font-medium"
          >
            {t(`status.${shown}`)}
          </li>
        );
      })}
    </ol>
  );
}

function Checks({ checks }: { checks: ContextPr["checks"] }) {
  const t = useTranslations("steering.pr.checks");
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-foreground">{t("title")}</h3>
      <ol className="flex flex-col divide-y divide-border text-sm">
        {checks.map((check) => (
          <li
            key={check.name}
            data-check={check.name}
            data-status={check.status}
            className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-2"
          >
            <span className="flex min-w-0 flex-col">
              <span className="text-foreground">
                {t(`names.${check.name}`)}
              </span>
              {check.summary === "" ? null : (
                <span className="text-xs text-muted-foreground">
                  {check.summary}
                </span>
              )}
            </span>
            <span className="text-xs font-medium text-foreground">
              {t(`statuses.${check.status}`)}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function ContextPrPanel({
  at,
  read,
}: {
  at: SteeringAt;
  read: Read<ContextPr>;
}) {
  const t = useTranslations("steering.pr");
  const locale = useLocale();
  const date = useDate();
  if (!read.ok) {
    const heading = t("heading");
    return (
      <Section id="steering-pr" title={heading}>
        <SteeringReadFailure read={read} section={heading} />
      </Section>
    );
  }
  const { value } = read;
  const { pr, merged, onMerge, governanceMode, status } = value;
  const url = pr === null ? null : parsePullRequestUrl(pr.url);
  const mode =
    governanceMode === null ? t("modeUnread") : t(`modes.${governanceMode}`);
  const open = status !== "merged" && status !== "rejected";
  return (
    <Section
      id="steering-pr"
      title={t("title", { lineage: value.lineage })}
      data-status={status}
    >
      <div className="flex flex-wrap items-center gap-3">
        <ProposalStatusBadge status={status} />
        {pr !== null && url !== null ? (
          <PullRequestLink to={url} className={linkText}>
            {t("goToPr", { number: String(pr.number) })}
          </PullRequestLink>
        ) : null}
      </div>
      <StateMachine status={status} />
      {status === "rejected" ? (
        <p className="text-sm text-foreground">{t("rejected")}</p>
      ) : null}
      {pr === null ? (
        <p className="text-sm text-muted-foreground">{t("notOpened")}</p>
      ) : null}
      <Facts>
        {pr === null ? null : (
          <>
            <Fact name="repository" term={t("facts.repository")}>
              <span className={mono}>{pr.repository}</span>
            </Fact>
            <Fact name="branch" term={t("facts.branch")}>
              <span className={mono}>
                {t("facts.branchInto", { branch: pr.branch, base: pr.baseRef })}
              </span>
            </Fact>
            <Fact name="head" term={t("facts.head")}>
              {pr.headSha === null ? (
                t("facts.headUnknown")
              ) : (
                <span className={mono}>{pr.headSha}</span>
              )}
            </Fact>
          </>
        )}
        <Fact name="path" term={t("facts.path")}>
          <span className={mono}>{onMerge.path}</span>
        </Fact>
        <Fact name="governance" term={t("facts.governance")}>
          {mode}
        </Fact>
      </Facts>
      {value.checks.length === 0 ? null : <Checks checks={value.checks} />}
      {value.body === null ? null : (
        <details className="text-sm">
          <summary className="cursor-pointer text-muted-foreground">
            {t("body")}
          </summary>
          <pre
            className={`${mono} mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-xs`}
          >
            {value.body}
          </pre>
        </details>
      )}
      {merged === null ? null : (
        <div data-merged="" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t("merged.title")}
          </h3>
          <Facts>
            <Fact name="commit" term={t("merged.commit")}>
              <span className={mono}>{merged.commit}</span>
            </Fact>
            <Fact name="merged-at" term={t("merged.at")}>
              {date(merged.at)}
            </Fact>
            <Fact name="promotion-event" term={t("merged.promotion")}>
              <span className={mono}>{merged.promotionEventId}</span>
            </Fact>
            <Fact name="record" term={t("merged.record")}>
              <span className={mono}>{merged.recordId}</span>
            </Fact>
          </Facts>
        </div>
      )}
      {open ? (
        <div data-on-merge="" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-foreground">
            {t("onMerge.title")}
          </h3>
          <ol className="flex list-decimal flex-col gap-1 ps-5 text-sm text-foreground">
            <li>{t("onMerge.publishes", { path: onMerge.path })}</li>
            <li>
              {t("onMerge.version", {
                current: formatCount(onMerge.bundleVersion.current, locale),
                next: formatCount(onMerge.bundleVersion.afterMerge, locale),
              })}
            </li>
            <li>{t("onMerge.promotion")}</li>
            <li>{t("onMerge.review", { review: mode })}</li>
          </ol>
        </div>
      ) : null}
      {open ? (
        <div className="flex flex-wrap items-start gap-3">
          <MergeContextPr
            org={at.org}
            ws={at.ws}
            proposalId={value.proposalId}
            blocked={status !== "checks_passed"}
          />
          <ProposalWrites
            org={at.org}
            ws={at.ws}
            proposalId={value.proposalId}
            status={status}
          />
        </div>
      ) : null}
    </Section>
  );
}
