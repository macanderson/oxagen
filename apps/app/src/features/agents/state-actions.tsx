"use client";
// The actions the Agents page's not-loaded states offer (agents.md, States):
// Try again on the error state, and the two controls no capability backs yet.
//
// Request access (denied) and Open an incident (error) each open a dialog that
// says what the product would do and that nothing records it yet, rather than
// a button that silently does nothing (agents.md, "Stub controls say what the
// product would do"). Request access waits on #3820, Open an incident on
// #3847. When those land, the dialogs send the request and file the incident.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { routes } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  linkText,
  mono,
} from "@/ui/control-styles";
import { SafeLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

function StubDialog({
  label,
  title,
  testId,
  gap,
  primary = false,
  children,
}: {
  label: string;
  title: string;
  testId: string;
  /** The issue the missing capability is tracked on. */
  gap: string;
  primary?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid={testId}
        data-touch-target=""
        aria-haspopup="dialog"
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
        testId={`${testId}-dialog`}
      >
        <div
          data-not-backed=""
          data-gap={gap}
          className="flex flex-col gap-3 text-sm"
        >
          {children}
        </div>
      </SheetDialog>
    </>
  );
}

/** Request access, the denied state's gold action. */
export function RequestAccess({
  org,
  permission,
}: {
  org: string;
  /** The permission the read was refused, as the Needed line names it. */
  permission: string;
}) {
  const t = useTranslations("agents.list");
  return (
    <StubDialog
      label={t("states.denied.request")}
      title={t("stubs.requestTitle")}
      testId="agents-request-access"
      gap="#3820"
      primary
    >
      <label className="flex flex-col gap-1">
        {t("stubs.requestRole")}
        <input
          readOnly
          value={permission}
          data-touch-target=""
          className={`${inputBase} ${mono}`}
        />
      </label>
      <p>{t("stubs.requestBody")}</p>
      <SafeLink to={routes.roles(org)} className={`${linkText} self-start`}>
        {t("stubs.requestLink")}
      </SafeLink>
    </StubDialog>
  );
}

/** Open an incident, beside Try again on the error state. */
export function OpenIncident({ code }: { code: string }) {
  const t = useTranslations("agents.list");
  return (
    <StubDialog
      label={t("states.error.incident")}
      title={t("stubs.incidentTitle")}
      testId="agents-incident"
      gap="#3847"
    >
      <p>{t("stubs.incidentBody", { code })}</p>
    </StubDialog>
  );
}

/** Try again, the error state's gold action: the page's server read, made again in place. */
export function TryAgain() {
  const t = useTranslations("agents.list.states.error");
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="agents-retry"
      data-touch-target=""
      className={buttonPrimary}
      onClick={() => {
        navigate.refresh();
      }}
    >
      {t("retry")}
    </button>
  );
}
