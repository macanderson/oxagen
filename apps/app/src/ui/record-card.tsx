// A steering record as a card (#2961; the mockup's recordCard): the statement
// is the headline, with its kind, force and constraint effect above it and its
// sharing scope and lineage beneath. A published record and a proposal render
// through the same card; the caller adds its state badge and its own facts.
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import type {
  ConstraintEffect,
  RecordForce,
  RecordKind,
  SharingScope,
} from "@/data/contracts/steering";
import { mono, panel } from "./control-styles";

const tag = "rounded-sm border border-border px-1.5 py-0.5";

export function RecordCard({
  kind,
  force,
  constraintEffect,
  sharingScope,
  lineage,
  label,
  statement,
  badge,
  children,
}: {
  /** Null on a record no Context PR classified. */
  kind: RecordKind | null;
  force: RecordForce | null;
  constraintEffect: ConstraintEffect | null;
  sharingScope: SharingScope;
  lineage: string;
  label?: string;
  statement: string;
  /** The record's state, beside its classification. */
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const t = useTranslations("ui.record");
  return (
    <article
      data-kind={kind ?? "unclassified"}
      className={`${panel} flex flex-col gap-2 p-4`}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span data-term="kind" className={`${tag} font-medium`}>
          {kind === null ? t("unclassified") : t(`kinds.${kind}`)}
        </span>
        {force === null ? null : (
          <span data-term="force" className={tag}>
            {t("force", { force })}
          </span>
        )}
        {constraintEffect === null ? null : (
          <span data-term="constraint-effect" className={tag}>
            {t(`effects.${constraintEffect}`)}
          </span>
        )}
        {badge === undefined ? null : (
          <span className="ms-auto flex flex-wrap items-center gap-2">
            {badge}
          </span>
        )}
      </div>
      {label ? <h3 className="text-sm font-semibold">{label}</h3> : null}
      <p className="text-sm font-medium text-foreground">{statement}</p>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <div data-term="scope" className="flex gap-1">
          <dt>{t("scope")}</dt>
          <dd>{t(`scopes.${sharingScope}`)}</dd>
        </div>
        <div data-term="lineage" className="flex min-w-0 gap-1">
          <dt>{t("lineage")}</dt>
          <dd className={`${mono} break-all`}>{lineage}</dd>
        </div>
      </dl>
      {children}
    </article>
  );
}
