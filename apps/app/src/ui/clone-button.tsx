"use client";
import { useTranslations } from "next-intl";
import { openClone } from "@/shared/create";
import { buttonSecondary } from "@/ui/control-styles";
/**
 * `label` names the source when a list shows one Clone per row, so each
 * button's accessible name says which one it copies. `className` replaces the
 * default secondary style, for a row that sizes its buttons smaller.
 */
export function CloneButton({
  kind,
  sourceRef,
  label,
  className = buttonSecondary,
}: {
  kind: "agent" | "skill" | "record";
  sourceRef: string;
  label?: string;
  className?: string;
}) {
  const t = useTranslations("create.clone");
  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      onClick={() => {
        openClone(kind, sourceRef);
      }}
    >
      {t("open")}
    </button>
  );
}
