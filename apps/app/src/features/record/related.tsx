// Related records (#3395; mockups/pages/record.md): up to three other records
// of this kind, as record cards with an Open button, under Sort, Rows and a
// pager. A reader who has just understood what a constraint does wants the
// other constraints, and the kind is the only axis on which that question has
// an answer today. With none, the panel says this is the only one.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type { RecordKind, RecordPage } from "@/data/contracts/steering";
import type { Read } from "@/data/read";
import { panel, panelHeader, panelTitle } from "@/ui/control-styles";
import { RecordReadFailure } from "./read-failure";
import { type RelatedItem, RelatedList } from "./related-list";
import { recordLink, type RecordAt } from "./view";

/** The mockup's count: three is a sample, and a fourth is a list page. */
const RELATED_SHOWN = 3;

function Frame({ children }: { children: ReactNode }) {
  const t = useTranslations("record.related");
  return (
    <section
      aria-labelledby="record-related"
      data-testid="record-related"
      className={panel}
    >
      <div className={panelHeader}>
        <h2 id="record-related" className={panelTitle}>
          {t("title")}
        </h2>
      </div>
      {children}
    </section>
  );
}

export function Related({
  at,
  workspace,
  kind,
  read,
}: {
  at: RecordAt;
  /** The workspace's name, which the empty line names. */
  workspace: string;
  /** This record's kind; null when no Context PR classified it. */
  kind: RecordKind | null;
  read: Read<RecordPage> | null;
}) {
  const t = useTranslations("record.related");
  const term = useTranslations("ui.record");
  if (kind === null || read === null) {
    return (
      <Frame>
        <p
          data-state="not-recorded"
          className="px-4 py-3.5 text-[13px] text-muted-foreground"
        >
          {t("unclassified")}
        </p>
      </Frame>
    );
  }
  if (!read.ok) {
    return (
      <Frame>
        <div className="px-4 py-3.5">
          <RecordReadFailure read={read} section={t("title")} />
        </div>
      </Frame>
    );
  }
  const items: RelatedItem[] = read.value.records
    .filter((record) => record.lineage !== at.lineage && record.kind === kind)
    .slice(0, RELATED_SHOWN)
    .map((record) => ({
      lineage: record.lineage,
      kind,
      force: record.force,
      constraintEffect: record.constraintEffect,
      scope: record.sharingScope,
      label: record.label ?? record.title,
      statement: record.statement,
      commit: record.commit,
      publishedAt: record.publishedAt,
      href: recordLink({ ...at, lineage: record.lineage }),
    }));
  if (items.length === 0) {
    return (
      <Frame>
        <p data-state="empty" className="px-4 py-3.5 text-[13px] text-dim">
          {t("only", { kind: term(`kinds.${kind}`), workspace })}
        </p>
      </Frame>
    );
  }
  return (
    <Frame>
      <RelatedList items={items} />
    </Frame>
  );
}
