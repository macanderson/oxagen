"use client";
// The permission catalogue a role is written in, behind a button in the Roles
// toolbar. It read as a panel under the table, where nobody scrolled to it; a
// dialog puts it one click from the editor that needs it. Members see the same
// button: reading the catalogue changes nothing.
import { BookOpen } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import type { Permission } from "@/data/contracts/org";
import { buttonSecondary, mono } from "@/ui/control-styles";
import { formatCount } from "@/ui/money-format";
import { SheetDialog } from "@/ui/sheet-dialog";

export function CatalogueDialog({
  catalog,
}: {
  catalog: readonly Permission[];
}) {
  const t = useTranslations("organization.roleCatalog.catalog");
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const groups = [...new Set(catalog.map((entry) => entry.group))];
  return (
    <>
      <button
        type="button"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        <BookOpen aria-hidden="true" className="size-4" />
        {t("open")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        wide
        testId="permission-catalogue"
      >
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{t("lead")}</p>
          {groups.map((group) => (
            <div key={group} className="flex flex-col gap-1.5">
              <h3 className="text-sm font-semibold text-foreground">{group}</h3>
              <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
                {catalog
                  .filter((entry) => entry.group === group)
                  .map((entry) => (
                    <div
                      key={entry.permission}
                      data-permission={entry.permission}
                      className="contents"
                    >
                      <dt className={`${mono} text-foreground`}>
                        {entry.permission}
                      </dt>
                      <dd className="text-muted-foreground">
                        {entry.description}{" "}
                        {t("covers", {
                          count: formatCount(entry.capabilities.length, locale),
                        })}
                      </dd>
                    </div>
                  ))}
              </dl>
            </div>
          ))}
        </div>
      </SheetDialog>
    </>
  );
}
