"use client";
// The Changes tab (mockup `chgTab()`): every pull request Oxagen has open or
// merged on this workspace's repositories. Today every row is a context
// record's Context PR, read through `list_proposals`: the other kinds the
// mockup names (Oxagen init, skill, agent, tool, configuration) have no list
// read yet, and the tab says so rather than drawing rows it would have to
// invent. A row opens that pull request's Context PR panel on the Steering
// page, which carries its checks with each one's own result, what merge will
// do, and the merge and close controls.
import { useTranslations } from "next-intl";
import type { RepositoryChanges } from "@/data/contracts/repository";
import { parseGitHubUrl } from "@/shared/github-url";
import { routes } from "@/shared/safe-path";
import { linkText } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { GitHubLink, SafeLink } from "@/ui/navigation";
import { cell, numericCell, Table } from "@/ui/table";
import { FormAlert } from "@/ui/form-feedback";
import { useRepositoriesFailure } from "./failure";
import { Dot, Explainer, type Load, prose, type Tone } from "./parts";

type Status = RepositoryChanges["changes"][number]["status"];

const STATUS_TONE: Record<Status, Tone> = {
  pr_open: "idle",
  checks_running: "idle",
  checks_passed: "ok",
  checks_failed: "bad",
  merged: "ok",
  rejected: "idle",
};

export function Changes({
  org,
  ws,
  changes,
}: {
  org: string;
  ws: string;
  changes: Load<RepositoryChanges>;
}) {
  const t = useTranslations("repositories.changes");
  const failureText = useRepositoriesFailure();
  const format = useFormatter();
  return (
    <div data-testid="changes" className="flex flex-col gap-4">
      {changes.kind === "loading" ? (
        <p role="status" data-testid="changes-loading" className={prose}>
          {t("loading")}
        </p>
      ) : changes.kind === "failed" ? (
        <FormAlert testId="changes-failure">
          {failureText(changes.failure)}
        </FormAlert>
      ) : changes.value.changes.length === 0 ? (
        <p data-testid="changes-empty" className={prose}>
          {t("empty")}
        </p>
      ) : (
        <Table
          label={t("label")}
          columns={[
            { label: t("columns.change") },
            { label: t("columns.kind") },
            { label: t("columns.pullRequest") },
            { label: t("columns.openedBy") },
            { label: t("columns.state") },
            { label: t("columns.checks"), numeric: true },
            { label: t("columns.opened") },
          ]}
        >
          {changes.value.changes.map((change) => {
            const href = parseGitHubUrl(change.pullRequest.url);
            const label = `${change.pullRequest.repository}#${String(change.pullRequest.number)}`;
            return (
              <tr key={change.proposalId} data-change={change.proposalId}>
                <td className={cell}>
                  <SafeLink
                    to={routes.steering(org, ws, {
                      tab: "prs",
                      proposal: change.proposalId,
                    })}
                    data-testid={`change-open-${change.proposalId}`}
                    className={linkText}
                  >
                    {change.statement}
                  </SafeLink>
                </td>
                <td className={cell}>{t(`kinds.${change.kind}`)}</td>
                <td className={`${cell} font-mono text-xs`}>
                  {href === null ? (
                    label
                  ) : (
                    <GitHubLink to={href} className={linkText}>
                      {label}
                    </GitHubLink>
                  )}
                </td>
                <td className={`${cell} text-xs`}>{change.openedBy}</td>
                <td className={cell}>
                  <Dot tone={STATUS_TONE[change.status]}>
                    {t(`states.${change.status}`)}
                  </Dot>
                </td>
                <td className={numericCell}>
                  {change.checks === null
                    ? t("checksPending")
                    : `${String(change.checks.passed)}/${String(change.checks.total)}`}
                </td>
                <td className={`${cell} text-xs`}>
                  <time dateTime={change.openedAt}>
                    {format.dateTime(new Date(change.openedAt), {
                      dateStyle: "medium",
                    })}
                  </time>
                </td>
              </tr>
            );
          })}
        </Table>
      )}
      <p data-testid="changes-other-kinds" className={prose}>
        {t("otherKinds")}
      </p>
      <Explainer title={t("whoOpens.title")} testId="changes-who-opens">
        <p>{t("whoOpens.promoter")}</p>
        <p>{t("whoOpens.reconciler")}</p>
        <p>{t("whoOpens.person")}</p>
        <p>{t("whoOpens.drift")}</p>
      </Explainer>
    </div>
  );
}
