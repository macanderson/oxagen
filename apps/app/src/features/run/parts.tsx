// The pieces the Run page's sections share: a titled panel, a key/value list
// and the "not recorded" span every section prints for a value the store did
// not carry. A section never substitutes a zero, a default or a neighbouring
// column for a value the run does not have (§3.4).
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { mono, panel } from "@/ui/control-styles";

export function NoValue() {
  const t = useTranslations("run");
  return <span className="text-muted-foreground">{t("notRecorded")}</span>;
}

export function Panel({
  title,
  aside,
  children,
}: {
  title: string;
  /** A count, a basis or a badge, set against the title. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  const id = `run-panel-${title.toLowerCase().replaceAll(/[^a-z0-9]+/g, "-")}`;
  return (
    <section aria-labelledby={id} className={`${panel} p-4`}>
      <div className="flex flex-wrap items-center justify-between gap-3 pb-3">
        <h3 id={id} className="text-base font-semibold">
          {title}
        </h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

/** A record's fields, label left and value right, wrapping to one column on a phone. */
export function Facts({ children }: { children: ReactNode }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-[auto_1fr]">
      {children}
    </dl>
  );
}

export function Fact({
  label,
  children,
  /** A digest, an id or a path reads as code, never as prose. */
  code = false,
}: {
  label: string;
  children: ReactNode;
  code?: boolean;
}) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={code ? `${mono} break-all` : undefined}>{children}</dd>
    </>
  );
}
