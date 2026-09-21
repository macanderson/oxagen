// Where the record lives and who put it there (#3395; mockups/pages/record.md).
//
// Provenance is the publishing commit, read out of git, not a column somebody
// could set. A record whose file the page read but whose commit history it
// could not reach says so: a blank author and a blank date are honest, and an
// invented "unknown" author is not.
import { useLocale, useTranslations } from "next-intl";
import type { RecordDetail } from "@/data/contracts/steering";
import { mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { Fact, Facts, Section, useDate } from "./section";

/** The protocol every `.oxagen/rules/*.toml` file declares. */
const SCHEMA = "context-record/v0.1";

export function LineagePanel({ detail }: { detail: RecordDetail }) {
  const t = useTranslations("record.lineage");
  const date = useDate();
  const locale = useLocale();
  const { record, provenance, effect, backing } = detail;
  return (
    <Section id="record-lineage" title={t("title")}>
      <Facts>
        <Fact name="lineage" term={t("lineageTerm")}>
          <span className={mono}>{record.lineage}</span>
        </Fact>
        <Fact name="path" term={t("pathTerm")}>
          {record.path === null ? (
            <span data-state="not-recorded">{t("pathUnknown")}</span>
          ) : (
            <span className={mono}>{record.path}</span>
          )}
        </Fact>
        <Fact name="backing" term={t("backingTerm")}>
          {t(`backing.${backing}`)}
        </Fact>
        {provenance === null ? (
          <Fact name="commit" term={t("commitTerm")}>
            <span data-state="not-recorded">{t("commitUnknown")}</span>
          </Fact>
        ) : (
          <>
            <Fact name="commit" term={t("commitTerm")}>
              <span className={mono}>{provenance.commit.slice(0, 12)}</span>
            </Fact>
            <Fact name="author" term={t("authorTerm")}>
              {provenance.authorLogin === null
                ? provenance.authorName
                : t("author", {
                    name: provenance.authorName,
                    login: provenance.authorLogin,
                  })}
            </Fact>
            <Fact name="committed" term={t("committedTerm")}>
              {date(provenance.committedAt)}
            </Fact>
            {provenance.summary === "" ? null : (
              <Fact name="summary" term={t("summaryTerm")}>
                {provenance.summary}
              </Fact>
            )}
          </>
        )}
        {record.version === null ? null : (
          <Fact name="version" term={t("versionTerm")}>
            {String(record.version)}
          </Fact>
        )}
        <Fact name="effect" term={t("effectTerm")}>
          {effect === null ? (
            <span data-state="not-recorded">{t("effectUnknown")}</span>
          ) : (
            t("effect", {
              rendered: formatCount(effect.rendered, locale),
              cited: formatCount(effect.cited, locale),
            })
          )}
        </Fact>
        <Fact name="schema" term={t("schemaTerm")}>
          <span className={mono}>{SCHEMA}</span>
        </Fact>
      </Facts>
    </Section>
  );
}
