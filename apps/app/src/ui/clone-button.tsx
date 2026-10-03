"use client";
import { useTranslations } from "next-intl";
import { openClone } from "@/shared/create";
import { Button } from "@/ui/button";
/**
 * `label` names the source when a list shows one Clone per row, so each
 * button's accessible name says which one it copies. The button is the kit's
 * outline Button. `className` adds layout to it, such as the smaller size a
 * row gives its buttons.
 */
export function CloneButton({
  kind,
  sourceRef,
  label,
  className,
}: {
  kind: "skill" | "record";
  sourceRef: string;
  label?: string;
  className?: string;
}) {
  const t = useTranslations("create.clone");
  return (
    <Button
      type="button"
      variant="outline"
      className={className}
      aria-label={label}
      onClick={() => {
        openClone(kind, sourceRef);
      }}
    >
      {t("open")}
    </Button>
  );
}
