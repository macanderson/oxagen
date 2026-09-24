"use client";
// Request access on the denied register step (register-name spec, States). The
// design opens the `request-access` dialog, which would file a request for the
// missing role. No contract lets a person ask for a role (the kernel mints an
// access request only when a capability parks for approval), so the dialog
// says what the product would do and who can grant the permission today.
import { useTranslations } from "next-intl";
import { useState } from "react";
import { buttonPrimary } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";

export function RequestAccess({ permission }: { permission: string }) {
  const t = useTranslations("onboarding.register.denied");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="request-access"
        onClick={() => {
          setOpen(true);
        }}
        className={`${buttonPrimary} max-md:w-full`}
      >
        {t("request")}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={t("dialogTitle")}
        testId="request-access-dialog"
      >
        {/* Not backed until #3820 lands. */}
        <p
          data-testid="not-backed"
          data-element="request-access"
          className="text-sm text-muted-foreground"
        >
          {t("dialogBody", { permission })}
        </p>
      </SheetDialog>
    </>
  );
}
