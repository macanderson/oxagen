"use client";
// The gate's two not-loaded bodies (mockup `skeleton()` and `deniedState()`):
// each replaces the card and never the gate shell, so the rail and Cancel stay.
//
// The shell lane's shared state components are not on this base, so these are
// the gate's own, drawn to the same design record: four tile blocks and a panel
// of seven rows while a step loads, and a denial that names the permission, who
// is signed in and what decided it.
//
// Request access opens the `request-access` dialog the design names. No
// capability lets a person ask for a role today, so the dialog says what the
// request would do and that nothing is sent, rather than pretending to send it.
import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, mono } from "@/ui/control-styles";
import { SafeLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

const block = "animate-pulse rounded-xl border border-border bg-hl";

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
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className={`${block} h-16`} />
        ))}
      </div>
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="border-b border-border bg-hl px-4 py-3">
          <div className="h-3 w-44 animate-pulse rounded bg-border" />
        </div>
        <div className="flex flex-col gap-2 px-4 py-3.5">
          {[0, 1, 2, 3, 4, 5, 6].map((i) => (
            <div key={i} className="h-9 animate-pulse rounded-lg bg-hl" />
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
    <code className={`${mono} rounded bg-hl px-1`}>{chunks}</code>
  );
  return (
    <section
      data-testid="page-state-denied"
      className="flex flex-col items-center px-2 py-10 text-center"
    >
      <span
        aria-hidden="true"
        className="mb-4 inline-flex size-11 items-center justify-center rounded-xl border border-warning/40 text-warning"
      >
        <Lock className="size-5" />
      </span>
      <h2 className="text-lg font-semibold text-foreground">{t("title")}</h2>
      <p className="mt-2 max-w-[440px] text-sm leading-relaxed text-muted-foreground">
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
      </p>
      <div className="mt-5 flex flex-wrap justify-center gap-2.5 max-md:w-full max-md:flex-col">
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
      </div>
      <dl className="mt-5 grid max-w-[420px] grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-left text-[13px]">
        <dt className="text-muted-foreground">{t("signedIn")}</dt>
        <dd>{signedIn}</dd>
        <dt className="text-muted-foreground">{t("needed")}</dt>
        <dd className={mono}>{permission}</dd>
        <dt className="text-muted-foreground">{t("decidedBy")}</dt>
        <dd>{t("decidedByValue")}</dd>
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
    </section>
  );
}
