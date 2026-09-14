import { Inbox } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { StateFrame } from "./state-frame";

export type EmptyStateProps = {
  /** The page's own words for its empty state; the generic copy is the fallback. */
  title?: string;
  body?: ReactNode;
  actions?: ReactNode;
};

export function EmptyState({ title, body, actions }: EmptyStateProps) {
  const t = useTranslations("ui.pageState.empty");
  return (
    <StateFrame
      testId="page-state-empty"
      icon={Inbox}
      title={title ?? t("title")}
      body={body ?? t("body")}
      actions={actions}
    />
  );
}
