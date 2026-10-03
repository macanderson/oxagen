// Work setup › Priorities (roadmap mockups/src/work-setup.js `prioritiesTab()`;
// mockups/pages/work-setup.md): the priorities record triage ranks the inbox
// by, read with get_work_priorities. It shows the record's lineage and
// version, its rules numbered as triage cites them, when it was published,
// and what triage did with it in the last 30 days.
//
// The record lives in the steering repo, so Edit priorities opens the
// record's own page, which carries the steering review flow. Triage uses a
// new version for the items it reads after that change merges. With no
// record in place the tab says why, in the server's words, and offers the
// editor that writes one (priorities-editor.tsx). With more than one record
// in place it offers no editor, because a third record would not help: the
// person retires all but one.
import { useLocale, useTranslations } from "next-intl";
import type { WorkPriorities } from "@/data/contracts/work";
import type { Read } from "@/data/read";
import { routes } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import {
  buttonPrimary,
  eyebrowQuiet,
  kvList,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { SafeLink } from "@/ui/navigation";
import { StateWrap } from "@/ui/state-wrap";
import { WorkReadFailure } from "../read-failure";
import { PrioritiesEditor } from "./priorities-editor";

/**
 * How get_work_priorities opens its problem when two records match
 * (packages/handlers/src/lib/work-intake/priorities.ts, prioritiesProblem).
 */
const AMBIGUOUS = "This workspace has more than one priorities record";

function TriagePanel({ last30Days }: { last30Days: WorkPriorities["last30Days"] }) {
  const t = useTranslations("work.setup.priorities");
  const locale = useLocale();
  return (
    <section
      aria-labelledby="work-triage-title"
      data-testid="work-priorities-triage"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="work-triage-title" className={panelTitle}>
          {t("triageTitle")}
        </h2>
        <span className="text-sm text-muted-foreground">
          {t("triageCaption")}
        </span>
      </div>
      <dl className={`${panelBody} ${kvList}`}>
        <dt className={kvTerm}>{t("suggestions")}</dt>
        <dd className={kvValue} data-figure="suggestions">
          {formatCount(last30Days.suggestions, locale)}
        </dd>
        <dt className={kvTerm}>{t("failures")}</dt>
        <dd className={kvValue} data-figure="failures">
          {formatCount(last30Days.failures, locale)}
        </dd>
        <dt className={kvTerm}>{t("corrections")}</dt>
        <dd className={kvValue} data-figure="corrections">
          {formatCount(last30Days.corrections, locale)}
        </dd>
      </dl>
    </section>
  );
}

export function PrioritiesTab({
  org,
  ws,
  read,
}: {
  org: string;
  ws: string;
  read: Read<WorkPriorities>;
}) {
  const t = useTranslations("work.setup");
  const page = useTranslations("work.page");
  const format = useFormatter();
  if (!read.ok)
    return (
      <WorkReadFailure
        read={read}
        page={t("tabs.priorities")}
        retry={routes.workSetup(org, ws, "priorities")}
      />
    );
  const { record, problem, last30Days } = read.value;
  if (record === null)
    return (
      <div className="flex flex-col gap-4">
        <StateWrap
          tone="neutral"
          testId="work-priorities-none"
          title={t("priorities.noneTitle")}
          after={
            problem === null ? undefined : (
              <p
                data-testid="work-priorities-problem"
                className="mx-auto max-w-[52ch] text-base text-muted-foreground [overflow-wrap:anywhere]"
              >
                {problem}
              </p>
            )
          }
        >
          {page("descriptionNoRecord")}
        </StateWrap>
        {problem?.startsWith(AMBIGUOUS) === true ? null : (
          <PrioritiesEditor org={org} ws={ws} />
        )}
        <TriagePanel last30Days={last30Days} />
      </div>
    );
  const rules = [...record.rules].sort((a, b) => a.number - b.number);
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <section
        aria-labelledby="work-priorities-title"
        data-testid="work-priorities-record"
        data-lineage={record.lineage}
        data-version={String(record.version)}
        className={panel}
      >
        <div className={panelHeader}>
          <div className="flex min-w-0 flex-col gap-1">
            <p className={eyebrowQuiet}>{t("priorities.record")}</p>
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="work-priorities-title"
                className={`${panelTitle} ${mono} break-all`}
              >
                {record.lineage}
              </h2>
              <Badge tone="quiet" dot={false}>
                {t("priorities.version", { version: String(record.version) })}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              {record.publishedAt === null
                ? t("priorities.unpublished")
                : t("priorities.published", {
                    at: format.dateTime(new Date(record.publishedAt), {
                      year: "numeric",
                      month: "short",
                      day: "numeric",
                    }),
                  })}
            </p>
          </div>
          <SafeLink
            to={routes.steeringRecord(org, ws, record.lineage)}
            data-testid="work-priorities-edit"
            className={buttonPrimary}
          >
            {t("priorities.edit")}
          </SafeLink>
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          <h3 className={eyebrowQuiet}>{t("priorities.rulesTitle")}</h3>
          {rules.length === 0 ? (
            <p className="text-base text-muted-foreground">
              {t("priorities.noRules")}
            </p>
          ) : (
            <ol
              data-testid="work-priorities-rules"
              className="flex flex-col gap-2 text-base"
            >
              {rules.map((rule) => (
                <li
                  key={rule.number}
                  data-rule={String(rule.number)}
                  className="flex gap-3"
                >
                  <span className={`${mono} flex-none text-dim`}>
                    {t("priorities.rule", { number: String(rule.number) })}
                  </span>
                  <span className="min-w-0 [overflow-wrap:anywhere]">
                    {rule.text}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </section>
      <TriagePanel last30Days={last30Days} />
    </div>
  );
}
