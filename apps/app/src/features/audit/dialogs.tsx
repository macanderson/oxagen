"use client";
// The Audit page's dialogs (rev1 audit.md, Dialogs this page opens). Each opens
// from its button as a centred dialog, or on a phone as a sheet risen from the
// bottom edge (ui/sheet-dialog.tsx).
//
// Two of them run: `exportevents` downloads the signed CSV export_audit_events
// answers, and `newexport` queues export_data for the organization (Build
// bundle, actions.ts) and opens Exports on the export it queued. The other four
// would each run a write no contract offers yet (raise an incident, rotate the
// key-encryption key, save a retention policy, request a role), so each draws
// the fields the design names, disabled, beside one sentence saying what is
// missing, and its submit is disabled. A stub says what the product would do;
// none of these silently does nothing (audit.md, Rules). Every footer's
// dismiss button reads Cancel, as the design's does.
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState, useTransition } from "react";
import { routes, type SafePath } from "@/shared/safe-path";
import {
  buttonPrimary,
  buttonSecondary,
  inputBase,
  mono,
} from "@/ui/control-styles";
import { FormAlert, SubmitButton } from "@/ui/form-feedback";
import { DownloadLink, useNavigate } from "@/ui/navigation";
import { SheetDialog } from "@/ui/sheet-dialog";
import { buildBundle } from "./actions";

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
  children: ReactNode | ((close: () => void) => ReactNode);
}) {
  const t = useTranslations("audit");
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-opens={testId}
        onClick={() => {
          setOpen(true);
        }}
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
        closeLabel={t("cancel")}
      >
        {typeof children === "function"
          ? children(() => {
              setOpen(false);
            })
          : children}
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

/** A callout: the one fact a dialog states about the write it runs. */
function Callout({ children }: { children: ReactNode }) {
  return (
    <p className="border-l-2 border-gold pl-3 text-[13px] text-muted-foreground">
      {children}
    </p>
  );
}

const BUNDLE_FORM = "audit-bundle-form";

/**
 * `newexport`: the header's gold action. Build bundle queues export_data for
 * the organization and opens Exports on the export it queued. Scope is the one
 * value export_data takes; From, To and Format stay disabled beside the reason.
 */
export function BundleDialog({ org, gap }: { org: string; gap: Gap }) {
  const t = useTranslations("audit.bundle");
  const navigate = useNavigate();
  const fieldsId = useId();
  const [pending, start] = useTransition();
  const [failure, setFailure] = useState<string | null>(null);
  const submit = (close: () => void) => () => {
    start(async () => {
      setFailure(null);
      const result = await buildBundle(org);
      if (result.ok) {
        close();
        navigate.push(
          routes.auditTab(org, "exports", { export: result.value.exportId }),
        );
        return;
      }
      setFailure(
        result.reason === "denied"
          ? t("denied")
          : result.reason === "pending_approval"
            ? t("pending", { id: result.accessRequestId })
            : t("failed", { code: result.code }),
      );
    });
  };
  return (
    <DialogButton
      primary
      label={t("open")}
      testId="audit-newexport"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={
        <SubmitButton
          form={BUNDLE_FORM}
          pending={pending}
          label={t("build")}
          pendingLabel={t("building")}
          fullWidth={false}
        />
      }
    >
      {(close) => (
        <form
          id={BUNDLE_FORM}
          onSubmit={(event) => {
            event.preventDefault();
            if (!pending) submit(close)();
          }}
          className="flex flex-col gap-3"
        >
          <label className={field}>
            <span className={label}>{t("scope")}</span>
            <select name="scope" className={control} defaultValue="org">
              <option value="org">{t("scopeOrg")}</option>
            </select>
          </label>
          <fieldset
            disabled
            aria-describedby={fieldsId}
            className="flex flex-col gap-3"
          >
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
            <p id={fieldsId} className="text-xs text-muted-foreground">
              {t("fieldsNotRecorded")}
            </p>
          </fieldset>
          <Callout>
            {t.rich("callout", {
              c: (chunks) => <span className={mono}>{chunks}</span>,
            })}
          </Callout>
          <Missing
            id={`${fieldsId}-bundle`}
            gap={gap}
            text={t("notRecorded")}
          />
          {failure === null ? null : (
            <FormAlert testId="audit-bundle-failure">{failure}</FormAlert>
          )}
        </form>
      )}
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
  const noteId = useId();
  return (
    <DialogButton
      label={t("title")}
      testId="audit-incident"
      title={t("title")}
      footer={<DisabledSubmit label={t("submit")} describedBy={noteId} />}
    >
      <fieldset
        disabled
        aria-describedby={noteId}
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
        <Missing id={noteId} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}

/** `rotatekek`: Rotate KEK. What a rotation does, and the write it waits on (a key registry). */
export function RotateDialog({ gap }: { gap: Gap }) {
  const t = useTranslations("audit.rotate");
  const keys = useTranslations("audit.keys");
  const recorded = useTranslations("audit");
  const noteId = useId();
  const fact = "text-muted-foreground";
  return (
    <DialogButton
      label={keys("rotate")}
      testId="audit-rotatekek"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={<DisabledSubmit label={t("submit")} describedBy={noteId} />}
    >
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[13px]">
        <dt className={fact}>{t("facts.generation")}</dt>
        <dd data-recorded="false" className={fact}>
          {recorded("notRecorded")}
        </dd>
        <dt className={fact}>{t("facts.effect")}</dt>
        <dd>{t("facts.effectValue")}</dd>
        <dt className={fact}>{t("facts.old")}</dt>
        <dd>{t("facts.oldValue")}</dd>
        <dt className={fact}>{t("facts.rewrap")}</dt>
        <dd>{t("facts.rewrapValue")}</dd>
        <dt className={fact}>{t("facts.receipts")}</dt>
        <dd>{t("facts.receiptsValue")}</dd>
        <dt className={fact}>{t("facts.recorded")}</dt>
        <dd>
          {t.rich("facts.recordedValue", {
            c: (chunks) => <span className={mono}>{chunks}</span>,
          })}
        </dd>
      </dl>
      <Missing id={noteId} gap={gap} text={t("notRecorded")} />
    </DialogButton>
  );
}

/**
 * `retention`: Edit policy. The body retention is the pinned policy's window
 * (get_evidence_retention), printed as recorded; the hot window has no store.
 * Both stay disabled until a write saves a policy.
 */
export function PolicyDialog({
  gap,
  body,
}: {
  gap: Gap;
  /** The body retention as the page words it, or null when no policy is pinned. */
  body: string | null;
}) {
  const t = useTranslations("audit.policy");
  const retention = useTranslations("audit.retention");
  const recorded = useTranslations("audit");
  const noteId = useId();
  return (
    <DialogButton
      label={retention("edit")}
      testId="audit-retention"
      title={t("title")}
      subtitle={t("subtitle")}
      footer={<DisabledSubmit label={t("submit")} describedBy={noteId} />}
    >
      <fieldset
        disabled
        aria-describedby={noteId}
        className="flex flex-col gap-3"
      >
        <label className={field}>
          <span className={label}>{t("body")}</span>
          <select className={control} defaultValue="recorded">
            <option value="recorded">{body ?? recorded("notRecorded")}</option>
          </select>
        </label>
        <label className={field}>
          <span className={label}>{t("hot")}</span>
          <select className={control} defaultValue="recorded">
            <option value="recorded">{recorded("notRecorded")}</option>
          </select>
        </label>
        <Callout>{t("callout")}</Callout>
        <Missing id={noteId} gap={gap} text={t("notRecorded")} />
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
  const noteId = useId();
  return (
    <DialogButton
      primary
      label={denied("request")}
      testId="audit-request-access"
      title={t("title")}
      footer={<DisabledSubmit label={t("submit")} describedBy={noteId} />}
    >
      <fieldset
        disabled
        aria-describedby={noteId}
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
        <Missing id={noteId} gap={gap} text={t("notRecorded")} />
      </fieldset>
    </DialogButton>
  );
}
