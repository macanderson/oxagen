"use client";
// The Audit page's dialogs (rev1 audit.md, Dialogs this page opens). Each opens
// from its button as a centred dialog, or on a phone as a sheet risen from the
// bottom edge (ui/sheet-dialog.tsx).
//
// Only one of them writes nothing and needs nothing more: `exportevents`
// downloads the signed CSV export_audit_events answers. The other five would
// each run a write no contract offers yet (build a bundle, raise an incident,
// rotate the key-encryption key, save a retention policy, request a role), so
// each draws the fields the design names, disabled, beside one sentence
// saying what is missing, and its submit is disabled. A stub says what the
// product would do; none of these silently does nothing (audit.md, Rules).
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import type { SafePath } from "@/shared/safe-path";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { DownloadLink } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";

/** The issue a dialog's missing write is tracked in, as a data attribute only. */
type Gap = { issue: string };

function DialogButton({
  label,
  primary = false,
  testId,
  title,
  subtitle,
  footer,
  children,
}: {
  label: string;
  /** The screen's one gold action (audit.md, Header). */
  primary?: boolean;
  testId: string;
  title: string;
  subtitle?: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-opens={testId}
        onClick={() => setOpen(true)}
        className={primary ? buttonPrimary : buttonSecondary}
      >
        {label}
      </button>
      <SheetDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        subtitle={subtitle}
        testId={testId}
        footer={footer}
      >
        {children}
      </SheetDialog>
    </>
  );
}

/** One sentence naming the write that does not exist, which the disabled fields point at. */
function Missing({ id, gap, text }: { id: string; gap: Gap; text: string }) {
  return (
    <p
      id={id}
      data-testid="audit-not-recorded"
      data-issue={gap.issue}
      className="rounded-md border border-border bg-hl px-3 py-2 text-[13px] text-muted-foreground"
    >
      {text}
    </p>
  );
}

const field = "flex flex-col gap-1 text-[13px]";
const label = "text-xs font-medium text-muted-foreground";
/** 16px on a phone so the browser does not zoom the page on focus (audit.md, Mobile). */
const control = `${inputBase} max-md:text-base`;

/** A submit the missing write keeps disabled, described by the sentence that says why. */
function DisabledSubmit({
  label: text,
  describedBy,
}: {
  label: string;
  describedBy: string;
}) {
  return (
    <button
      type="button"
      disabled
      aria-describedby={describedBy}
      className={buttonPrimary}
    >
      {text}
    </button>
  );
}

/** `newexport`: the header's gold action. Build bundle waits on an evidence bundle store. */
export function BundleDialog({ gap }: { gap: Gap }) {
  const t = useTranslations("audit.bundle");
  const note = useId();
  return (
    <DialogButton
      primary
      label={t("open")}
      testId="audit-newexport"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={<DisabledSubmit label={t("build")} describedBy={note} />}
    >
      <fieldset
        disabled
        aria-describedby={note}
        className="flex flex-col gap-3"
      >
        <label className={field}>
          <span className={label}>{t("scope")}</span>
          <select className={control} defaultValue="all">
            <option value="all">{t("scopeAll")}</option>
          </select>
        </label>
        <span className="grid grid-cols-2 gap-3">
          <label className={field}>
            <span className={label}>{t("from")}</span>
            <input type="date" className={control} />
          </label>
          <label className={field}>
            <span className={label}>{t("to")}</span>
            <input type="date" className={control} />
          </label>
        </span>
        <label className={field}>
          <span className={label}>{t("format")}</span>
          <select className={control} defaultValue="bundle">
            <option value="bundle">{t("formatBundle")}</option>
            <option value="csv">{t("formatCsv")}</option>
            <option value="json">{t("formatJson")}</option>
          </select>
        </label>
        <Missing id={note} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}

/** `exportevents`: the signed CSV over the table's own filters. */
export function CsvDialog({ href }: { href: SafePath }) {
  const t = useTranslations("audit.csv");
  return (
    <DialogButton
      label={t("open")}
      testId="audit-exportevents"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={
        // A plain download, not a Link: the href is a route handler that runs
        // export_audit_events, and a prefetch would record an export nobody
        // asked for (DownloadLink, ui/navigation.tsx).
        <DownloadLink to={href} data-export="csv" className={buttonPrimary}>
          {t("download")}
        </DownloadLink>
      }
    >
      <p className="text-[13px] text-muted-foreground">{t("body")}</p>
    </DialogButton>
  );
}

/** `incident`: Open an incident, from the Incidents panel and the error state. */
export function IncidentDialog({ gap }: { gap: Gap }) {
  const t = useTranslations("audit.incident");
  const note = useId();
  return (
    <DialogButton
      label={t("title")}
      testId="audit-incident"
      title={t("title")}
      footer={<DisabledSubmit label={t("submit")} describedBy={note} />}
    >
      <fieldset
        disabled
        aria-describedby={note}
        className="flex flex-col gap-3"
      >
        <label className={field}>
          <span className={label}>{t("subject")}</span>
          <input className={control} />
        </label>
        <label className={field}>
          <span className={label}>{t("severity")}</span>
          <select className={control} defaultValue="critical">
            <option value="critical">{t("severities.critical")}</option>
            <option value="warning">{t("severities.warning")}</option>
            <option value="info">{t("severities.info")}</option>
          </select>
        </label>
        <span className={field}>
          <span className={label}>{t("attach")}</span>
          <span className="text-muted-foreground">{t("attachNone")}</span>
        </span>
        <Missing id={note} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}

/** `rotatekek`: Rotate KEK. Waits on a key registry. */
export function RotateDialog({ gap }: { gap: Gap }) {
  const t = useTranslations("audit.rotate");
  const keys = useTranslations("audit.keys");
  const note = useId();
  return (
    <DialogButton
      label={keys("rotate")}
      testId="audit-rotatekek"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={<DisabledSubmit label={t("submit")} describedBy={note} />}
    >
      <Missing id={note} gap={gap} text={t("notRecorded")} />
    </DialogButton>
  );
}

/** `retention`: Edit policy. Waits on a retention policy store and its write. */
export function PolicyDialog({ gap }: { gap: Gap }) {
  const t = useTranslations("audit.policy");
  const retention = useTranslations("audit.retention");
  const note = useId();
  return (
    <DialogButton
      label={retention("edit")}
      testId="audit-retention"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={<DisabledSubmit label={t("submit")} describedBy={note} />}
    >
      <fieldset
        disabled
        aria-describedby={note}
        className="flex flex-col gap-3"
      >
        <label className={field}>
          <span className={label}>{t("body")}</span>
          <select className={control} defaultValue="7y">
            <option value="7y">{t("bodyDefault")}</option>
          </select>
        </label>
        <label className={field}>
          <span className={label}>{t("hot")}</span>
          <select className={control} defaultValue="13m">
            <option value="13m">{t("hotDefault")}</option>
          </select>
        </label>
        <Missing id={note} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}

/** `request-access`: the denied state's gold action. Waits on an access-request write. */
export function RequestAccessDialog({
  gap,
  permission,
}: {
  gap: Gap;
  permission: string;
}) {
  const t = useTranslations("audit.request");
  const denied = useTranslations("audit.denied");
  const note = useId();
  return (
    <DialogButton
      primary
      label={denied("request")}
      testId="audit-request-access"
      title={t("title")}
      footer={<DisabledSubmit label={t("submit")} describedBy={note} />}
    >
      <fieldset
        disabled
        aria-describedby={note}
        className="flex flex-col gap-3"
      >
        <label className={field}>
          <span className={label}>{t("role")}</span>
          <input className={control} defaultValue={permission} />
        </label>
        <label className={field}>
          <span className={label}>{t("why")}</span>
          <textarea rows={3} className={control} />
        </label>
        <Missing id={note} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}
