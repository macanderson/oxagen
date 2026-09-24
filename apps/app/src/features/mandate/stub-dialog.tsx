"use client";
// The two controls the design draws whose write Oxagen does not have yet:
// Request access (the design's `request-access`, from the denied state) and
// Open an incident (`incident`, from the error state).
//
// Each is a real button that opens the dialog the design draws, with the
// design's fields and its primary action. The primary action is drawn disabled
// beside the sentence that says why: no contract lets a person ask for a role
// (#3846), and none raises an incident from a page (#3847). A button that
// silently does nothing is worse than no button on a page about who may spend
// money, and a button that reported a write it did not make would be worse
// still. Fleet draws the same two dialogs the same way
// (`features/fleet/state-actions.tsx`); the lanes may not import each other.
import { useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Badge } from "@/ui/badge";
import { buttonPrimary, buttonSecondary, inputBase } from "@/ui/control-styles";
import { SheetDialog } from "@/ui/sheet-dialog";

// 16px on a phone, as the design's inputs are, so iOS does not zoom the sheet.
const field = `${inputBase} max-md:min-h-11 max-md:text-base`;

/** The sentence under a stub dialog's fields: what cannot be sent, and why. */
function Unbacked({
  id,
  gap,
  testId,
  children,
}: {
  id: string;
  gap: string;
  testId: string;
  children: string;
}) {
  return (
    <p
      id={id}
      data-state="not-backed"
      data-gap={gap}
      data-testid={testId}
      className="rounded-lg border border-border bg-hl px-3 py-2 text-xs text-muted-foreground"
    >
      {children}
    </p>
  );
}

/** The denied state's Request access: the role, a reason, and a send that no write backs. */
export function RequestAccessDialog({ permission }: { permission: string }) {
  const t = useTranslations("mandate.failure.requestAccess");
  const [open, setOpen] = useState(false);
  const roleId = useId();
  const whyId = useId();
  return (
    <>
      <button
        type="button"
        data-testid="request-access-open"
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
        testId="request-access"
        // The design's header close, with the footer's dismiss named Cancel
        // so the dialog carries no two controls called Close.
        headerClose
        closeLabel={t("cancel")}
        footer={
          <button
            type="button"
            disabled
            aria-describedby={`${roleId}-why`}
            className={buttonPrimary}
          >
            {t("send")}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <label htmlFor={roleId} className="text-xs font-medium">
            {t("role")}
          </label>
          <input
            id={roleId}
            readOnly
            value={permission}
            className={`${field} font-mono`}
          />
          <label htmlFor={whyId} className="text-xs font-medium">
            {t("why")}
          </label>
          <textarea id={whyId} rows={3} className={`${field} resize-y`} />
          <p className="text-xs text-muted-foreground">{t("note")}</p>
          <Unbacked
            id={`${roleId}-why`}
            gap="access-request"
            testId="request-access-unbacked"
          >
            {t("unbacked", { permission })}
          </Unbacked>
        </div>
      </SheetDialog>
    </>
  );
}

/** The error state's Open an incident: subject, severity, what it attaches, and a raise that no write backs. */
export function IncidentDialog({
  status,
  code,
  mandate,
  at,
}: {
  status: number;
  code: string;
  /** The mandate the route names, which the incident is about. */
  mandate: string;
  /** The instant the read failed, already formatted. */
  at: string;
}) {
  const t = useTranslations("mandate.failure.incident");
  const [open, setOpen] = useState(false);
  const subjectId = useId();
  const severityId = useId();
  const answer = `${String(status)} ${code}`;
  return (
    <>
      <button
        type="button"
        data-testid="open-incident-open"
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
        testId="open-incident"
        headerClose
        closeLabel={t("cancel")}
        footer={
          <button
            type="button"
            disabled
            aria-describedby={`${subjectId}-why`}
            className={buttonPrimary}
          >
            {t("raise")}
          </button>
        }
      >
        <div className="flex flex-col gap-3">
          <label htmlFor={subjectId} className="text-xs font-medium">
            {t("subject")}
          </label>
          <input id={subjectId} defaultValue={answer} className={field} />
          <label htmlFor={severityId} className="text-xs font-medium">
            {t("severity")}
          </label>
          <select id={severityId} defaultValue="warning" className={field}>
            {(["critical", "warning", "info"] as const).map((severity) => (
              <option key={severity} value={severity}>
                {t(`severities.${severity}`)}
              </option>
            ))}
          </select>
          {/* The design attaches the records the incident is about. A failed
              read has the mandate the route names, the answer and the instant;
              it has no connection or exception id of its own. */}
          <span id={`${subjectId}-attach`} className="text-xs font-medium">
            {t("attach")}
          </span>
          <ul
            aria-labelledby={`${subjectId}-attach`}
            data-testid="incident-attach"
            className="flex flex-wrap gap-1.5"
          >
            {[mandate, answer, at].map((item) => (
              <li key={item}>
                {/* Not the mono badge: it lowercases, and the instant ends in Z. */}
                <Badge tone="quiet" dot={false}>
                  <span className="font-mono text-[11px]">{item}</span>
                </Badge>
              </li>
            ))}
          </ul>
          <Unbacked
            id={`${subjectId}-why`}
            gap="incident-write"
            testId="incident-unbacked"
          >
            {t("unbacked", { status: String(status), code, at })}
          </Unbacked>
        </div>
      </SheetDialog>
    </>
  );
}
