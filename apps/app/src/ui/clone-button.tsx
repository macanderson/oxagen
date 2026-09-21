"use client";
import { useTranslations } from "next-intl";
import { openClone } from "@/shared/create";
import { buttonSecondary } from "@/ui/control-styles";
export function CloneButton({
  kind,
  sourceRef,
}: {
  kind: "agent" | "skill" | "record";
  sourceRef: string;
}) {
  const t = useTranslations("create.clone");
  return (
    <button
      type="button"
      className={buttonSecondary}
      onClick={() => {
        openClone(kind, sourceRef);
      }}
    >
      {t("open")}
    </button>
  );
}
