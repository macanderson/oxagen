import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { StateFrame } from "./state-frame";

export type DeniedStateProps = {
  permission: string;
  /** Request access and similar writes arrive with their capability (Batch 4). */
  actions?: ReactNode;
};

/** A member without the permission. Non-members never see this: they get a 404. */
export function DeniedState({ permission, actions }: DeniedStateProps) {
  const t = useTranslations("ui.pageState.denied");
  return (
    <StateFrame
      testId="page-state-denied"
      icon={Lock}
      tone="warning"
      title={t("title")}
      body={t("body", { permission })}
      actions={actions}
    >
      <dl className="flex gap-2 text-sm">
        <dt className="text-muted-foreground">{t("needed")}</dt>
        <dd className="font-mono">{permission}</dd>
      </dl>
    </StateFrame>
  );
}
