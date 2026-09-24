"use client";
// The gate's two not-loaded bodies (mockup `skeleton()` and `deniedState()`):
// each replaces the card and never the gate shell, so the rail and Cancel stay.
//
// The skeleton is four tile blocks and a panel of seven rows, each bone the
// design's `.sk` shimmer. The denial is the shared `StateWrap` in the denied
// tone, naming the permission, who is signed in and what decided it.
//
// Request access opens the `request-access` dialog the design names. No
// capability lets a person ask for a role today, so the dialog says what the
// request would do and that nothing is sent, rather than pretending to send it.
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  kvTerm,
  kvValue,
  mono,
  panel,
  panelBody,
  panelHeader,
  statStrip,
} from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { StateWrap, stateCode, stateFacts } from "@/ui/state-wrap";

export function GateSkeleton() {
  const t = useTranslations("onboarding.welcome.shell");
  return (
    <div
      data-testid="page-state-loading"
      aria-busy="true"
      aria-label={t("loading")}
      role="status"
      className="flex flex-col gap-4"
    >
      <div className={statStrip}>
        {[0, 1, 2, 3].map((i) => (
          <div
            key={i}
            data-skeleton-tile=""
            className="skeleton h-16 rounded-[11px]"
          />
        ))}
      </div>
      <div className={panel}>
        <div className={panelHeader}>
          <div className="skeleton h-[22px] w-[180px] max-w-full rounded-[7px]" />
        </div>
        <div className={`${panelBody} flex flex-col gap-2`}>
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div
              key={i}
              data-skeleton-row=""
              className="skeleton h-[38px] rounded-[9px]"
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export function GateDenied({
  org,
  permission,
  signedIn,
  back,
}: {
  /** The organization the roles are held on; null before one exists. */
  org: string | null;
  /** The permission the step's write needs, as the refusal names it. */
  permission: string;
  /** Who is signed in, and in which role and workspace when there is one. */
  signedIn: string;
  back: SafePath;
}) {
  const t = useTranslations("onboarding.welcome.denied");
  const [open, setOpen] = useState(false);
  const code = (chunks: ReactNode) => (
    <code className={stateCode}>{chunks}</code>
  );
  return (
    <StateWrap
      testId="page-state-denied"
      tone="denied"
      title={t("title")}
      actions={
        <>
          <button
            type="button"
            className={buttonPrimary}
            onClick={() => {
              setOpen(true);
            }}
          >
            {t("requestAccess")}
          </button>
          <SafeLink to={back} className={buttonSecondary}>
            {t("backToFleet")}
          </SafeLink>
        </>
      }
      after={
        <>
          <dl className={stateFacts}>
            <dt className={kvTerm}>{t("signedIn")}</dt>
            <dd className={kvValue}>{signedIn}</dd>
            <dt className={kvTerm}>{t("needed")}</dt>
            <dd className={`${kvValue} ${mono}`}>{permission}</dd>
            <dt className={kvTerm}>{t("decidedBy")}</dt>
            <dd className={kvValue}>{t("decidedByValue")}</dd>
          </dl>
          <SheetDialog
            open={open}
            onOpenChange={setOpen}
            title={t("dialogTitle")}
            testId="request-access"
            closeLabel={t("close")}
          >
            <p className="text-sm text-foreground">
              {t("dialogBody", { permission })}
            </p>
            <p
              data-testid="request-access-not-backed"
              className="mt-3 text-sm text-muted-foreground"
            >
              {t("dialogNotBacked")}
            </p>
          </SheetDialog>
        </>
      }
    >
      {org === null
        ? t.rich("bodyNoOrg", { permission, code })
        : t.rich("body", {
            org,
            permission,
            code,
            b: (chunks) => (
              <b className="font-semibold text-foreground">{chunks}</b>
            ),
          })}
    </StateWrap>
  );
}
