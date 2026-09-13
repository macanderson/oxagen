import { CircleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { RetryButton } from "./retry-button";
import { StateFrame } from "./state-frame";

export type ErrorStateProps = {
  code: string;
  status: number;
  /** A digest or trace id to quote when reporting the failure. */
  detail?: string | undefined;
  /** An error boundary's retry; without one the button refreshes the route. */
  onRetry?: () => void;
  actions?: ReactNode;
};

export function ErrorState({
  code,
  status,
  detail,
  onRetry,
  actions,
}: ErrorStateProps) {
  const t = useTranslations("ui.pageState.error");
  return (
    <StateFrame
      testId="page-state-error"
      icon={CircleAlert}
      tone="error"
      title={t("title")}
      body={t("body", { code, status })}
      actions={
        <>
          <RetryButton {...(onRetry ? { onRetry } : {})} />
          {actions}
        </>
      }
    >
      {detail ? (
        <p className="font-mono text-[11.5px] text-muted-foreground">
          {detail}
        </p>
      ) : null}
    </StateFrame>
  );
}
