// Where the record lives and who put it there (#3395; mockups/pages/record.md,
// the Lineage panel). Provenance is the publishing commit, read out of git,
// not a column somebody could set. A record whose file the page read but
// whose commit history it could not reach says so rather than inventing an
// author or a date.
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RecordDetail } from "@/data/contracts/steering";
import {
  mono,
  panel,
  panelBody,
  panelHeader,
  panelTitle,
} from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { formatCount } from "@/ui/money-format";
import { RECORD_GAPS } from "./gaps";

/** The protocol every `.oxagen/rules/*.toml` file declares. */
const SCHEMA = "context-record/v0.1";

const code = (chunks: ReactNode) => <span className={mono}>{chunks}</span>;

export function LineagePanel({
  detail,
  repository,
}: {
  detail: RecordDetail;
  /** The workspace's main repository, `owner/name`; null when unread or unbound. */
  repository: string | null;
}) {
  const t = useTranslations("record.lineage");
  const format = useFormatter();
  const locale = useLocale();
  const { record, provenance, effect } = detail;
  const path = record.path ?? `.oxagen/rules/${record.lineage}.toml`;
  const commit = provenance?.commit ?? record.commit;
  const date = provenance?.committedAt ?? record.publishedAt;
  return (
    <section
      aria-labelledby="record-lineage"
      data-testid="record-lineage"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="record-lineage" className={panelTitle}>
          {t("title")}
        </h2>
        <span className="font-mono text-[11px] text-dim">{t("badge")}</span>
      </div>
      <dl
        className={`${panelBody} grid grid-cols-[max-content_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px] [&>dd]:min-w-0 [&>dd]:break-words [&>dd]:text-foreground [&>dt]:text-muted-foreground`}
      >
        <dt>{t("lineage")}</dt>
        <dd data-fact="lineage" className={mono}>
          {record.lineage}
        </dd>
        <dt>{t("file")}</dt>
        <dd data-fact="file">
          {repository === null
            ? t.rich("fileAlone", { path, code })
            : t.rich("fileOn", { path, repository, code })}
        </dd>
        <dt>{t("publishedBy")}</dt>
        <dd data-fact="published">
          {commit === null ? (
            <span data-state="not-recorded">{t("publishedNotRecorded")}</span>
          ) : date === null ? (
            <span className={mono}>{commit.slice(0, 7)}</span>
          ) : (
            t.rich("publishedValue", {
              commit: commit.slice(0, 7),
              date: format.dateTime(new Date(date), { dateStyle: "medium" }),
              code,
            })
          )}
        </dd>
        <dt>{t("effect")}</dt>
        <dd data-fact="effect">
          {effect === null ? (
            <span data-state="not-recorded">{t("effectNotRecorded")}</span>
          ) : effect.rendered === 0 ? (
            t("neverRendered")
          ) : (
            <span data-gap={RECORD_GAPS.violated}>
              {t("effectLine", {
                rendered: formatCount(effect.rendered, locale),
                cited: formatCount(effect.cited, locale),
              })}
            </span>
          )}
        </dd>
        <dt>{t("schema")}</dt>
        <dd data-fact="schema" className={mono}>
          {SCHEMA}
        </dd>
      </dl>
    </section>
  );
}
