"use client";
// The two controls the not-loaded states carry whose writes Oxagen does not
// have yet: Request access on the denied state and Open an incident on the
// error state (pages/billing.md, the `request-access` and `incident`
// dialogs). No contract lets a person ask for a role, and none files an
// incident, so each button opens its dialog and the dialog says what the
// product would do and what to do until then. Nothing here silently does
// nothing, and nothing pretends to have sent a request.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { buttonPrimary, buttonSecondary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";

function StubDialog({
  label,
  title,
  primary,
  testId,
  children,
}: {
  label: string;
  title: string;
  /** Draw the opener gold: it is the state's one primary action. */
  primary: boolean;
  testId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={`${testId}-open`}
        data-touch-target=""
        className={primary ? buttonPrimary : buttonSecondary}
        onClick={() => {
          setOpen(true);
        }}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        testId={testId}
      >
        <div className="flex flex-col gap-3 text-sm">{children}</div>
      </SheetDialog>
    </>
  );
}

export function RequestAccess({ permission }: { permission: string }) {
  const t = useTranslations("billing.state");
  return (
    <StubDialog
      label={t("denied.request")}
      title={t("requestAccess.title")}
      primary
      testId="billing-request-access"
    >
      <p>{t("requestAccess.body", { permission })}</p>
      <p className="text-muted-foreground">{t("requestAccess.now")}</p>
    </StubDialog>
  );
}

export function OpenIncident({ code, at }: { code: string; at: string }) {
  const t = useTranslations("billing.state");
  return (
    <StubDialog
      label={t("error.incident")}
      title={t("incident.title")}
      primary={false}
      testId="billing-incident"
    >
      <p>{t("incident.body", { code, at })}</p>
      <p className="text-muted-foreground">{t("incident.now")}</p>
    </StubDialog>
  );
}
