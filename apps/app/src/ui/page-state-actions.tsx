"use client";
// The controls on the shared error and access-denied states: Try again, Open
// an incident, and Request access.
//
// Try again re-reads the page. The other two open a dialog that says what the
// control would send and that nothing was sent, because no contract raises an
// incident (#3847) and none lets a person ask for a role (#3846). A control
// that silently does nothing is the one thing the design forbids, so each
// dialog names the gap and the step a person can take today. Request access
// links to the Organization page, which lists the owners who can grant a role.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { routes } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

/**
 * Re-reads the page. An error boundary passes its own `onRetry`, which resets
 * the boundary as well as refreshing the route.
 */
export function TryAgain({
  onRetry,
  testId = "page-state-retry",
}: {
  onRetry?: () => void;
  testId?: string;
}) {
  const t = useTranslations("ui.pageState.error");
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid={testId}
      className={buttonPrimary}
      onClick={() => {
        if (onRetry === undefined) navigate.refresh();
        else onRetry();
      }}
    >
      {t("retry")}
    </button>
  );
}

export function OpenIncident({ code }: { code: string }) {
  const t = useTranslations("ui.pageState.incident");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="page-state-incident"
        data-issue="3847"
        className={buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("title")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        testId="page-state-incident-dialog"
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>
            {t.rich("body", {
              code,
              c: (chunks) => <code className={mono}>{chunks}</code>,
            })}
          </p>
          <p className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground">
            {t("now")}
          </p>
        </div>
      </SheetDialog>
    </>
  );
}

export function RequestAccess({ org, need }: { org: string; need: string }) {
  const t = useTranslations("ui.pageState.requestAccess");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="page-state-request-access"
        data-issue="3846"
        className={buttonPrimary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {t("title")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("title")}
        testId="page-state-request-access-dialog"
        footer={
          <SafeLink to={routes.people(org)} className={buttonPrimary}>
            {t("people")}
          </SafeLink>
        }
      >
        <div className="flex flex-col gap-3 text-sm">
          <p>{t("body", { need })}</p>
          <p className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground">
            {t("now")}
          </p>
        </div>
      </SheetDialog>
    </>
  );
}
