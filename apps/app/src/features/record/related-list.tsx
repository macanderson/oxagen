"use client";
// The related records as the mockup's record cards (`recordCard`), under the
// list controls every list in the design carries: search, Sort, Rows and a
// pager. The list is at most three records, so the controls narrow what is on
// screen and read nothing new.
import { useTranslations } from "next-intl";
import type {
  ConstraintEffect,
  RecordForce,
  RecordKind,
  SharingScope,
} from "@/data/contracts/steering";
import type { SafePath } from "@/shared/safe-path";
import { Badge } from "@/ui/badge";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { useFormatter } from "@/ui/formatter";
import { ListBar, ListPager, type ListSort, useList } from "@/ui/list-controls";
import { SafeLink } from "@/ui/navigation";
import { KIND_FACE, KindBadge, KindTile } from "./kind";

export type RelatedItem = {
  lineage: string;
  kind: RecordKind;
  force: RecordForce | null;
  constraintEffect: ConstraintEffect | null;
  scope: SharingScope;
  /** The record's name (ADR-178), or its title while it declares none. */
  label: string;
  statement: string | null;
  commit: string | null;
  publishedAt: string | null;
  href: SafePath;
};

export function RelatedList({ items }: { items: RelatedItem[] }) {
  const t = useTranslations("record.related");
  const sorts: ListSort<RelatedItem>[] = [
    { value: "shown", label: t("sorts.shown"), compare: null },
    {
      value: "az",
      label: t("sorts.az"),
      compare: (a, b) => a.label.localeCompare(b.label),
    },
    {
      value: "za",
      label: t("sorts.za"),
      compare: (a, b) => b.label.localeCompare(a.label),
    },
  ];
  const list = useList(items, {
    text: (item) =>
      `${item.label} ${item.statement ?? ""} ${item.lineage} ${item.scope}`,
    sorts,
  });
  return (
    <>
      <ListBar
        list={list}
        searchLabel={t("search")}
        sortLabel={t("sort")}
        sorts={sorts}
        rowsLabel={t("rows")}
      />
      {list.shown.length === 0 ? (
        <p className="px-4 py-3.5 text-[13px] text-dim">{t("nothing")}</p>
      ) : (
        <ul data-testid="record-related-list">
          {list.shown.map((item) => (
            <li key={item.lineage}>
              <RelatedCard item={item} />
            </li>
          ))}
        </ul>
      )}
      <ListPager
        list={list}
        range={(from, to, total) => t("range", { from, to, total })}
        previousLabel={t("previous")}
        nextLabel={t("next")}
      />
    </>
  );
}

function RelatedCard({ item }: { item: RelatedItem }) {
  const t = useTranslations("record.related");
  const term = useTranslations("ui.record");
  const format = useFormatter();
  return (
    <article
      data-kind={item.kind}
      className={`grid grid-cols-[34px_minmax(0,1fr)] gap-3.5 border-b border-l-[3px] border-b-border px-4 py-3.5 max-sm:grid-cols-1 ${KIND_FACE[item.kind].rule}`}
    >
      <span className="max-sm:hidden">
        <KindTile kind={item.kind} size="sm" />
      </span>
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-1.5">
          <KindBadge kind={item.kind} />
          {item.force === null ? null : (
            <Badge tone="quiet" dot={false}>
              {item.force}
            </Badge>
          )}
          {item.constraintEffect === null ? null : (
            <Badge
              tone={item.constraintEffect === "forbid" ? "denied" : "approval"}
              dot={false}
            >
              {term(`effects.${item.constraintEffect}`)}
            </Badge>
          )}
          <SafeLink
            to={item.href}
            data-touch-target=""
            className={`${buttonSecondary} ms-auto min-h-7 px-2.5 py-1 text-xs`}
          >
            {t("open")}
          </SafeLink>
        </div>
        <p
          data-term="label"
          className="text-[15px] font-semibold leading-snug text-foreground"
        >
          {item.label}
        </p>
        {item.statement === null ? null : (
          <p
            data-term="statement"
            className="text-[13.5px] leading-snug text-muted-foreground"
          >
            {item.statement}
          </p>
        )}
        <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-[11.5px] text-dim">
          <b className="font-semibold text-muted-foreground">
            {term(`scopes.${item.scope}`)}
          </b>
          <span className={mono}>{item.lineage}</span>
          {item.commit === null ? null : (
            <span className={mono}>{item.commit.slice(0, 7)}</span>
          )}
          {item.publishedAt === null ? null : (
            <span>
              {format.dateTime(new Date(item.publishedAt), {
                dateStyle: "medium",
              })}
            </span>
          )}
        </p>
      </div>
    </article>
  );
}
